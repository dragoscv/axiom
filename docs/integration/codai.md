# codai ↔ AXIOM integration

*How codai's SWE harness routes every write through the gate by default, the Copilot wiring, and the agent-core tool registration with risk classes.*

codai (`E:\gh\codai`) is the first consumer of AXIOM v2. Three touch points, in order of maturity:

| surface | status | where (in codai) |
|---|---|---|
| SWE harness write gate — **default ON** (`AXIOM_APPLY=0` opts out) | **landed** 2026-09-18, default flipped 2026-09-20 (S-414) | `packages/swe-harness/src/axiom-apply.ts` |
| Copilot dev wiring (MCP server in the workspace) | landed | `.vscode/mcp.json` |
| agent-core tool registration (RiskClass mapping, S-113) | design | `docs/design/axiom-write-gate-2026-09.md` |

## 1. SWE harness write gate

codai's SWE harness resolves model-authored SEARCH/REPLACE blocks in memory and writes the result
through `TaskWorkspace.writeFiles`. Unless `process.env.AXIOM_APPLY === "0"` that one method routes
through AXIOM (plain `writeFile` is the opt-out path):

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
- With `AXIOM_APPLY=0` not a single AXIOM symbol is touched.
- A `checks` rejection the model caused (`repo.noOverwriteOf` on a lockfile,
   `content.noSecrets.credentialAssignment`) is turned into an `edit_error` turn by
   `gateRejectionFeedback()` so the model revises; compile/apply failures and `verdict: error`
   propagate as job errors.
- `WorkspaceInit.intent` (issue text head) lands in every Plan's `intent` and therefore in the
   journal.

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
(`packages/agent-core/src/index.ts`). AXIOM ships the same information for its 17 MCP tools as
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
| `axiom_plan_validate`, `axiom_manifest_verify`, `axiom_check`, `axiom_check_start`, `axiom_task_get`, `axiom_apply_dry_run`, `axiom_manifest_diff`, `axiom_axm_parse`, `axiom_roots_list`, `axiom_repo_snapshot` | READ | `readOnlyHint: true` — touch no files |
| `axiom_plan_compile`, `axiom_plan_begin`, `axiom_plan_add`, `axiom_plan_seal`, `axiom_task_cancel` | ACT | write only under `<root>/.axiom/` (CAS blobs with `store: cas`, stored manifest when a `root` is given) or mutate server-process state; never the working tree |
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

## 4. Default-on evidence (S-414, 2026-09-20)

The write step is a pure function of (tree, edits); if the gate produces the same bytes as plain
fs writes, nothing downstream (tests, diff, verifier) can differ except through a rejection. So the
comparison was an **offline paired arm on real git history** rather than an LLM-noise cloud arm:
`packages/swe-harness/src/scripts/axiom-arm-bench.ts` in codai replays the post-commit contents of
the last 40 non-merge commits of 27 OSS repos through the real `TaskWorkspace.writeFiles`, fs vs
gate, into fresh worktrees, and byte-compares (rows: codai `docs/status/axiom-arm-2026-09-20.json`).

| | |
|---|---|
| edit sets / files / bytes | 1043 / 2267 / 58.1 MB |
| non-rejected trees byte-identical | **983 / 983**; rollbacks 0; exceptions 0 |
| write-step p50 (fs → gate) | 1.9 ms → 60.5 ms (+58.7 ms; p95 7.3 → 236 ms) — a resolve turn is 10–60 s, so ≪ +10 % end-to-end |
| gate rejections | 60 (5.8 %): 53 `repo.noOverwriteOf` (`uv.lock` 42, `poetry.lock` 10, `Cargo.lock` 1), 7 `content.noSecrets.credentialAssignment` (all genuine quoted credentials in tests/docs) |

What the arm changed in AXIOM: the first run rejected 2 of the first 8 edit sets on
`token = var.set("testvalue")` and a maintainer e-mail in `pyproject.toml` — false positives that
became `@codai/axiom-checks` c36c818 (PII opt-in `pii: true`; credential-literal precision; CNP
checksum; e-mail domain filters — see [checks.md](../guides/checks.md#contentnosecrets)). The vendored copy in
codai (`vendor/axiom/*`, `scripts/ops/sync-axiom-vendor.ps1`) was re-synced before the run above.

Owner decision: default ON, rejections fed back to the model as `edit_error`. A cloud arm on a
fresh holdout remains the way to measure how often the model recovers from that feedback.

---

**See also**

- [MCP tools](../reference/mcp-tools.md) — the registry `codai-tools.json` is generated from
- [Harnesses](harnesses.md) — the generic MCP/hook wiring codai's `.vscode/mcp.json` follows
- [Checks](../guides/checks.md#contentnosecrets) — the precision rules the eval arm produced
- [Decisions](../design/decisions.md) — D-26 (eval-arm method, PII opt-in)
