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

Runs a repository-owned guard script (design §3.2) and maps its output to
findings. `requires: guard`. **Disabled by default, twice**: the predicate runs
only when the profile sets `facts.allowGuards: true` **and** the server/CLI was
started with `--allow-guards`. Otherwise it returns one `error` finding
(`code: ERR_UNSUPPORTED_OP`, "external guards disabled") → `verdict: error`.

| Param | Type | Default |
|-------|------|---------|
| `command` | string | required — relative: resolved under `<root>/scripts/`; absolute: must be in `--guard-allowlist` |
| `args` | string[] | `[]` |
| `cwd` | `"root" \| "staging"` | `"root"` |
| `timeoutMs` | int 1–60000 | `30000` |
| `env` | record<string,string> | — (added to the scrubbed env) |
| `stdin` | `"bundle" \| "manifest" \| "none"` | `"bundle"` |
| `legacyText` | boolean | `false` — accept brivio-style `OK    name` / `FAIL  name: reason` stdout |

**Command resolution.** No shell is ever involved (`spawn` with an args array,
`windowsHide: true`). A relative `command` (with or without a `scripts/`
prefix) must realpath to a file strictly inside `<root>/scripts/`; any `..`
segment is rejected. An absolute `command` must realpath-match an entry of
`--guard-allowlist` exactly. `.mjs/.js/.cjs` run via the current `node`
(`process.execPath`), `.ps1` via `pwsh -NoProfile -ExecutionPolicy Bypass -File`;
any other extension is only allowed as an allowlisted absolute executable.
Violations produce an `error` finding with `code: ERR_PREDICATE_PARAMS`.

**Process environment.** The child gets a whitelist only (`PATH`, `HOME`,
`USERPROFILE`, `SYSTEMROOT`, `SYSTEMDRIVE`, `PATHEXT`, `COMSPEC`, `TEMP`,
`TMP`, `TMPDIR`, `LANG`, `LC_ALL`), plus `params.env`, plus
`AXIOM_MANIFEST_DIGEST` and `AXIOM_ROOT`. `NODE_OPTIONS` is cleared. `cwd` is
the realpath'd root, or the apply staging directory when `cwd: "staging"` and
the runner supplied one (otherwise `ERR_PREDICATE_PARAMS`).

**Stdin.** `bundle` → `JCS(ManifestBundle)`; `manifest` → `JCS(ManifestBody)`;
`none` → closed immediately.

**Output contract.** stdout must be one JSON object:

```ts
type GuardOutput = {
  ok: boolean;
  findings?: Array<{
    id: string;                       // finding id, e.g. "lint.todo"
    severity?: "error" | "warn" | "info"; // default: "error" when ok:false, "info" when ok:true
    message: string;
    path?: string;                    // RelPath; non-conforming values are kept in facts.rawPath
    facts?: Record<string, unknown>;
  }>;
};
```

| Guard behaviour | Result |
|-----------------|--------|
| exit 0, valid JSON | findings mapped (none → `[]`) |
| exit ≠ 0, valid JSON | same mapping |
| `ok: false` with no findings | one `error` finding "guard reported ok:false without findings" |
| exit 0, non-JSON stdout | one `error` finding, `code: ERR_GUARD_OUTPUT` (fail closed) |
| exit ≠ 0, non-JSON stdout | one `error` finding, `code: ERR_GUARD_OUTPUT`, `facts.stderr` = last 4 KiB |
| wall clock > `timeoutMs` | process tree killed, one `error` finding, `code: ERR_GUARD_TIMEOUT` |
| spawn failure (ENOENT etc.) | one `error` finding, `code: ERR_GUARD_OUTPUT` |
| `legacyText: true` and no JSON | `FAIL  name: reason` lines → `error` findings `{id: name, message: reason}`; only `OK` lines → `[]` |

Non-provider findings are re-labelled with the CheckRef `severity` like every
other predicate; provider failures (`code` above) stay `error` and force
`verdict: error`.

**Concurrency.** `runChecks` runs every `guard.external` check in a pool of
`min(4, os.cpus().length)` after the sequential predicates. The `guard`
provider status is `ok`, `error` (disabled, resolution failure, timeout, bad
output) or `skipped` (no guard checks in the set).

```json
{ "id": "repo-guards", "predicate": "guard.external",
  "params": { "command": "scripts/axiom-guard-adapter.mjs", "timeoutMs": 60000 } }
```

See `docs/integration/brivio.md` for wiring brivio's `run-guards.mjs`.

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
