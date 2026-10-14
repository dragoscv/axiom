# AXIOM .axm for VS Code

Language support for **`.axm` plans** — the authoring format of [AXIOM](https://dragoscv.github.io/axiom/),
the transactional write gate for coding agents. A plan describes a change set (files, sources,
checks); AXIOM compiles it into a content-addressed manifest, runs set-level checks and applies it
atomically with a journal and one-step rollback.

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

## Features

- **Diagnostics** as you type — the same parser and error codes (`ERR_*`) as `axiom compile`
- **Completion** for keywords, predicate ids after `using`, capabilities, `mode` / `op` / `profile` values
- **Hover** documentation for keywords and predicates
- **Outline** (document symbols) for plans, files and checks
- **Format Document** — idempotent, only on a clean parse
- **Semantic highlighting** on top of a TextMate grammar (heredocs, digests, embedded JSON in `check` / `meta` blocks)

The language server (`@codai/axiom-axm-lsp`) is bundled — nothing else to install. In a workspace
that has `@codai/axiom-axm-lsp` in `node_modules`, the extension uses that version instead.

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
pnpm build                              # builds @codai/axiom-axm-lsp
pnpm --filter axiom-axm run build       # this package
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
