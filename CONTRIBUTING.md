# Contributing to AXIOM

## Setup

- Node ≥ 22.14, pnpm 12 (`corepack enable` picks up `packageManager`).
- `pnpm install --frozen-lockfile` — then `pnpm approve-builds` once for esbuild/biome.
- `node scripts/install-hooks.mjs` — sets `core.hooksPath=.githooks` (pre-commit = Biome on
  staged files + fast guards).
- Read `PLAN.md` (§2 invariants) and `.github/instructions/*.instructions.md` before editing.

## Scripts

| Command | What |
|---|---|
| `pnpm build` | tsdown every package (needed before `typecheck` — exports point at `dist/`) |
| `pnpm typecheck` | TypeScript 7 (`tsgo`) per package |
| `pnpm test` / `pnpm test:coverage` | Vitest 5 (thresholds 85/85/80/85) |
| `pnpm lint` / `pnpm lint:fix` | Biome 2.5 — the only linter/formatter |
| `pnpm guards` | `node scripts/run-guards.mjs` — all repo guards, parallel, 60 s each |
| `pnpm test:mutation` | Stryker on canon / apply containment / predicates (break 85 %) |
| `pnpm --filter @codai/axiom-schema build:jsonschema` | regenerate `packages/schema/schemas/*.json` |
| `pnpm --filter @codai/axiom-testkit update-golden` | re-pin golden digests (format change only) |

## Guards (`scripts/check-*.mjs`)

Each guard is standalone, node-builtins only, prints `OK    name` / `FAIL  name: reason`,
exits 0/1 and supports `--json`. `run-guards.mjs [filter…] [--fast] [--strict] [--json]`.
`--fast` skips build-dependent guards (pre-commit); `--strict` (CI) turns "dist missing → skip"
into a failure. `packages/_v1` is ignored everywhere. Adding a guard = one new file; the runner
discovers it.

## Changesets

Any change under `packages/*/src` (except `testkit`) needs `pnpm changeset` → `.changeset/*.md`.
All `@codai/axiom-*` are a fixed version group. Releases: tag `v*` → `release.yml` publishes with
npm trusted publishing (OIDC, provenance). See skill `release-axiom`.

## Definition of done

1. `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm guards` — all green, output shown.
2. Tests assert on `ERR_*` codes, never messages; every `it()` asserts; `.skip` has a reason.
3. Ripple closed: tool → `spec/tools.json` + `packages/mcp/README.md` + `docs/mcp_api.md`;
   schema → regenerated JSON Schema; golden → re-pinned and cross-OS green.
4. `PLAN.md` + `TRACKER.csv` updated in the same commit when a story/decision changes.
5. Conventional Commits; stage explicit paths only (shared clone — never `git add -A`).
