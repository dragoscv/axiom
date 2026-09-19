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
  A `<name>.preimage/` directory next to a plan supplies the files that its
  `patch` sources are applied to (absent file → `absent`).

  | Fixture | Pins |
  |---------|------|
  | `plan-basic` | inline utf8 + base64, nested path, NFC text, `overwrite`, checks |
  | `plan-patch` | one `patch` source per format (unified, v4a update, v4a Add File, search-replace) against `plan-patch.preimage/` — D-17 exact matching |
  | `plan-patch-inline` | the same content as inline sources; `golden.test.ts` asserts `planDigest` equality with `plan-patch` and that only `manifestDigest` differs (`origin`) |

`isolatedDeclarations` is off here (inferred Zod/fast-check types).
