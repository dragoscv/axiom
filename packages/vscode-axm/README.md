# AXIOM — agent write gate + .axm

[AXIOM](https://dragoscv.github.io/axiom/) is the transactional write gate for coding agents:
every agent write is checked before it lands, applied atomically with a journal, and undone in
one step. This extension shows the gate state of your workspace, runs the AXIOM commands, and
gives you full language support for **`.axm` plans**.

<!-- screenshots -->

## Features

### Gate status in the status bar

- **`AXIOM ok` / `AXIOM warn` / `AXIOM fail`** for the open workspace, from `axiom setup doctor --json`
  (falls back to `axiom doctor --json` on 2.x). Refreshed on startup, every 10 minutes and on demand;
  the tooltip lists the failing and warning check ids; warning / error theme colours.
- Click it to open the full doctor report.

### Commands (Command Palette → "AXIOM")

| Command | Runs |
|---|---|
| **AXIOM: Doctor** | `axiom setup doctor --json` → report in the "AXIOM" output channel |
| **AXIOM: Init** | `axiom init --root <workspace>` after a confirmation dialog |
| **AXIOM: Stats** | `axiom stats --json` → output channel |
| **AXIOM: Explain last decision** | `axiom explain last --root <workspace>` (needs axiom ≥ 3.0) |
| **AXIOM: Refresh gate status** | re-runs the doctor for the status bar |

### `.axm` language support

- **Diagnostics** as you type — the same parser and error codes (`ERR_*`) as `axiom compile`
- **Completion** for keywords, predicate ids after `using`, capabilities, `mode` / `op` / `profile` values
- **Hover** documentation for keywords and predicates
- **Outline** (document symbols) for plans, files and checks
- **Format Document** — idempotent, only on a clean parse
- **Semantic highlighting** on top of a TextMate grammar (heredocs, digests, `patch` sources, embedded JSON in `check` / `meta` blocks)

```axm
axiom "2"

plan add-readme {
  intent "Add a README, guarded by a secret scan"
  profile default

  artifact "README.md" {
    op create
    inline <<MD
# hello
MD
  }

  check no-secrets using content.noSecrets {}
}
```

The language server (`@codai/axiom-axm/lsp`) is bundled — nothing else to install. In a **trusted**
workspace that has `@codai/axiom-axm` ≥ the bundled version in `node_modules`, that copy is used.

## Settings and trust

- `axiom.path` (default `axiom`) — the CLI to run. On Windows `axiom.exe` and the npm `axiom.cmd`
  shim are found on PATH; the shim is run as `node <cli.js>`. Every call is `execFile` with an
  argument array — never a shell.
- **Untrusted workspaces** (limited support): nothing is spawned (no doctor / init / stats /
  explain), `axiom.path` from the workspace is ignored, and only the bundled language server runs.

## Use it with the gate

Install the CLI and wire your repository in one step:

```sh
npm install -g @codai/axiom-mcp
axiom init      # MCP server + PreToolUse hook for Copilot / Claude / Codex / Cursor / Windsurf / Gemini / Junie / Cline
axiom doctor    # checks the wiring and the gate latency
axiom compile plan.axm -o bundle.json && axiom apply bundle.json --root . --confirm <digest>
```

Agents can then write through the `axiom_write` MCP tool (preview → apply with `confirmDigest`) and
every direct write is checked by the gate first.

## Links

- Documentation: <https://dragoscv.github.io/axiom/>
- `.axm` syntax: <https://dragoscv.github.io/axiom/reference/axm-syntax/>
- VS Code integration (MCP + hooks): <https://dragoscv.github.io/axiom/integration/vscode/>
- Source and issues: <https://github.com/dragoscv/axiom>

MIT licensed.

---

## Development

```sh
pnpm build                              # builds @codai/axiom-axm (parser + LSP)
pnpm --filter axiom-axm run build       # this package
pnpm --filter axiom-axm run test        # status-bar mapping, CLI resolution, grammar coverage
pnpm --filter axiom-axm run package     # → <repo>/.copilot-tmp/axiom-axm-<version>.vsix
```

The .vsix carries no `node_modules`: `dist/extension.cjs` (client) and `dist/server.cjs` (the LSP,
bundled with `vscode-languageserver`) are self-contained. vsce rejects pnpm's `catalog:` spec, so
the package script writes the resolved `@types/vscode` version (and the release version from
`@codai/axiom-mcp`) into `package.json` for the duration of the call and restores it.

**Release (S-412, S-601).** `release.yml` job `vscode-extension` runs on every `v*` tag: it
packages the .vsix, attaches it to the GitHub release and publishes `dragoscv.axiom-axm` to the
VS Code Marketplace with the Entra managed identity `codai-marketplace-publisher` (GitHub OIDC,
environment `marketplace-publish`, `vsce --azure-credential`) — the same publisher and credential
as `dragoscv.codai-vscode`; `VSCE_PAT` is only a fallback. When the repo secret `OVSX_PAT` exists
the same .vsix goes to Open VSX under the namespace `dragoscv`.
