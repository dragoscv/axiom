# @codai/axiom-testkit (private)

Shared test helpers for AXIOM v2 packages. Never published.

- `arbitraries.ts` — fast-check: `relPathArb()` (schema-valid RelPath, 1–4
  segments of `[a-z0-9_-]{1,12}` + optional extension), `planArtifactArb()`,
  `planArb({ minArtifacts, maxArtifacts, deletes })`.
- `fixtures.ts` — `makeBundle(files, opts)` compiles a `{ path: content }` map
  via `compilePlan`; `tmpRepo(prefix)` → `{ root, cleanup }` with `mkdtemp`.
- `golden/` — `*.plan.json` + `*.expected.json`. `golden.test.ts` recompiles
  each plan and asserts the committed `manifestDigest`: the cross-OS
  determinism guard (§2.4). Regenerate deliberately with
  `pnpm --filter @codai/axiom-testkit update-golden`.

`isolatedDeclarations` is off here (inferred Zod/fast-check types).
