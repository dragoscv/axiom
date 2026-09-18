---
description: Rules for @codai/axiom-mcp — the published stdio server and CLI
applyTo: "packages/mcp/**"
---

# packages/mcp

`@codai/axiom-mcp` is the only published binary. It wraps `plan`, `checks` and
`apply` as MCP tools over **stdio** (v2.0) and as CLI verbs. Bundle ≤ 950 KB,
cold start p50 ≤ 250 ms — both measured in CI (`check-bundle-size`, `check-cold-start`).

## Tool definition rules

- Every tool declares **`annotations`** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint: false`) **and an `outputSchema`** built from
  the `@codai/axiom-schema` Zod types. A tool without both fails review.
- Tool names are `axiom_<noun>_<verb>` and live in one registry
  (`src/tools.ts` or `src/tools/`). The list is mirrored **by hand** into
  `spec/tools.json`, `README.md` and `docs/mcp_api.md`; `check-tool-parity`
  fails when they disagree. Add a tool = edit all four (see skill `add-mcp-tool`).
- `axiom_apply` and `axiom_rollback` are `destructiveHint: true`; everything else
  is `readOnlyHint: true`.
- **structuredContent stays small.** Return digests, counts, paths and codes —
  never file contents or whole bundles. Large data goes behind an
  `axiom://` resource URI.
- Input validation is the schema's job: parse with Zod, on failure return a
  structured error `{ code: "ERR_INVALID_INPUT", details: issues }` — never throw
  out of a tool handler.

## Process rules

- **stdout is JSON-RPC only.** `console.log`/`process.stdout.write` are banned
  everywhere except `src/cli.ts` (`check-no-stdout`). Log with `console.error`
  / `console.warn`, default level `warn`.
- **Roots are an allowlist.** `--root <dir>` (repeatable) is the only way a path
  becomes writable; there is no `process.cwd()` fallback. `axiom_roots_list`
  reports exactly that list. A path outside every root → `ERR_ROOT_NOT_ALLOWED`.
- Only `src/cli.ts` may read `process.env`; everything else receives config as
  arguments.
- No `shell: true`, no `exec(`. No network in v2.0.
- The SDK is isolated behind `src/adapter.ts` so the MCP SDK v2 swap is one file.

## Tests

- In-process `Client` + `StdioClientTransport` smoke: `initialize`, `tools/list`
  (every tool has annotations + outputSchema), every tool with a malformed input
  → structured error with an `ERR_*` code.
- Never spawn the built `dist/cli.js` in unit tests (that is the guards' job).
