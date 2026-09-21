# Install

*Every way to get `axiom` onto a machine or into a workflow, which one to pick, and how to verify what you downloaded.*

AXIOM ships as **one npm package**, `@codai/axiom-mcp`, whose `axiom` bin is the MCP server, the
CLI, the `gate --stdin` hook and the engine the GitHub Action installs. The other eight
`@codai/axiom-*` packages are libraries you only need when embedding the engines in your own code
([codai](../integration/codai.md) does). Node ≥ 22.14 is required for every channel except the
standalone binaries.

| You want to… | Use | Command |
|---|---|---|
| Try it, or run a long-lived MCP server from an editor | `npx` | `npx -y @codai/axiom-mcp mcp --root .` |
| Run the CLI or a **PreToolUse hook** | global bin | `npm i -g @codai/axiom-mcp` → `axiom --version` |
| Run without Node installed (CI images, locked-down hosts) | standalone binary (from 2.2.1) | `curl -fsSL https://dragoscv.github.io/axiom/install.sh \| sh` · `irm https://dragoscv.github.io/axiom/install.ps1 \| iex` |
| Edit `.axm` files with diagnostics and completion | VS Code extension | `axiom-axm-<version>.vsix` from the [GitHub release](https://github.com/dragoscv/axiom/releases) |
| Fail a PR whose tree does not match a manifest | GitHub Action | `uses: dragoscv/axiom/action@v2` |
| Let a registry-aware MCP client discover it | MCP Registry | `io.github.dragoscv/axiom` |

## `npx` — run without installing

```sh
npx -y @codai/axiom-mcp --version
npx -y @codai/axiom-mcp mcp --root /abs/path/to/repo
```

Fine for an MCP server that starts once and lives for the editor session. The `-y` skips the
install prompt so the harness never blocks on it.

> [!WARNING]
> Do **not** put `npx -y @codai/axiom-mcp` in a hook. Measured on Windows with a warm cache,
> `npx` resolution alone is p50 7.8 s / max 15 s; every harness kills a hook at its timeout
> (5 s is typical) and then **fails open**, so an `npx` gate is a gate that never runs. Use the
> global bin (p50 157 ms).

## Global bin — required for hooks and comfortable for the CLI

```sh
npm install -g @codai/axiom-mcp        # or: pnpm add -g @codai/axiom-mcp
axiom --version
axiom --help
```

The package has **no runtime dependencies**; the engines are bundled into `dist/cli-main.js` and
lazy chunks, so the install is a single tarball. Upgrade with the same command; the version is in
the first line of `axiom --help`.

Per-OS notes:

- **Windows** — `npm i -g` puts `axiom.cmd` on `PATH` for cmd/pwsh; the hook config uses
  `"exec": "axiom"` and it resolves. Paths in `--root` may use either slash; the server
  realpaths them (drive letter case and 8.3 names normalise). Directory `fsync` is a no-op and
  `0755` is recorded, not applied — see [apply.md](../guides/apply.md#windows-notes).
- **macOS** — with Homebrew node, the global bin lands in `/opt/homebrew/bin`; make sure that is
  on the `PATH` the harness spawns hooks with (GUI apps do not read your shell rc).
- **Linux** — with a version manager (`nvm`, `fnm`, `volta`) the bin is under that manager's
  prefix; hooks launched by an editor may not source it. Symlink `axiom` into `/usr/local/bin`
  or point the hook at the absolute path.

## Standalone binary — no Node (from 2.2.1)

Single-file executables built with Node's own `--build-sea` on native runners for
`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64` and `win-x64` (decision D-27). They run
the exact V8/Node the test suite and golden digests exercise.

```sh
# Linux / macOS
curl -fsSL https://dragoscv.github.io/axiom/install.sh | sh
axiom --version

# Windows (PowerShell)
irm https://dragoscv.github.io/axiom/install.ps1 | iex
axiom --version
```

The scripts download the asset for your OS/arch from the latest GitHub release, check it against
`SHA256SUMS`, and place `axiom` in `~/.local/bin` (Unix) or `%LOCALAPPDATA%\axiom\bin` (Windows),
printing the `PATH` line to add if needed. To pin a version, download the asset from the release
page by hand.

> [!NOTE]
> The binary is the *no-Node-installed* convenience path. The PreToolUse latency budget is
> measured on `node cli.js`; the `expr.cedar` predicate is not embedded (a missing module inside
> a SEA fails **closed**, as everywhere else).

## VS Code extension — `.axm` language support

Download `axiom-axm-<version>.vsix` from the [GitHub release](https://github.com/dragoscv/axiom/releases)
that matches your `@codai/axiom-mcp` version, then:

```sh
code --install-extension axiom-axm-<version>.vsix
```

or *Extensions → ⋯ → Install from VSIX…*. The extension bundles the language server; nothing else
to install. Once the Marketplace publisher `codai` is live, `ext install codai.axiom-axm` works
too. Features and the `mcp.json` that pairs with it: [integration/vscode.md](../integration/vscode.md).

## GitHub Action

```yaml
- uses: dragoscv/axiom/action@v2
  with:
    bundle: .axiom/manifests/<hex>.json
    root: .
```

The composite action installs `@codai/axiom-mcp@<version>` (input `version`, default `2`) with
`npm i -g` on the runner and runs `axiom verify --tree`. `@v2` is a moving tag force-updated on
every `v2.*` release (D-31); pin a full tag or SHA if you prefer. Inputs, outputs and the
attestation flow: [integration/github-action.md](../integration/github-action.md).

## MCP Registry

The server is listed as `io.github.dragoscv/axiom` (`server.json`, published by `release.yml`
after the npm publish is visible — D-29). A client that resolves registry names will run
`npx -y @codai/axiom-mcp mcp` for you; you still pass `--root` — there is no `cwd` fallback.

## Verifying what you download

| Artifact | Provenance | How to check |
|---|---|---|
| npm tarballs (all nine packages) | npm provenance via trusted publishing (OIDC) | `npm view @codai/axiom-mcp --json \| jq .dist.attestations` — or the *Provenance* panel on npmjs.com |
| Standalone binaries | `SHA256SUMS` + Sigstore build provenance (`actions/attest-build-provenance`) | `sha256sum -c SHA256SUMS --ignore-missing` · `gh attestation verify axiom-linux-x64 --repo dragoscv/axiom` |
| `.vsix` | attached to the same GitHub release | compare against `SHA256SUMS` |
| The action | git tag / SHA | pin `@v2.2.1` or a commit SHA instead of `@v2` |

The full recipe, and what to do if something does not verify, is in
[SECURITY.md](../../SECURITY.md#verifying-what-you-download).

## Next

[Quickstart](quickstart.md) — a first Plan compiled, checked and applied in a scratch repo.

---

**See also**

- [Quickstart](quickstart.md) — the 60-second flow
- [Hooks](hooks.md) — wiring the global bin as a PreToolUse hook
- [Harnesses](../integration/harnesses.md) — `mcp.json` / settings snippets per client
- [Versioning](../reference/versioning.md) — what a version bump can and cannot change
