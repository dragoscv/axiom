---
name: add-mcp-tool
description: Add or change a tool on the @codai/axiom-mcp stdio server — Zod input/output schemas, annotations, handler that never throws, registry mirror in spec/tools.json + README + docs/reference/mcp-tools.md, smoke test, changeset. Use when a user wants agents to be able to call a new AXIOM capability over MCP or a new CLI verb.
---

# Add an MCP tool

Every tool is one entry in the registry (`packages/mcp/src/tools.ts` or
`packages/mcp/src/tools/<name>.ts`) with **annotations + outputSchema**, and is
mirrored by hand into three documents. `scripts/check-tool-parity.mjs` fails CI
when any of the four disagree; `.copilot-ripple.json` reminds you while editing.

## Steps

1. **Name it** `axiom_<noun>_<verb>` (snake_case, e.g. `axiom_manifest_diff`).
   Decide risk: reads → `readOnlyHint: true`; anything that writes a root →
   `destructiveHint: true`, `idempotentHint` as appropriate, `openWorldHint: false`.
2. **Schemas** — input and output as Zod built from `@codai/axiom-schema` types
   (import the schema, don't redefine `Plan`/`ManifestBundle`). Output must be
   small: digests, counts, paths, `ERR_*` codes. Bulk data goes behind an
   `axiom://…` resource.
3. **Handler** — parse input with the Zod schema; on failure return a structured
   error `{ code: "ERR_INVALID_INPUT", details }`. Resolve every path through the
   roots allowlist (`--root`), never `process.cwd()`. Call into
   `@codai/axiom-plan` / `-checks` / `-apply`; map `AxiomError` → `{ code, message,
   details }`. **Never throw out of the handler**; log with `console.error` only.
4. **Register** the tool in the registry array; the server iterates it for
   `tools/list`. If a CLI verb should exist too, add it in
   `packages/mcp/src/cli.ts` (the only file allowed to use stdout / `process.env`).
5. **Mirror** (all three, same commit):
   - `packages/mcp/spec/tools.json` — `{ name, riskClass, description }` (this
     is what codai registers; `apply`-class = `SENSITIVE`, reads = `READ`).
   - `packages/mcp/README.md` — tool table row.
   - `docs/reference/mcp-tools.md` — tool table row (name, risk, purpose, input, output).
6. **Tests** — extend the in-process smoke in `packages/mcp/src/*.test.ts`:
   `tools/list` includes the name with annotations + outputSchema; a malformed
   input returns an `ERR_*` code; one happy path against a tmp root. Do not
   spawn `dist/cli.js` in unit tests.
7. **Budgets** — after `pnpm --filter @codai/axiom-mcp build`, run
   `node scripts/run-guards.mjs bundle cold --strict`: bin ≤ 950 KB, cold start
   p50 ≤ 250 ms. A new heavy dependency that breaks this needs a lazy `import()`.
8. **Changeset** — `pnpm changeset` → `@codai/axiom-mcp` `minor`.
9. **Verify** — `pnpm exec biome check packages/mcp`, `pnpm --filter @codai/axiom-mcp test`,
   `node scripts/run-guards.mjs tool-parity no-stdout no-shell` — paste output.
