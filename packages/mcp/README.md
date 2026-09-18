# @codai/axiom-mcp

MCP server (stdio) and CLI for AXIOM v2 — the transactional write gate for coding agents:
`Plan` → canonical `ManifestBundle` → set-level checks → hash-gated two-phase `apply` → journal.
`dist/cli.js` (thin entry) + `dist/cli-main.js` (lazy-loaded engines, SDK and zod bundled in); no runtime dependencies.

## Install & run

```sh
npx @codai/axiom-mcp mcp --root /abs/path/to/repo          # stdio MCP server
npx @codai/axiom-mcp --help                                # CLI verbs
```

`--root` may repeat. Every tool `root` argument must equal or lie inside one of them; with exactly one
root it is the default. There is **no** env-var or `cwd` fallback (`ERR_ROOT_REQUIRED` / `ERR_ROOT_NOT_ALLOWED`).

### VS Code — `.vscode/mcp.json`

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

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "axiom": { "command": "npx", "args": ["-y", "@codai/axiom-mcp", "mcp", "--root", "/abs/path/to/repo"] }
  }
}
```

## Tools

| tool | risk | input | output |
|---|---|---|---|
| `axiom_plan_validate` | READ | `{ plan }` | `{ ok, planDigest?, errors[] }` |
| `axiom_plan_compile` | READ | `{ plan, store?: inline\|cas, root? }` | `ManifestBundle` (stored under `<root>/.axiom/manifests/` when a root is given) |
| `axiom_manifest_verify` | READ | `{ bundle }` | `{ ok, manifestDigest, canonical, signed, missing[], errors[] }` |
| `axiom_check` | READ | `{ bundle, profile?, root? }` | `CheckReport` (`verdict: pass\|fail\|error`) |
| `axiom_apply_dry_run` | READ | `{ bundle, root, profile? }` | `ApplyResult{mode:"dry-run", diff}` |
| `axiom_apply` | SENSITIVE | `{ bundle, root, profile?, confirmDigest }` | `ApplyResult` |
| `axiom_rollback` | SENSITIVE | `{ root, manifestDigest }` | `{ status:"rolled-back", phase, steps }` |
| `axiom_manifest_diff` | READ | `{ a: bundle\|"sha256:…", b }` | `{ added[], removed[], changed[] }` |
| `axiom_roots_list` | READ | `{}` | `{ roots: [{ path, writable, hasGit }] }` |

Every tool carries MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
and an `outputSchema`; `structuredContent` is the full result, `content[0].text` a small summary (digest,
verdict, counts, first 20 findings). Errors come back as `isError: true` with `{ code, message, path? }`
from the closed `ERROR_CODES` enum — a handler never throws. `spec/tools.json` is generated from the same
registry (`pnpm build:spec`) and guarded by a parity test.

Resources: `axiom://manifest/{sha}`, `axiom://report/{sha}`, `axiom://applied/{sha}`,
`axiom://profile/{name}`, `axiom://schema/{Plan|Manifest|ManifestBundle|CheckReport|ApplyResult|Profile|Journal}`.

## Trust model

- Roots are realpath'd at startup, must be directories, and the set is frozen. Requested roots are
  realpath'd too (case-insensitive containment on Windows); anything outside is a hard error.
- `axiom_apply` requires `confirmDigest === bundle.manifestDigest` — echo the digest you saw in dry-run.
  Pre-apply checks run against the profile (default `default`, or `<root>/.axiom/profiles/<name>.json`);
  a non-`pass` verdict aborts with `ERR_CHECKS_FAILED` before any write.
- Payloads over 4 MiB are rejected up front (`ERR_BUNDLE_TOO_LARGE`).
- `.axiom/lock` makes apply single-writer per root; the journal makes it crash-safe and reversible.
- stdout carries only JSON-RPC. Logs are JSON lines on stderr (`--log-level error|warn|info|debug`, default `warn`).

## CLI

```
axiom compile <plan.json> [-o out.json] [--store cas --root .]
axiom verify  <bundle.json>
axiom check   <bundle.json> --root . [--profile p] [--json]
axiom apply   <bundle.json> --root . [--dry-run] [--profile p] [--confirm <digest>]
axiom rollback <digest> --root .
axiom diff    <a.json> <b.json>
axiom schema  <Plan|Manifest|ManifestBundle|CheckReport|ApplyResult|Profile|Journal>
```

Exit codes: `0` ok · `1` verdict fail / apply failed · `2` usage or error. Non-`mcp` verbs print JSON to stdout.
