# Checks: predicates and profiles (v2)

`@codai/axiom-checks` runs a list of `CheckRef`s over a `ManifestBundle` and
returns a `CheckReport`. Every check is a **typed predicate** with a
Zod-validated `params` object; `expr.cel` (S-301) is one such predicate whose
param is a CEL expression evaluated over the same facts.

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

**Pre-image (S-402).** When a `root` is given and the manifest carries
`preImage[]`, `runChecks` first compares every entry with the tree. Any
difference emits an `error` finding `manifest.preImage` (`facts.code:
ERR_PREIMAGE_CHANGED`, `expected`, `actual`) per path, forces `verdict: error`
and sets `report.preImage: "drifted"`; otherwise `"verified"`. Without a root or
without `preImage` the report says `"unverified"`. A stored `CheckReport`
therefore names the tree it judged.

Predicates run sequentially in merged order; findings are sorted by
`(severity, id, path)`; `factsDigest = sha256(JCS(facts))` lets a report be
replayed.

## Predicate catalogue

Sixteen built-ins, exactly as registered in
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

`card` is not a bare digit-run regex: a 13–16-digit run (optional single space /
hyphen separators) counts only if it passes the **Luhn** checksum, is not a single
repeated digit (`0000 0000 0000 0000`), and is not part of a UUID
(`00000000-0000-0000-0000-000000000000`). Epoch-millisecond timestamps, zero
UUIDs and sequential placeholders therefore pass; every real test PAN (Visa
`4111 1111 1111 1111`, Amex `378282246310005`, …) is still caught.

```json
{ "id": "content.noSecrets", "predicate": "content.noSecrets",
  "params": { "disable": ["email"], "allowPaths": ["docs/**", "**/*.test.ts"] } }
```

**Globs and Next.js route groups.** Every glob parameter (`path.*`, `allowPaths`,
`repo.*`, `content.maxBytes.globs`, …) goes through one matcher (picomatch, `dot:
true`). A parenthesised segment with no glob metacharacters — `app/(app)/**`,
`(marketing)` — is escaped automatically so it matches the literal directory;
real extglobs (`@(a|b)`, `!(x)`, `+(y)`) and already-escaped `\(app\)` are left
as written.

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

Verifies the bundle's detached DSSE envelopes (`bundle.signatures[]`) against the
root's trust store and, optionally, enforces the anti-rollback counter. Full
protocol, key handling and CLI in [signing.md](signing.md). `requires: manifest`;
needs a root (no root → `verdict: error`).

| Param | Type | Default | Meaning |
|-------|------|---------|---------|
| `minSignatures` | int 1–16 | `1` | distinct trusted keys that must have produced a valid signature |
| `antiRollback` | boolean | `false` | require `manifest.counter` and `counter > .axiom/trust/state.json#lastCounter` (and `≥ keys.json#minCounter`) |
| `trustFile` | string | `.axiom/trust/keys.json` | root-relative POSIX path of the trust store |

Finding ids: `signature.missing`, `signature.unknownKey`, `signature.bad`,
`signature.notCanonical`, `signature.rollback` (`facts.reason` ∈ `NO_COUNTER |
ROLLBACK | BELOW_MIN`). Fail-closed: missing trust file → `ERR_NOT_FOUND`,
unreadable/invalid → `ERR_PROVIDER_FAILED`, corrupt state → `ERR_TRUST_STATE_CORRUPT`,
all as provider errors (`verdict: error`).

```json
{ "id": "manifest.requireSigned", "predicate": "manifest.requireSigned",
  "params": { "minSignatures": 1, "antiRollback": true } }
```

`apply` advances `lastCounter` only when the effective checks include this predicate
with `antiRollback: true` and the result is `status: "applied"`.

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
**or** (unless `mustChange`) one existing repo file. `requires: manifest, repo`.

| Param | Type |
|-------|------|
| `rules` | `{ when: glob, expect: { name: string, match: glob, mustChange?: boolean = false }[] (min 1) }[]` (min 1) |

`mustChange: true` demands that the companion be **in this plan** — an existing
repo file no longer satisfies it. Use it for "touch the schema ⇒ touch a
migration" rules, where a stale existing companion is exactly the bug being
guarded; singleton companions (`client.ts`, `proxy.ts`, `en.json`) otherwise only
bite on a fresh clone. Finding id `repo.requireCompanion.<name>`,
`facts.mustChange` echoes the flag.

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
(`code: ERR_FACT_DISABLED`, "external guards disabled") → `verdict: error`.

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
| exit ≠ 0, non-JSON stdout | one `error` finding, `code: ERR_GUARD_OUTPUT` |
| wall clock > `timeoutMs` | process tree killed, one `error` finding, `code: ERR_GUARD_TIMEOUT` |
| spawn failure (ENOENT etc.) | one `error` finding, `code: ERR_GUARD_OUTPUT` |
| `legacyText: true` and no JSON | `FAIL  name: reason` lines → `error` findings `{id: name, message: reason}`; only `OK` lines → `[]` |

**Evidence.** Every finding the guard produces — mapped findings, the
"ok:false without findings" fallback, `ERR_GUARD_OUTPUT` and `ERR_GUARD_TIMEOUT`
— carries `facts.evidence = { exitCode, stdout, stderr }` (each stream the last
2 KiB) so a `FAIL lint` is auditable from the report alone, without re-running
the guard. `facts.command` names the guard.

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

### `expr.cel`

A boolean [CEL](https://github.com/google/cel-spec) expression over the frozen
facts (PLAN.md S-301, decision D-15). Evaluated by `@marcbachmann/cel-js` 8,
loaded lazily on first use so the MCP eager bundle does not pay for it.
`requires: manifest, content` (`repo` is read when referenced — see below).

| Param | Type | Default |
|-------|------|---------|
| `expression` | string, 1–4096 chars | required |
| `message` | string ≤ 2000 | `expression evaluated to false: <expression>` |
| `severity` | `"error" \| "warn" \| "info"` | the CheckRef severity |

**Activation** — the only variables an expression may reference:

| Variable | Shape |
|----------|-------|
| `manifest` | the canonical `ManifestBody`: `name`, `profile`, `planDigest`, `artifacts[]`, `checks[]`, `toolchain`, … — integers are CEL `int` |
| `artifacts` | alias of `manifest.artifacts`: `{ path, op, mode, digest?: { sha256 }, bytes?, origin? }` — `delete` entries have no `digest`/`bytes` |
| `content` | map `path → { bytes: int, sha256: string, text?: string }` for every non-delete artifact whose blob is available; `text` only when the blob is valid UTF-8 and ≤ 256 KiB |
| `repo` | `{ exists: map path → bool (for every artifact path), packageJson?, gitHead?, gitDirty? }` — only when a root is authorised (`facts.allowRepo`). Referencing `repo` without one is an `error` finding (`ERR_PROVIDER_FAILED`), never a pass |

**Semantics.** The result must be `bool`: `true` → no finding; `false` → exactly
**one** finding (`id: expr.cel`, `facts.expression`) with `message`; anything
else — parse error, unknown variable, missing key (`a.bytes` on a `delete`),
division by zero, type mismatch (`2 == 2.0` is an error in CEL: use
`double(2)`), non-bool result — is a provider-style `error` finding and the
report verdict is `error`. No `${…}` templating in `message`; keep it a plain
string. Use `has(a.bytes)` on select paths and `'text' in content[k]` on
indexed maps to guard optional fields.

**Determinism bar (D-15), enforced in the predicate, not trusted from the lib:**

- **Function allowlist** — only `has all exists exists_one map filter size
  contains startsWith endsWith matches lowerAscii upperAscii trim split join
  indexOf lastIndexOf substring string int uint double bool bytes dyn type`.
  `timestamp`, `duration`, `now`, `base64`, `hex`, `json`, `cel.bind`,
  `optional.*`, `at` and any unknown name → `ERR_PREDICATE_PARAMS`.
- **RE2-safe regex** — `matches()` takes a string **literal** only; lookaround
  `(?= (?! (?<= (?<!`, backreferences `\1` and `\k<n>` are rejected.
- **Resource caps** — expression ≤ 4096 chars (Zod), AST depth ≤ 24, ≤ 2000
  nodes, ≤ 256 list elements / map entries, ≤ 8 call arguments (cel-js
  `limits`, parse-time), and a 100 ms wall-clock guard on evaluation
  (`ERR_PROVIDER_FAILED` when exceeded).
- **Closed variable set** — `unlistedVariablesAreDyn: false`; any other
  identifier is an evaluation error.

A 345-case vector suite (`packages/checks/src/predicates/cel-vectors.json`:
197 true / 58 false / 90 error) plus a purity test (same suite twice →
identical) and fast-check properties against a JS reference guard this.

```json
{ "id": "no-large-ts", "predicate": "expr.cel", "severity": "error",
  "params": {
    "expression": "artifacts.filter(a, a.path.endsWith('.ts')).all(a, a.op == 'delete' || a.bytes < 200000)",
    "message": "TypeScript artifacts must stay under 200 KB" } }
```

A worked profile that combines three expressions:

```json
{
  "apiVersion": "axiom.dev/v2", "kind": "Profile", "name": "web-cel",
  "extends": "default",
  "checks": [
    { "id": "cel.no-todo", "predicate": "expr.cel", "severity": "warn",
      "params": { "expression": "content.all(k, !('text' in content[k]) || !content[k].text.contains('TODO'))",
                  "message": "new content must not contain TODO" } },
    { "id": "cel.exec-only-scripts", "predicate": "expr.cel",
      "params": { "expression": "artifacts.all(a, a.mode != '0755' || a.path.startsWith('scripts/'))",
                  "message": "0755 is allowed only under scripts/" } },
    { "id": "cel.create-is-new", "predicate": "expr.cel",
      "params": { "expression": "artifacts.filter(a, a.op == 'create').all(a, !repo.exists[a.path])",
                  "message": "create must not target an existing file" } }
  ]
}
```

The last check needs `facts.allowRepo` (inherited from `default`) **and** an
authorised root; without one it reports `error`, so a profile that uses `repo`
cannot silently pass in a root-less run.

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
