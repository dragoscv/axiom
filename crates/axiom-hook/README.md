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
   wrong protocol, or a non-loopback `host` → skip to step 4.
3. `POST /v1/gate?a=<arg>&a=<arg>…` to `host:port` (300 ms connect, 1.5 s total I/O —
   `AXIOM_HOOK_IO_TIMEOUT_MS` overrides it, 100..30000), with
   `x-axiom-protocol: 1`, `x-axiom-cwd`, `x-axiom-stdin`, and `authorization: Bearer <token>`
   when the state file has a token. No `x-axiom-version`: this client is version-agnostic.
   `200` with a valid `x-axiom-exit` → stdout = body, stderr = decoded `x-axiom-stderr`,
   exit = `x-axiom-exit`. Anything else is "no verdict". A connection reset *after* a response
   that is complete by its own framing (Content-Length met, or chunked terminator) still counts
   — Windows resets a closed socket that had unread bytes instead of sending EOF.
4. Fallback: run the installed `axiom gate <same args>` with the bytes already read. Found
   without a shell: `AXIOM_HOOK_FALLBACK` (an `axiom` executable or a `cli.js`, run with node),
   else `axiom.exe` / `axiom` on `PATH`, else (Windows) an npm/pnpm `axiom.cmd` shim, whose
   `node_modules\@codai\axiom-mcp\dist\cli.js` (or `global\5\…` for pnpm) runs under `node.exe`.
5. Nothing could decide → **fail closed** in the `--format` harness shape, with the stderr line
   `AXIOM GATE DENY ERR_INTERNAL: gate daemon unreachable and no axiom CLI found (fail-closed)`.
   `--fail-open` does not change this: it relaxes the gate's judgement of a payload, not the
   absence of any gate.

The wire protocol lives in `packages/mcp/src/daemon-proto.ts`; change both together.

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
