---
description: AXIOM v2 repo conventions and invariants every change must follow
applyTo: "**"
---

# AXIOM conventions

AXIOM is the **transactional write gate for coding agents**: `Plan` → canonical
`Manifest` → set-level `checks` → hash-gated two-phase `apply` → journal. Read
`PLAN.md` §2 and `docs/design/v2-architecture.md` before touching anything.

## Canonical tracker

- `PLAN.md` + `TRACKER.csv` are the single source of truth for decisions (`D-xx`)
  and stories (`S-xxx`). Update **both in the same commit**; `check-tracker-sync`
  fails when an id exists in only one. Statuses: `todo|doing|done|blocked|dropped|open`.
- Every other `*SUMMARY*.md`/`*REPORT*.md` is archived under `docs/archive/v1/`
  and must not be resurrected. `packages/_v1/**` is frozen legacy — never import
  from it (`check-no-v1-imports`).

## Invariants (PLAN.md §2) — never weaken

1. `ManifestBody` is JCS-canonical (RFC 8785); `manifestDigest = sha256(JCS(body))`;
   no timestamps inside anything that is hashed.
2. Content never lives in the canonical manifest — it travels as `blobs`
   (≤ 256 KiB each, ≤ 4 MiB bundle), CAS (`.axiom/cas/sha256/…`) or a pinned `ref`.
3. `apply` requires `confirmDigest === manifestDigest`; pre-image hashes are
   re-verified at commit (TOCTOU guard); `.axiom/lock` = single writer per root.
4. **Error codes are a closed enum** — `ERROR_CODES` in
   `packages/schema/src/errors.ts`. Add the code there first; any `"ERR_*"`
   literal elsewhere must exist in that list (`check-error-codes`). Tests assert
   on `code`, never on message text.
5. MCP: **stdout is JSON-RPC only**. No `console.log`/`process.stdout.write`
   outside `packages/mcp/src/cli.ts` (`check-no-stdout`); log to stderr at `warn`.
6. **No shell**: `shell: true`, `exec(`, `execSync(` are banned in `packages/*/src`
   (`check-no-shell-spawn`). Use `execFile`/`spawn` with an args array.
7. Predicates return `verdict: "error"` when a fact provider cannot run —
   fail closed, never a constant pass.
8. Roots are an explicit allowlist (`--root`); there is no `cwd` fallback.

## Package boundaries (enforced by `check-package-deps`)

`schema`, `canon` → no `@codai/*` deps · `plan`/`checks`/`apply` → only `schema`+`canon`
· `axm` → `schema` only (`plan` as devDependency) · `testkit` → `schema`+`canon`+`plan` · `mcp` → anything except `testkit` · nobody
depends on `mcp`. Workspace deps are `workspace:*`; **every external dep is
`catalog:`** (versions live only in `pnpm-workspace.yaml`).

## Toolchain & policy

- pnpm 12 (`packageManager` field), Node ≥ 22.14, TypeScript 7 (tsgo), tsdown,
  Biome 2.5 (no ESLint/Prettier), Vitest 5, fast-check, Changesets 3, Stryker 10.
- **Latest-stable policy**: when touching a dependency, bump the catalog to the
  current stable (`npm view <pkg> version`). No alpha/beta/RC without a reason in
  the changeset.
- Biome: `noExplicitAny`, `noNonNullAssertion` (tests exempt), `noConsole`
  (error/warn allowed) are errors. `pnpm exec biome check --write .` before commit.

## Definition of done for any change

- `pnpm exec biome check .` · `pnpm typecheck` · `pnpm test` · `pnpm build` ·
  `node scripts/run-guards.mjs` — all green, output shown, not inferred.
- A `.changeset/*.md` exists for any change under `packages/*/src` (except
  `testkit`) — `check-changeset-present` fails in CI without one.
- Ripple closed: new tool → `docs/mcp_api.md` + `packages/mcp/README.md` +
  `packages/mcp/spec/tools.json`; new schema field → re-run
  `pnpm --filter @codai/axiom-schema build:jsonschema` and commit `schemas/*.json`;
  new golden plan → `.expected.json` regenerated (`update-golden`).
- Git: stage explicit paths only (shared clone); Conventional Commits
  (`feat(apply): …`, `fix(checks): …`, `chore(guards): …`).
