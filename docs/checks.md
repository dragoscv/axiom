# Checks: predicates and profiles (v2)

`@codai/axiom-checks` runs a list of `CheckRef`s over a `ManifestBundle` and
returns a `CheckReport`. There is no expression language in v2.0: every check is
a **typed predicate** with a Zod-validated `params` object. CEL predicates are a
v2.2 item (S-301).

```json
{ "id": "no-env", "predicate": "path.deny", "params": { "globs": [".env*"] }, "severity": "error" }
```

- `id` is the check's name in the report; unique per merged list.
- `predicate` is `<group>.<name>` and must be registered.
- `params` are validated against the predicate's schema; **`{}` is not
  automatically valid** — a predicate with required params fails closed.
- `severity` (default `error`) re-labels every finding the predicate produces.

Globs everywhere are [picomatch](https://github.com/micromatch/picomatch) with
`dot: true`, matched against the artifact's `RelPath`.

## Verdict and fail-closed semantics

`verdict` is one of:

| Verdict | When |
|---------|------|
| `pass` | no finding with severity `error` |
| `fail` | at least one `error` finding from a predicate |
| `error` | something could not be evaluated: unknown predicate, invalid params, a fact provider threw, a predicate threw, or `guard.external` was requested |

`error` is never downgraded. `apply` treats anything other than `pass` as
`ERR_CHECKS_FAILED`. Provider failures appear as findings with
`facts.code` (an `ERR_*` code) and `facts.__provider: true`.

Repo predicates (`repo.*`) need a `root`; when the run has none, or the profile
sets `facts.allowRepo: false`, they are **skipped** (provider status `skipped`),
not failed — there is nothing to check against.

Predicates run sequentially in merged order; findings are sorted by
`(severity, id, path)`; `factsDigest = sha256(JCS(facts))` lets a report be
replayed.

## Predicate catalogue

Fifteen built-ins, exactly as registered in
`packages/checks/src/predicates/index.ts`. `requires` names the fact providers
the predicate reads.

### `path.allow`

Every artifact path must match at least one glob. `requires: manifest`.

| Param | Type | Required |
|-------|------|----------|
| `globs` | string[] (min 1, each non-empty) | yes |

Fails on each path outside the allowed set. Finding id `path.allow`.

```json
{ "id": "only-src", "predicate": "path.allow", "params": { "globs": ["src/**", "docs/**"] } }
```

### `path.deny`

No artifact path may match any glob. `requires: manifest`.

| Param | Type | Required |
|-------|------|----------|
| `globs` | string[] (min 1) | yes |

```json
{ "id": "no-env", "predicate": "path.deny", "params": { "globs": [".env*", "**/*.pem"] } }
```

### `path.reservedNames`

Re-runs the schema's `relPathIssues()` on every path (belt and braces after
schema validation). `requires: manifest`. Params: `{}` (strict, no keys).

```json
{ "id": "path.reservedNames", "predicate": "path.reservedNames", "params": {} }
```

### `content.noSecrets`

Scans the first 4 MiB of every non-deleted artifact's bytes (decoded as UTF-8,
non-fatal) against named regexes. `requires: manifest, content`.

| Param | Type | Default |
|-------|------|---------|
| `disable` | string[] of pattern names | `[]` |
| `allowPaths` | glob[] of paths to skip | `[]` |

Pattern names (`SECRET_PATTERN_NAMES`): `cnp`, `email`, `phoneRo`, `card`,
`credentialAssignment`, `awsKey`, `githubToken`, `privateKey`, `jwt`,
`slackToken`. One finding per (artifact, pattern) with id
`content.noSecrets.<name>` and `facts.pattern`.

```json
{ "id": "content.noSecrets", "predicate": "content.noSecrets",
  "params": { "disable": ["email"], "allowPaths": ["docs/**", "**/*.test.ts"] } }
```

### `content.maxBytes`

Fails on any non-deleted artifact larger than `max`. Uses `manifest.bytes` when
present, otherwise the resolved content length. `requires: manifest`.

| Param | Type | Required |
|-------|------|----------|
| `max` | int ≥ 0 | yes |
| `globs` | string[] — restrict to these paths | no (all paths) |

```json
{ "id": "small-svgs", "predicate": "content.maxBytes", "params": { "max": 65536, "globs": ["**/*.svg"] } }
```

### `content.encodingUtf8`

Fails on any non-deleted artifact whose bytes are not valid UTF-8.
`requires: manifest, content`.

| Param | Type | Required |
|-------|------|----------|
| `globs` | string[] | no (all paths) |

```json
{ "id": "utf8-sources", "predicate": "content.encodingUtf8", "params": { "globs": ["**/*.{ts,md,json}"] } }
```

### `manifest.maxArtifacts`

Fails when `artifactCount > max`. `requires: manifest`.

| Param | Type | Required |
|-------|------|----------|
| `max` | int ≥ 0 | yes |

```json
{ "id": "manifest.maxArtifacts", "predicate": "manifest.maxArtifacts", "params": { "max": 200 } }
```

### `manifest.maxTotalBytes`

Fails when the sum of `artifacts[].bytes` exceeds `max`. `requires: manifest`.

| Param | Type | Required |
|-------|------|----------|
| `max` | int ≥ 0 | yes |

```json
{ "id": "manifest.maxTotalBytes", "predicate": "manifest.maxTotalBytes", "params": { "max": 8388608 } }
```

### `manifest.requireSigned`

Fails unless `bundle.envelope.signatures` is non-empty. In v2.0 nothing signs
bundles, so this fails every unsigned bundle by design (signing is v2.2).
`requires: manifest`. Params: `{}`.

### `manifest.noDeletes`

Fails on every artifact with `op: delete`. `requires: manifest`. Params: `{}`.

```json
{ "id": "manifest.noDeletes", "predicate": "manifest.noDeletes", "params": {} }
```

### `deps.max`

Parses every artifact matching `files` as JSON, counts keys in `dependencies` +
`devDependencies`, fails when the count exceeds `max`. Non-JSON or non-object
content is ignored. `requires: manifest, content`.

| Param | Type | Default |
|-------|------|---------|
| `max` | int ≥ 0 | required |
| `files` | glob[] | `["**/package.json"]` |

```json
{ "id": "deps.max", "predicate": "deps.max", "params": { "max": 50 } }
```

### `deps.deny`

Same parsing as `deps.max`; one finding `deps.deny.<pkg>` per denied dependency.
`requires: manifest, content`.

| Param | Type | Default |
|-------|------|---------|
| `packages` | string[] (min 1) | required |
| `files` | glob[] | `["**/package.json"]` |

```json
{ "id": "no-telemetry", "predicate": "deps.deny",
  "params": { "packages": ["@vercel/analytics", "pino", "@opentelemetry/api"] } }
```

### `repo.noOverwriteOf`

Fails when an `overwrite` or `delete` targets a path that matches a glob **and
already exists** in the repo. `create` ops are ignored (they fail at apply with
`ERR_EXISTS` anyway). `requires: manifest, repo` — skipped without a root.

| Param | Type | Required |
|-------|------|----------|
| `globs` | string[] (min 1) | yes |

```json
{ "id": "repo.noOverwriteOf", "predicate": "repo.noOverwriteOf",
  "params": { "globs": [".github/**", "**/*.lock", "pnpm-lock.yaml"] } }
```

### `repo.requireCompanion`

The brivio `check-ripple` shape. For each rule, when any artifact path matches
`when`, every `expect[].match` must be satisfied by at least one artifact path
**or** one existing repo file. `requires: manifest, repo`.

| Param | Type |
|-------|------|
| `rules` | `{ when: glob, expect: { name: string, match: glob }[] (min 1) }[]` (min 1) |

Finding id `repo.requireCompanion.<name>`.

```json
{ "id": "ripple", "predicate": "repo.requireCompanion", "params": { "rules": [
  { "when": "packages/mcp/src/tools/**",
    "expect": [ { "name": "docs", "match": "docs/mcp_api.md" },
                { "name": "spec", "match": "packages/mcp/spec/tools.json" } ] }
] } }
```

### `guard.external`

**v2.1.** Params are accepted so profiles written for v2.1 validate today, but
in v2.0 the predicate never spawns anything and always returns a provider
failure (`ERR_UNSUPPORTED_OP`) → `verdict: error`. It is additionally blocked by
the runner unless the profile sets `facts.allowGuards: true`. `requires: guard`.

| Param | Type | Default |
|-------|------|---------|
| `command` | string | required |
| `args` | string[] | `[]` |
| `cwd` | `"root" \| "staging"` | — |
| `timeoutMs` | int 1–60000 | `30000` |
| `env` | record<string,string> | — |
| `stdin` | `"bundle" \| "manifest" \| "none"` | `"bundle"` |

## Built-in profiles

Defined in `packages/checks/src/profile.ts` (`BUILTIN_PROFILE_INPUTS`). Served
as `axiom://profile/<name>`.

### `default`

| id | predicate | params |
|----|-----------|--------|
| `path.reservedNames` | `path.reservedNames` | `{}` |
| `content.noSecrets` | `content.noSecrets` | `{}` |
| `manifest.maxArtifacts` | `manifest.maxArtifacts` | `{ "max": 2000 }` |
| `manifest.maxTotalBytes` | `manifest.maxTotalBytes` | `{ "max": 67108864 }` (64 MiB) |
| `repo.noOverwriteOf` | `repo.noOverwriteOf` | `{ "globs": [".git/**", ".axiom/**", "**/*.lock", "pnpm-lock.yaml", ".env*"] }` |

`limits: { maxArtifacts: 2000, maxTotalBytes: 67108864 }`.

### `strict` (`extends: default`)

Adds, on top of everything in `default`:

| id | predicate | params |
|----|-----------|--------|
| `manifest.noDeletes` | `manifest.noDeletes` | `{}` |
| `deps.max` | `deps.max` | `{ "max": 50 }` |
| `path.deny` | `path.deny` | `{ "globs": ["**/node_modules/**"] }` |

### `permissive`

| id | predicate | params |
|----|-----------|--------|
| `path.reservedNames` | `path.reservedNames` | `{}` |

## Custom profiles and `extends`

A profile is a JSON file `<root>/.axiom/profiles/<name>.json` matching the
`Profile` schema ([plan-format.md](plan-format.md#profile)); its `name` must
equal the file stem. Resolution (`loadProfile`):

1. Search directories are tried in order, then the built-ins.
2. `extends` chains are resolved parent-first; a cycle or a missing parent is
   `ERR_INVALID_PROFILE`.
3. Checks merge by `id` — a child entry **replaces** the parent's entry with the
   same id, so `{ "id": "content.noSecrets", …, "params": { "disable": ["email"] } }`
   in a child re-parameterises the default check rather than adding a second one.
4. `limits` and `facts` merge shallowly, child over parent.
5. The plan's own `checks[]` are merged last with the same rule.

```json
{
  "apiVersion": "axiom.dev/v2", "kind": "Profile", "name": "web",
  "extends": "strict",
  "checks": [
    { "id": "path.allow", "predicate": "path.allow", "params": { "globs": ["apps/web/**", "packages/ui/**"] } },
    { "id": "content.noSecrets", "predicate": "content.noSecrets", "params": { "allowPaths": ["**/*.test.ts"] } }
  ]
}
```

## Adding a predicate

Follow `.github/skills/add-predicate/SKILL.md`: define `params` with Zod, implement
`run()` so that any provider failure surfaces as an error finding (never a
constant pass), register it in `BUILTIN_PREDICATES`, wire it into a profile if it
should be on by default, add unit tests including the fail-closed path, add a
changeset, and document it in this file.
