---
description: Rules for @codai/axiom-schema — the single source of every wire type and error code
applyTo: "packages/schema/**"
---

# packages/schema

`@codai/axiom-schema` defines `Plan`, `ManifestBody`, `ManifestBundle`,
`CheckReport`, `ApplyResult`, `Profile`, `Journal` (Zod v4) and the closed
`ERROR_CODES` enum. It has **zero** `@codai/*` dependencies and only `zod` at runtime.

## Rules

- **Strict objects.** Every object schema is `z.strictObject(...)` (or `.strict()`):
  unknown keys are a validation error, never silently dropped — canonicalisation
  depends on it.
- **Additive only within a major.** Add optional fields; never rename, retype or
  remove. Anything that changes the JCS output of an existing valid `ManifestBody`
  changes every `manifestDigest` in the wild and is a major bump.
- **Error codes are a closed enum.** New code → append to `ERROR_CODES` in
  `src/errors.ts` (keep alphabetical groups), give it one line of intent in the
  comment above it, then use it. `scripts/check-error-codes.mjs` fails on any
  `"ERR_*"` literal that is not in the list. Never encode data in the code string;
  use `details`.
- **`AxiomError` is the only throwable.** `new AxiomError(code, message, { details, cause })`.
  Messages are for humans and may change; tests assert `err.code`.
- **No timestamps or randomness** inside any schema that participates in a
  digest (`ManifestBody`, `Statement.subject`). Put them in the envelope/journal.
- **JSON Schema is generated, not hand-edited.** After any schema change run
  `pnpm --filter @codai/axiom-schema build:jsonschema` and commit
  `schemas/*.json`; `scripts/check-schema-json-fresh.mjs` diffs them in CI.
  Adding a new top-level schema = add it to the target list in
  `scripts/emit-json-schema.ts` too.
- `tsconfig.json` overrides `isolatedDeclarations: false` (Zod generics) — do not
  copy that override into other packages.

## Tests (`src/*.test.ts`)

- One positive + the minimal negative per field constraint; assert
  `result.error.issues[0].code`/path, not messages.
- Property tests with `fast-check` for round-trips (`parse(serialize(x)) ≡ x`).
- Never test Zod itself; test **our** refinements (`RelPath` NFC/segment rules,
  digest formats, size limits).
