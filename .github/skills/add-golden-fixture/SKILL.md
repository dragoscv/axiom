---
name: add-golden-fixture
description: Add or regenerate a golden Plan→Manifest fixture in packages/testkit/golden so a digest is pinned and compared across ubuntu/windows/macos in CI. Use when a new Plan shape (new source kind, op, blob transport, edge-case path) needs a determinism lock, or when a deliberate manifest-format change requires re-pinning expected digests.
---

# Add a golden fixture

Golden fixtures are the cross-OS determinism contract: `plan-<name>.plan.json`
compiles to a `manifestDigest` that must be byte-identical on every OS
(CI job `golden-cross-os` in `.github/workflows/ci.yml`). Changing an
`.expected.json` is a **format change** and belongs in a reviewed, changeset-ed
commit — never "just update it to make CI green".

## Steps

1. **Write the plan** at `packages/testkit/golden/<name>.plan.json` — a valid
   `Plan` (schema: `packages/schema/schemas/Plan.schema.json`). Keep it small and
   targeted at the one shape you want pinned (e.g. NFC path, `delete` op, empty
   file, 256 KiB blob boundary, CAS source). Use only inline sources unless the
   fixture is *about* CAS/ref. No timestamps or machine-specific values.
2. **Generate the expected file**:
   `pnpm --filter @codai/axiom-testkit update-golden`
   (`packages/testkit/scripts/update-golden.ts` → `compileGolden()` in
   `packages/testkit/src/golden.ts`). It writes `<name>.expected.json` with
   `manifestDigest`, `planDigest`, `artifacts[{path, sha256}]` and prints the
   digest to stderr.
3. **Inspect the diff**: only *your* new file should appear. If an existing
   `.expected.json` changed, you have altered canonicalisation — stop, confirm
   that is intended (PLAN.md §2 invariant 1), and say so in the changeset.
4. **Sanity-check the digest by hand** once:
   `node -e "…"` is not enough — run the golden test
   `pnpm --filter @codai/axiom-testkit test` (`packages/testkit/src/golden.test.ts`
   recompiles every fixture and compares digests).
5. **Guard**: `node scripts/check-golden-digests.mjs` — every plan has an
   expected file with a well-formed `sha256:` digest, no orphans.
6. **Cross-OS proof**: push; the `golden-cross-os` job reruns `update-golden.ts`
   on ubuntu-24.04 / windows-2025 / macos-15 and fails on `git diff`. Do not
   merge on one green OS.
7. **Changeset** only if a *schema/canon/plan* package changed. Fixture-only
   additions in the private `testkit` need none (`check-changeset-present`
   ignores `packages/testkit`).
8. **Record** the fixture's purpose in one line at the top of
   `packages/testkit/README.md` (fixture table).
