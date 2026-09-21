# VS Code

*The `.axm` extension (`codai.axiom-axm`) and language server, how to install the `.vsix`, and the `mcp.json` / hook that make Copilot in VS Code go through the gate.*

Three separate pieces meet in VS Code, and you can adopt them independently:

| Piece | What it gives you | How |
|---|---|---|
| **`.axm` extension** | syntax colouring, diagnostics, completion, hover, outline, *Format Document*, semantic tokens for `.axm` plans | install the `.vsix` |
| **MCP server** | Copilot agent mode can call the 17 `axiom_*` tools against your workspace | `.vscode/mcp.json` |
| **PreToolUse hook** | every raw write Copilot makes through its own tools is gated | `.github/hooks/axiom-gate.json` |

```mermaid
flowchart LR
  subgraph vscode [VS Code]
    ED[.axm editor] --> EXT[codai.axiom-axm<br/>vscode-languageclient]
    CP[Copilot agent] -->|tools/call| MCPC[MCP client]
    CP -->|PreToolUse| HK[axiom gate --stdin]
  end
  EXT -->|node-ipc| LSP[@codai/axiom-axm-lsp<br/>parseAxm · formatAxm]
  MCPC -->|stdio| SRV[axiom mcp --root workspace]
  LSP --- AXM[@codai/axiom-axm]
  SRV --- AXM
```

## The extension

`packages/vscode-axm` — language id `axm`, file extension `.axm`, VS Code ≥ 1.138. It is a thin
`vscode-languageclient` that spawns `@codai/axiom-axm-lsp` over node-ipc; both the client and the
server are bundled into the `.vsix` (no `node_modules`, ~310 KB). A TextMate grammar colours the
file before the server answers — heredoc bodies and `check … {json}` / `meta {json}` as embedded
JSON — then semantic tokens refine it. `[axm]` defaults: semantic highlighting on, 2-space indent.

| Capability | What you get |
|---|---|
| diagnostics | the same `ERR_*`-coded errors `axiom compile` reports, at the offending range (`source: axm`); the editor and the gate share one parser, so they can never disagree (D-14) |
| completion | predicate ids after `using`, capability names inside `capabilities [ ]`, `mode`/`op`/`profile` values, keyword snippets valid at the current nesting level; triggers on space, `.`, `[` |
| hover | keyword docs; predicate docs on `using group.name` |
| document symbols | plan → artifacts + checks (outline, breadcrumbs) |
| formatting | canonical form (`formatAxm`) — applied only when the file parses without diagnostics |
| semantic tokens | `keyword`, `string`, `number`, `comment`, `property` (full document) |

### Install

Download `axiom-axm-<version>.vsix` from the [GitHub release](https://github.com/dragoscv/axiom/releases)
matching your `@codai/axiom-mcp` version (the `.vsix` version is stamped from it at package time),
then either:

```sh
code --install-extension axiom-axm-<version>.vsix
```

or *Extensions view → ⋯ → Install from VSIX…*. Reload, open a `.axm` file, and the status bar
shows the language as *AXIOM plan*. Once the Marketplace publisher `codai` is live (S-412),
`ext install codai.axiom-axm` works without the download.

Other editors: the language server is a plain LSP 3.18 binary —
`npx @codai/axiom-axm-lsp --stdio` for neovim, helix, zed, emacs
([axm-syntax.md § Editor support](../reference/axm-syntax.md#editor-support)).

### Develop it

```sh
pnpm build                              # builds @codai/axiom-axm-lsp
pnpm --filter axiom-axm run build       # the extension (not matched by the @codai/axiom-* filter)
code --extensionDevelopmentPath=packages/vscode-axm   # or F5 "Run Extension"
pnpm --filter axiom-axm run package     # → .copilot-tmp/axiom-axm-<version>.vsix
```

Details and the vsce/pnpm quirks: [`packages/vscode-axm/README.md`](../../packages/vscode-axm/README.md),
[`packages/axm-lsp/README.md`](../../packages/axm-lsp/README.md).

## The MCP server — `.vscode/mcp.json`

```json
{
  "servers": {
    "axiom": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@codai/axiom-mcp", "mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

`${workspaceFolder}` becomes the single allowlisted root; add more `--root` pairs for a multi-root
workspace. `npx` is fine here — the server starts once per session. In agent mode Copilot then
sees `axiom_plan_compile`, `axiom_check`, `axiom_apply_dry_run`, `axiom_apply` and the rest
([mcp-tools.md](../reference/mcp-tools.md)); `axiom_apply` carries `destructiveHint: true`, so
VS Code asks before running it unless you auto-approve it in `chat.tools.global.autoApprove`.

For a long-lived shared server use the HTTP transport instead:

```json
{ "servers": { "axiom": { "type": "http", "url": "http://127.0.0.1:3411/mcp" } } }
```

started with `axiom mcp --root /abs/repo --http 127.0.0.1:3411`. Add
`"headers": { "Authorization": "Bearer ${input:axiom-token}" }` when the server has a token
(required for any non-loopback bind).

> [!TIP]
> To make an agent *prefer* the gate over raw file tools, add a short instruction to
> `.github/copilot-instructions.md` — metu's is a skill that says "never raw multi-file writes when
> AXIOM is available; Plan → compile → check → dry-run → apply with `confirmDigest`"
> ([integration/metu.md](metu.md)).

## The hook — `.github/hooks/axiom-gate.json`

VS Code agent hooks (Preview) load `.github/hooks/*.json` from the workspace and
`.claude/settings.json`, plus the user-level `~/.copilot/hooks` and `~/.claude/settings.json`.
Install the global bin first (`npm i -g @codai/axiom-mcp` — never `npx` in a hook), then:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "type": "command", "exec": "axiom", "args": ["gate", "--stdin"], "timeoutSec": 5 }
    ]
  }
}
```

VS Code sends `tool_name` / `tool_input` in snake_case where the Copilot CLI sends camelCase; the
gate reads both. Sub-agents started in `apps/web` still resolve the repository root because the
gate walks up from `cwd` to the nearest `.git` ([hooks.md § Root discovery](../getting-started/hooks.md#root-discovery)).
The gate profile lives at `<root>/.axiom/gate-profile.json`. Full contract and the other
harnesses: [hooks.md](../getting-started/hooks.md), [harnesses.md](harnesses.md).

## Putting it together

A workspace that has all three:

```
.vscode/mcp.json                 → axiom mcp --root ${workspaceFolder}
.github/hooks/axiom-gate.json    → axiom gate --stdin (global bin)
.axiom/profiles/<repo>.json      → the check profile agents compile against
.axiom/gate-profile.json         → deny .git/**, .axiom/**, lockfiles, .env*, …
.gitignore                       → .axiom/*  !.axiom/profiles/  !.axiom/gate-profile.json
plans/*.axm                      → edited with the extension, compiled by axiom compile
```

---

**See also**

- [`.axm` syntax](../reference/axm-syntax.md) — what the extension understands
- [Harnesses](harnesses.md) — Claude Code, Copilot CLI and Codex equivalents of the config above
- [Hooks](../getting-started/hooks.md) — the PreToolUse contract in depth
- [Install](../getting-started/install.md#vs-code-extension--axm-language-support) — the `.vsix` among the other channels
