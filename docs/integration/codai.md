# Registering AXIOM's tools in codai (S-113)

codai's agent-core keeps its tool catalogue in `packages/agent-core/spec/` and gates every call
through `APPROVAL_MATRIX[autonomy][risk]` with `RiskClass = READ | ACT | SENSITIVE`
(`packages/agent-core/src/index.ts`). AXIOM ships the same information for its 9 MCP tools as
**`packages/mcp/spec/codai-tools.json`**, generated from the MCP registry by
`pnpm --filter @codai/axiom-mcp build:spec` and pinned by `tools-spec.test.ts`.

## Why the file lives here and not in codai

codai's catalogue has no notion of an externally-served (MCP) tool:

- `spec/tools.json` entries require `platforms: ["android"|"desktop"]` + per-platform `aliases`, and
  `test/parity.test.ts` asserts every desktop entry exists in `DESKTOP_TOOL_DEFS` / the desktop MCP
  shim and every android entry exists in the Kotlin sources. An AXIOM row there would fail that test.
- `spec/tools-v2.json` (harness v2) is mirrored *verbatim* by `TOOL_DEFS_V2` in
  `apps/desktop/src/executor/harness-v2/tools.ts` — again asserted by a test.
- Neither schema has a `source`/`mcp` field, and inventing one is out of scope.

So AXIOM emits the rows in codai's exact **`tools-v2.json` entry shape** and codai chooses where to
splice them in.

## Entry shape

```json
{
  "name": "axiom_apply",
  "risk": "SENSITIVE",
  "description": "…",
  "parameters": { "type": "object", "properties": { … }, "required": [ … ] }
}
```

`parameters` is the MCP `inputSchema` (JSON Schema 2020-12) with the `$schema` marker dropped, so it
drops straight into an OpenAI/Anthropic `function.parameters` field.

## Risk mapping (derived from MCP annotations — never hand-edited)

| tool | risk | reason |
|---|---|---|
| `axiom_plan_validate`, `axiom_manifest_verify`, `axiom_check`, `axiom_apply_dry_run`, `axiom_manifest_diff`, `axiom_roots_list` | READ | `readOnlyHint: true` — touch no files |
| `axiom_plan_compile` | ACT | writes only under `<root>/.axiom/` (CAS blobs with `store: cas`, stored manifest when a `root` is given); never the working tree |
| `axiom_apply`, `axiom_rollback` | SENSITIVE | `destructiveHint: true` — rewrite files in the root (2PC, journaled) |

## Wiring it into a codai harness

1. Start the server with an explicit root allowlist (there is no `cwd` fallback):
   `npx @codai/axiom-mcp mcp --root <workspace>`.
2. At tool-registration time, read `node_modules/@codai/axiom-mcp/spec/codai-tools.json` (it is in
   the package `files`) and push each entry into the model-facing tool list; look up `risk` from the
   same entry when deciding `needsApproval(risk, autonomy)`.
3. Forward a model call `axiom_*` to the MCP client's `callTool`. Results come back as
   `structuredContent` (full result) + `content[0].text` (summary); failures are `isError: true` with
   `{ code, message }` from AXIOM's closed `ERROR_CODES` enum — branch on `code`, never on text.
4. `axiom_apply` additionally requires `confirmDigest === manifestDigest` from a preceding
   `axiom_apply_dry_run`/`axiom_plan_compile`, so an approval prompt can show the digest it is about
   to commit.
