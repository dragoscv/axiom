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
| `axiom_plan_compile` | ACT | `{ plan, store?: inline\|cas, root? }` | `ManifestBundle` (writes only under `<root>/.axiom/` — CAS blobs and the stored manifest — when a root is given) |
| `axiom_manifest_verify` | READ | `{ bundle }` | `{ ok, manifestDigest, canonical, signed, missing[], errors[] }` |
| `axiom_check` | READ | `{ bundle, profile?, root? }` | `CheckReport` (`verdict: pass\|fail\|error`) |
| `axiom_apply_dry_run` | READ | `{ bundle, root, profile? }` | `ApplyResult{mode:"dry-run", diff}` |
| `axiom_apply` | SENSITIVE | `{ bundle, root, profile?, confirmDigest }` | `ApplyResult` |
| `axiom_rollback` | SENSITIVE | `{ root, manifestDigest }` | `{ status:"rolled-back", phase, steps }` |
| `axiom_manifest_diff` | READ | `{ a: bundle\|"sha256:…", b }` | `{ added[], removed[], changed[] }` |
| `axiom_axm_parse` | READ | `{ source }` (`.axm` text) | `{ plan?, diagnostics: [{ severity, code, message, range: { start: {line, column}, end } }] }` |
| `axiom_roots_list` | READ | `{}` | `{ roots: [{ path, writable, hasGit }] }` |

Every tool carries MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
and an `outputSchema`; `structuredContent` is the full result, `content[0].text` a small summary (digest,
verdict, counts, first 20 findings). Errors come back as `isError: true` with `{ code, message, path? }`
from the closed `ERROR_CODES` enum — a handler never throws. `spec/tools.json` is generated from the same
registry (`pnpm build:spec`) and guarded by a parity test. `spec/codai-tools.json` is the same registry in
codai's `packages/agent-core/spec/tools-v2.json` entry shape (`{ name, risk, description, parameters }`) —
see `docs/integration/codai.md`.

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
- External guards (`guard.external`) are **off** unless the process is started with `--allow-guards`
  *and* the profile sets `facts.allowGuards: true`. Relative commands must live under `<root>/scripts/`;
  absolute ones must be listed exactly via `--guard-allowlist <abs>` (repeatable). Guards are spawned
  with an args array (never a shell), a scrubbed environment, a wall-clock timeout, and must print
  `GuardOutput` JSON — see `docs/checks.md`.

## CLI

```
axiom mcp     [--root <abs>]... [--allow-guards] [--guard-allowlist <abs>]... [--log-level warn]
axiom compile <plan.json> [-o out.json] [--store cas --root .]
axiom verify  <bundle.json>
axiom check   <bundle.json> --root . [--profile p] [--json] [--allow-guards] [--guard-allowlist <abs>]...
axiom apply   <bundle.json> --root . [--dry-run] [--profile p] [--confirm <digest>] [--allow-guards] [--guard-allowlist <abs>]...
axiom rollback <digest> --root .
axiom diff    <a.json> <b.json>
axiom schema  <Plan|Manifest|ManifestBundle|CheckReport|ApplyResult|Profile|Journal>
axiom gate    --stdin [--root <dir>] [--profile <file>] [--strict] [--log-level warn]
```

Exit codes: `0` ok · `1` verdict fail / apply failed · `2` usage or error. Non-`mcp` verbs print JSON to stdout.

## Hook mode — `axiom gate --stdin`

A PreToolUse hook for Claude Code, Copilot CLI and VS Code agent hooks. It reads **one** harness
payload from stdin (both `{tool_name, tool_input, cwd}` and `{toolName, toolArgs, cwd}` casings;
`toolArgs` may be a JSON string), extracts the write target(s) of `Write|Edit|MultiEdit|NotebookEdit`,
`create_file|replace_string_in_file|insert_edit_into_file|apply_patch|multi_replace_string_in_file|edit_notebook_file`
and generic `write|edit`, and runs **only** the fast predicates: containment + `RelPath` rules
(`..`, `CON`, NTFS ADS → `ERR_CONTAINMENT` / `ERR_PATH_*`), `path.deny`, `path.allow`,
`content.noSecrets` and `content.maxBytes` on the new content when the payload carries it.

| outcome | exit | stdout | stderr |
|---|---|---|---|
| allow / unknown tool | `0` | — | — |
| deny | `2` | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` | `AXIOM GATE DENY <code>: <reason> (<relpath>)` |
| malformed payload, stdin timeout (2 s), internal error | `0` (**fail open**) | — | `AXIOM GATE WARN: …` |
| same, with `--strict` | `2` | deny JSON | `AXIOM GATE DENY ERR_INTERNAL: …` |

Root = payload `cwd`, else `--root`, else the process cwd (the hook is the one place where cwd is
acceptable: the harness spawns the hook in the project directory and owns that value).
Profile = `--profile <file>` → `<root>/.axiom/gate-profile.json` → `~/.axiom/gate-profile.json` →
built-in `{ deny: [".git/**", ".axiom/**", "**/*.lock", "pnpm-lock.yaml", ".env", ".env.*", "**/node_modules/**"], noSecrets: true }`.
Schema: `{ deny: string[], allow?: string[], noSecrets: boolean, maxBytes?: number }` (strict).

`gate` is a separate lazy chunk (`dist/gate-lazy.js`, no MCP SDK): in-process p95 ≈ 5 ms per payload,
end-to-end ≈ 150–200 ms including node startup; `check-gate-latency` guards p95 ≤ 250 ms.
Wiring for each harness is in [`docs/hooks.md`](../../docs/hooks.md).
