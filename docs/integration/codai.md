# codai ↔ AXIOM integration

codai (`E:\gh\codai`) is the first consumer of AXIOM v2. Three touch points, in order of maturity:

| surface | status | where (in codai) |
|---|---|---|
| SWE harness opt-in write gate (`AXIOM_APPLY=1`) | **landed** 2026-09-18 | `packages/swe-harness/src/axiom-apply.ts` |
| Copilot dev wiring (MCP server in the workspace) | landed | `.vscode/mcp.json` |
| agent-core tool registration (RiskClass mapping, S-113) | design | `docs/design/axiom-write-gate-2026-09.md` |

## 1. SWE harness write gate

codai's SWE harness resolves model-authored SEARCH/REPLACE blocks in memory and writes the result
with plain `writeFile` (`TaskWorkspace.writeFiles`). Behind `process.env.AXIOM_APPLY === "1"` that
one method now routes through AXIOM instead:

```
buildPlanFromEdits(root, edits, {taskId, intent})   // pure: Plan with final content per file
   → compilePlan(plan)                                // @codai/axiom-plan
   → loadProfile("default", {searchDirs:[root/.axiom/profiles]}) → runChecks({bundle, profile, root})
   → verdict === "pass"                               // else AxiomGateError{stage:"checks"}
   → apply({bundle, root, mode:"fs", confirmDigest: bundle.manifestDigest})
   → {manifestDigest, status, files}
```

Plan shape produced (`PlanSchema`, `apiVersion: axiom.dev/v2`): POSIX paths, `op: create` for files
absent on disk / `overwrite` for existing, `source: {type: inline, encoding: utf8}` holding the
**final** text, `name: swe-<taskId>` kebab-cased to `PlanNameSchema`, `profile: default`.

Contract points that matter to AXIOM:

- The three packages are loaded with dynamic `import()`; a resolution failure surfaces as
   `AxiomUnavailableError` ("install @codai/axiom-{plan,checks,apply}@^2.0.0"). Nothing in codai
   imports them statically, so codai typechecks without them installed.
- codai types the results with local minimal interfaces (`bundle.manifestDigest`, `report.verdict`,
   `result.{manifestDigest,status,files,error}`). Renaming any of those fields in
   `@codai/axiom-schema` is a breaking change for codai — bump major.
- Default is unchanged: with the flag unset, not a single AXIOM symbol is touched.

Test: `packages/swe-harness/src/axiom-apply.test.ts` (vitest, the three packages `vi.mock`ed)
asserts the Plan shape, that `confirmDigest === manifestDigest`, and that a `fail` verdict throws
before `apply` is called.

## 2. Copilot / VS Code wiring

`.vscode/mcp.json` in codai:

```json
{ "servers": { "axiom": { "type": "stdio", "command": "node",
   "args": ["E:/gh/axiom/packages/mcp/dist/cli.js", "mcp", "--root", "${workspaceFolder}"] } } }
```

Local `dist` until 2.0.0 is on npm, then `npx @codai/axiom-mcp mcp --root <ws>`. Roots are an
explicit allowlist — there is no `cwd` fallback.

## 3. Registering AXIOM's tools in codai agent-core (S-113)

codai's agent-core keeps its tool catalogue in `packages/agent-core/spec/` and gates every call
through `APPROVAL_MATRIX[autonomy][risk]` with `RiskClass = READ | ACT | SENSITIVE`
(`packages/agent-core/src/index.ts`). AXIOM ships the same information for its 9 MCP tools as
**`packages/mcp/spec/codai-tools.json`**, generated from the MCP registry by
`pnpm --filter @codai/axiom-mcp build:spec` and pinned by `tools-spec.test.ts`.

### Why the file lives here and not in codai

codai's catalogue has no notion of an externally-served (MCP) tool:

- `spec/tools.json` entries require `platforms: ["android"|"desktop"]` + per-platform `aliases`, and
  `test/parity.test.ts` asserts every desktop entry exists in `DESKTOP_TOOL_DEFS` / the desktop MCP
  shim and every android entry exists in the Kotlin sources. An AXIOM row there would fail that test.
- `spec/tools-v2.json` (harness v2) is mirrored *verbatim* by `TOOL_DEFS_V2` in
  `apps/desktop/src/executor/harness-v2/tools.ts` — again asserted by a test.
- Neither schema has a `source`/`mcp` field. The codai design note proposes
   `source: {kind: "mcp", server: "axiom"}` with a parity-test exemption; until that lands, codai
   splices the rows in at runtime.

So AXIOM emits the rows in codai's exact **`tools-v2.json` entry shape** and codai chooses where to
splice them in.

### Entry shape

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

### Risk mapping (derived from MCP annotations — never hand-edited)

| tool | risk | reason |
|---|---|---|
| `axiom_plan_validate`, `axiom_manifest_verify`, `axiom_check`, `axiom_apply_dry_run`, `axiom_manifest_diff`, `axiom_roots_list` | READ | `readOnlyHint: true` — touch no files |
| `axiom_plan_compile` | ACT | writes only under `<root>/.axiom/` (CAS blobs with `store: cas`, stored manifest when a `root` is given); never the working tree |
| `axiom_apply`, `axiom_rollback` | SENSITIVE | `destructiveHint: true` — rewrite files in the root (2PC, journaled) |

### Wiring it into a codai harness

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

## After 2.0.0 publishes

In codai: `pnpm install` (deps `@codai/axiom-{apply,checks,plan}@^2.0.0` are already declared in
`packages/swe-harness/package.json`), then run one resolve worker with `AXIOM_APPLY=1` and compare
resolve rate / latency against the fs path over a full eval arm before defaulting.
