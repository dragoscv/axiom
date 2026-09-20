---
"@codai/axiom-mcp": minor
"@codai/axiom-checks": minor
"@codai/axiom-schema": minor
---

Long-running checks as tasks and chunked plan sessions (S-406, D-24):

- **Tasks (mcp).** `axiom_check_start` runs the same evaluation as `axiom_check` but returns
  immediately as `{ taskId, status: "working", pollIntervalMs, ttlMs }`; `axiom_task_get` polls
  (attaching the `CheckReport` as `result` once `completed`, or `error` once `failed`/`cancelled`);
  `axiom_task_cancel` aborts a working task and kills every running guard process tree. Tasks are
  tool-level (SDK v2 has no `io.modelcontextprotocol/tasks` runtime), live in the server process,
  are shared by every connection/request a `serverFactory` serves, stay pollable 10 min after
  finishing, and are all aborted when the server stops. At most 8 run concurrently (`ERR_EBUSY`).
- **Chunked plans (mcp).** `axiom_plan_begin` (header) → `axiom_plan_add` × n (artifact chunks,
  each call ≤ 4 MiB, unique paths across chunks) → `axiom_plan_seal` compiles the assembled Plan
  through the same code path as `axiom_plan_compile`; a fast-check property asserts the sealed
  `manifestDigest`, canonical manifest and blobs equal a one-shot compile for arbitrary plans and
  chunkings. Sessions: 2000 artifacts / 64 MiB, 30 min idle, 16 open per process.
- **Guards (checks).** `guard.external.timeoutMs` cap raised 60 s → **15 min**;
  `RunChecksOptions.signal` / `GuardFacts.signal` abort the guard pool — a killed guard reports a
  provider finding `ERR_TASK_CANCELLED`.
- **Error codes (schema).** New closed codes `ERR_TASK_NOT_FOUND`, `ERR_TASK_CANCELLED`,
  `ERR_PLAN_SESSION_STATE`.
- 11 → 17 tools; `spec/tools.json`, `spec/codai-tools.json`, README and `docs/mcp_api.md` updated.
