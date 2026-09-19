---
description: How tests are written in AXIOM v2 — Vitest 5, tmp roots, fast-check, no vacuous asserts
applyTo: "**/*.test.ts"
---

# Tests

Vitest 5 via the root `vitest.config.ts` (`projects: packages/*/vitest.config.ts`).
Run one package with `pnpm --filter @codai/axiom-<pkg> test`; everything with
`pnpm test`. Coverage thresholds: 85 % lines/functions/statements, 80 % branches.

## Rules

- **Assert on codes, never on messages.** `expect(err.code).toBe("ERR_…")`,
  `expect(report.findings[0].code)`. Message text is free to change.
- **Every `it()` asserts something.** `scripts/check-vacuous-assertions.mjs`
  fails a test with no `expect(`/`fc.assert(`, and any
  `expect(true).toBe(true)` / `indexOf(...) < .length` tautology.
- **`.skip`/`.todo` need a reason** — a comment on the same or previous line
  naming the blocker or tracker id (`// S-401: patch source not yet in schema`).
- **Filesystem tests use a fresh tmp root** (`mkdtemp` under `os.tmpdir()`,
  removed in `afterEach`). Never write into the repo, never depend on `cwd`.
- **Invariants are properties.** Use `fast-check` (`fc.assert(fc.property(...))`)
  for: containment never escapes, `JCS(parse(JCS(x))) == JCS(x)`, apply twice =
  noop, rollback after a fault at any step restores byte-identical trees. Reuse
  arbitraries from `packages/testkit/src/arbitraries.ts`; add new ones there.
  Default `numRuns` ≥ 200; the containment suite runs 10 000 in CI.
- **Golden fixtures** live in `packages/testkit/golden/`; compare by digest, and
  regenerate only on an intentional format change (`update-golden`) — the diff
  in `.expected.json` is part of the review.
- **No `any`, no `!`** — the Biome override only relaxes `noNonNullAssertion`
  in tests; prefer a typed helper.
- Do not test third-party behaviour (Zod, node:fs); test our refinements over it.
- Windows runs in CI: normalise paths with `toPosixPath` before comparing, and
  never assert on `\n` vs `\r\n` from git-checked-out fixtures.

## Layout

`<module>.test.ts` next to `<module>.ts`; shared helpers in
`test-helpers.ts` (excluded from coverage and from Stryker's mutate list).
