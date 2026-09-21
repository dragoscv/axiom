---
name: add-predicate
description: Add a new built-in check predicate to @codai/axiom-checks — Zod params, fail-closed run(), registry entry, profile wiring, unit + fail-closed tests, changeset. Use when a user asks for a new rule the gate should enforce ("block files over N bytes", "deny imports of X", "require a LICENSE next to package.json").
---

# Add a check predicate

A predicate is a pure function `(FactContext, params) → Finding[]` registered by
id `<group>.<name>`. It never throws for a "rule violated" — that is a `Finding`.
It **does** return `verdict: "error"` (via `AxiomError` → the runner maps it) when a
fact provider cannot deliver — fail closed, never a constant pass (PLAN.md §2).

## Steps

1. **Pick the group file** in `packages/checks/src/predicates/`:
   `path.ts` (path shape), `content.ts` (bytes), `manifest.ts` (set-level),
   `deps.ts` (package.json), `repo.ts` (existing tree), `guard.ts` (external).
   New group → new file, same shape as `deps.ts`.
2. **Define params** as a `z.object({...}).strict()` with defaults, then export
   `definePredicate<z.infer<typeof Params>>({ id, params, requires, run })`
   from `packages/checks/src/types.ts`. `requires` lists the fact providers
   (`"manifest" | "content" | "repo" | "guard"`) — declare only what you read.
3. **Implement `run(ctx, params)`** using helpers from `predicates/util.ts`
   (`finding()`, `globMatcher()`, `parseJsonObject()`). Iterate
   `ctx.manifest.artifacts`, skip `op === "delete"` where irrelevant, read bytes
   with `await ctx.facts.content(path)`; `undefined` means the blob is not
   available → return nothing for that artifact (the runner already reports
   missing facts). Every `Finding` needs `id`, `predicate`, `path?`, `message`
   and machine-readable `facts`.
4. **Register it**: import + add to both the named export block and
   `BUILTIN_PREDICATES` in `packages/checks/src/predicates/index.ts`. The
   registry (`packages/checks/src/registry.ts` `builtinRegistry()`) picks it up;
   duplicate ids throw `ERR_INTERNAL` at startup.
5. **Wire a profile** if it should run by default: add a
   `{ id, predicate, params }` entry to `default`/`strict` in
   `packages/checks/src/profile.ts`. Leave `permissive` minimal.
6. **Tests** in `packages/checks/src/predicates/predicates.test.ts` (or a new
   `<group>.test.ts`): one passing manifest, one violating (assert
   `findings[0].predicate` and `facts`, not message text), one with a broken
   fact provider asserting the fail-closed verdict, and — if params carry
   globs/sizes — a `fast-check` property. Helpers in
   `packages/checks/src/test-helpers.test-helpers.ts`.
7. **New error code?** Only if a *provider* failure mode is new: append to
   `ERROR_CODES` in `packages/schema/src/errors.ts` first
   (`scripts/check-error-codes.mjs` enforces it).
8. **Docs**: add a row to the predicate table in `packages/checks/README.md`
   (id, params, what it flags). If the MCP exposes profiles via `axiom_check`,
   `docs/reference/mcp-tools.md` needs no change unless the tool input changed.
9. **Changeset**: `pnpm changeset` → `@codai/axiom-checks` `minor`
   ("feat(checks): add `<group>.<name>` predicate").
10. **Verify** and paste output: `pnpm --filter @codai/axiom-checks test`,
    `pnpm exec biome check packages/checks`, `node scripts/run-guards.mjs --fast`.
    Predicates are in the Stryker scope (`stryker.config.mjs`) — a test that
    survives mutating your comparison operator is not done.
