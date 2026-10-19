# axiom-hook

Native thin client for the AXIOM resident gate daemon (`axiom serve --hook`, D-36 / S-901).

Harness hooks start one process per tool call. Starting Node costs 60–100 ms on a loaded
Windows box; a native exe costs about half of that. `axiom-hook` is that native exe: it relays
the hook payload to the already-running daemon over loopback HTTP and prints the daemon's
verdict, so the gate itself never pays a Node start-up.

```text
axiom-hook --version
axiom-hook gate --stdin [--format auto|claude|copilot|vscode|codex|cursor|windsurf|gemini|junie|cline]
                [--deny-exit 0|2] [--root <dir>] [--profile <file>] [--fail-open] [...]
```

`gate` takes exactly the flags of `axiom gate`; they are forwarded verbatim. Anything else
prints usage on stderr and exits 2.

## Flow

1. Read stdin: at most 4 MiB, give up after 2 s (`x-axiom-stdin: ok|timeout|toolarge`).
2. Read `~/.axiom/daemon.json` (`USERPROFILE` on Windows, `HOME` elsewhere). Absent, malformed,
   not protocol 2, no 64-hex `key`, a non-loopback `host`, or (POSIX) a file group/other can
   access → skip to step 4.
3. `POST /v1/gate?a=<arg>&a=<arg>…` to `host:port` (300 ms connect, 1.5 s total I/O —
   `AXIOM_HOOK_IO_TIMEOUT_MS` overrides it, 100..30000), with `x-axiom-protocol: 2`, a fresh
   `x-axiom-nonce`, `x-axiom-cwd`, `x-axiom-stdin`. No bearer token and no `x-axiom-version`
   (this client is version-agnostic). The daemon accepts only `--stdin --format --deny-exit
   --log-level --fail-open --post --track-reads --no-shell-scan` over the wire (400 otherwise;
   root and profile are the daemon's). A verdict counts only when all hold: status `200`,
   `x-axiom-exit` is `0`, `1` or `2`, the body is framed (Content-Length met, or chunked
   terminator — a close-delimited body is refused because a cut connection looks the same), and
   `x-axiom-mac == hex(HMAC-SHA256(key, nonce "\n" exit "\n" sha256hex(body)))`. Then stdout =
   body, stderr = decoded `x-axiom-stderr`, exit = `x-axiom-exit`. A connection reset *after* a
   framed response still counts — Windows resets a closed socket that had unread bytes. A bad or
   missing MAC prints `AXIOM GATE WARN ERR_DAEMON_AUTH` and falls back; with
   `AXIOM_GATE_DAEMON_STRICT=1` it denies at once (`AXIOM GATE DENY ERR_DAEMON_AUTH`).
4. Fallback: run the installed `axiom gate <same args>` with the bytes already read. Found
   without a shell: `AXIOM_HOOK_FALLBACK` (an `axiom` executable or a `cli.js`, run with node),
   else `axiom.exe` / `axiom` on `PATH`, else (Windows) an npm/pnpm `axiom.cmd` shim, whose
   `node_modules\@codai\axiom-mcp\dist\cli.js` (or `global\5\…` for pnpm) runs under `node.exe`.
   The child has a deadline (`AXIOM_HOOK_FALLBACK_TIMEOUT_MS`, default 10 000, 100..600000);
   on expiry it is killed and step 5 applies.
5. Nothing could decide → **fail closed** in the `--format` harness shape, with the stderr line
   `AXIOM GATE DENY ERR_INTERNAL: gate daemon unreachable and no axiom CLI found (fail-closed)`.
   `--fail-open` does not change this: it relaxes the gate's judgement of a payload, not the
   absence of any gate.

The wire protocol lives in `packages/mcp/src/daemon-proto.ts`; change both together.

## Threat model (protocol 2)

- **Port squatting / forged daemon.json.** Any local process can bind a loopback port or
  rewrite `~/.axiom/daemon.json`. It cannot produce a valid `x-axiom-mac` without the per-start
  key, so its answers are never verdicts (fallback, or deny under strict mode). Before protocol
  2 a squatter answering `x-axiom-exit: 0` allowed every write.
- **Key secrecy.** The daemon writes daemon.json fresh with mode 0600 and, on Windows, runs
  `icacls <file> /inheritance:r /grant:r <user>:F` (a failure is a warning). On POSIX this
  client refuses a file group/other can access. A process running as the same user can read
  the key — same-user isolation is out of scope (it could edit the harness hook config anyway).
- **Stale daemon.json.** std has no portable process-liveness probe, so this client does not
  check `pid`; a stale file costs a refused connect (or an unauthenticated answer from whoever
  owns the port now), then the fallback. The node client checks `pid` and deletes the stale file.
- **No token on the wire.** The bearer token is never sent: a squatter learns nothing it could
  replay. The nonce makes a recorded answer useless for any other request.
- **Hung fallback.** The spawned `axiom gate` is killed at its deadline and the call fails closed.

## Build, test, measure

```powershell
cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test
cargo build --release          # target/release/axiom-hook(.exe)
node bench/bench.mjs 30        # p50 of --version and a mock-daemon round-trip (not shipped)
```

std only, no crates. The version in `Cargo.toml` is kept equal to `@codai/axiom-mcp`.

## Distribution

`release.yml` builds it on the same five native runners as the SEA binary and attaches
`axiom-hook-<target>[.exe]` (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
`win-x64.exe`) to the GitHub release, listed in `SHA256SUMS` and covered by the Sigstore
attestation. `install.sh`, `install.ps1` and the Homebrew formula install it next to `axiom`.
