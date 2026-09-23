# @codai/axiom-checks

Predicate-based checks engine for AXIOM v2 (design §3). Deterministic, offline,
data-driven by JSON `CheckRef`s — no expression language in 2.0.

```ts
import { loadProfile, runChecks } from "@codai/axiom-checks";
const profile = await loadProfile("strict", {
  searchDirs: [".axiom/profiles"],
});
const report = await runChecks({
  bundle,
  profile,
  root: realRoot,
  checks: plan.checks,
});
// report.verdict: "pass" | "fail" | "error"  (error = a provider/params failure; never silently pass)
```

- **Facts**: `facts/manifest.ts` (counts, bytes, paths), `facts/content.ts` (blobs → CAS, re-hashed,
  never network), `facts/repo.ts` (exists/read/glob over a lazy `.gitignore`-aware index, `package.json`,
  `.git/HEAD` read directly — no spawn; `gitDirty` is `undefined` in 2.0).
- **Built-ins**: `path.allow|deny|reservedNames`, `content.noSecrets|maxBytes|encodingUtf8`,
  `manifest.maxArtifacts|maxTotalBytes|requireSigned|noDeletes`, `deps.max|deny`,
  `repo.noOverwriteOf|requireCompanion|requireReference`, `guard.external` (spawns a repo-owned `scripts/*.mjs|.ps1`
  or an allowlisted absolute executable, no shell; needs profile `facts.allowGuards` **and**
  `runChecks({ allowGuards: true, guardAllowlist })` — the CLI/server `--allow-guards` /
  `--guard-allowlist <abs>` flags; stdout must be `GuardOutput` JSON; guard checks run in a pool
  of `min(4, cpus)`; see `docs/guides/checks.md`), `expr.cel` (boolean CEL `expression` over
  `manifest`/`artifacts`/`content`/`repo` via `@marcbachmann/cel-js`, lazily imported; closed
  function allowlist — no `timestamp`/`duration`/`now` — literal RE2-safe `matches()`, AST depth
  ≤ 24, 100 ms budget; parse/type/runtime errors and non-bool results → `error`, never pass),
  `expr.cedar` (Cedar `policies` via the **optional** `@cedar-policy/cedar-wasm`, lazily imported;
  one authorization request per artifact — principal `Axiom::Plan`, action `Axiom::Action::"<op>"`,
  resource `Axiom::Artifact::"<path>"` with the same attributes `expr.cel` sees; `mode: "forbid"`
  (default) appends a permit-all so every `deny` is a per-path finding, `mode: "permit"` is
  default-deny; parse/type/eval errors and a missing WASM → `error`, never pass).
- **Profiles**: `default`, `strict` (extends default), `permissive`; files `<dir>/<name>.json` shadow
  builtins; `extends` chains are resolved parent-first, child checks override by `id`; cycles →
  `ERR_INVALID_PROFILE`.
- Findings are sorted `(severity, id, path)`; `factsDigest = sha256(JCS({manifestFacts, profileName, checkIds}))`.

## Adding a predicate

1. Create `src/predicates/<group>.ts` (or extend one) and export
   `definePredicate<z.infer<typeof Params>>({ id: "group.name", params: Params, requires: [...], run })`.
   `id` must match `^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$`; `params` is a strict Zod object;
   `requires` lists which facts you read (`repo` predicates are skipped when no root is given).
2. Return `Finding[]` via `finding({...})` from `util.ts`. Emit `facts.__provider = true` only when the
   predicate itself could not evaluate — that forces the `error` verdict.
3. Add it to `BUILTIN_PREDICATES` in `src/predicates/index.ts` and bump the count in `run.test.ts`.
4. Add positive + negative tests in `src/predicates/predicates.test.ts`.

`tsconfig.json` sets `isolatedDeclarations: false` (Zod-inferred param types cannot be annotated
explicitly); tsdown still emits `.d.ts` through tsgo.
