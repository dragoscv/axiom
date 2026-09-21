<!-- Title must be a Conventional Commit: feat(apply): …, fix(checks): …, chore(guards): … -->

## Summary

<!-- What changes, in one or two sentences. Link the issue or the S-xxx / D-xx id. -->

## Why

<!-- The problem this solves. If it touches a PLAN.md §2 invariant, say which and why it stays intact. -->

## How verified

<!-- Paste the actual output. "Should work" does not count. -->

```text
pnpm exec biome check .
pnpm typecheck
pnpm test
pnpm build
node scripts/run-guards.mjs
```

## Ripple statement

<!-- Which adjacent surfaces you updated, and which you deliberately did not, with the reason. -->

## Checklist

- [ ] `pnpm exec biome check .` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `node scripts/run-guards.mjs` are green and the output is pasted above
- [ ] A `.changeset/*.md` exists for any change under `packages/*/src` (except `testkit`)
- [ ] `PLAN.md` and `TRACKER.csv` are updated in the same commit if a `D-xx` / `S-xxx` changed
- [ ] Ripple closed:
  - new or changed MCP tool → `docs/reference/mcp-tools.md` + `packages/mcp/README.md` + `packages/mcp/spec/tools.json`
  - new schema field → `pnpm --filter @codai/axiom-schema build:jsonschema`, `schemas/*.json` committed
  - new golden plan → `.expected.json` regenerated (`update-golden`)
- [ ] Tests assert on `ERR_*` codes, never on message text; every `it()` asserts
- [ ] PR title is a Conventional Commit
