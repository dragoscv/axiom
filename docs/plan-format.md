# Plan, Manifest and result formats (v2)

Field reference for every wire type. The source of truth is
`packages/schema/src/*.ts` (Zod v4); the generated JSON Schemas are in
`packages/schema/schemas/*.json` and served as `axiom://schema/<Kind>`. Every
object is `.strict()` — unknown keys are rejected.

Worked example throughout: `packages/testkit/golden/plan-basic.plan.json`.

## Common scalars

| Type | Definition |
|------|------------|
| `Sha256Hex` | `^[a-f0-9]{64}$` (lowercase). Violation → `ERR_DIGEST_FORMAT`. |
| `Digest` | `{ "sha256": Sha256Hex }` — in-toto DigestSet subset. |
| `DigestRef` | Template literal `sha256:<Sha256Hex>`; used wherever a digest is a key or id. |
| `RelPath` | See below. |
| `Severity` | `"error" \| "warn" \| "info"` |

### `RelPath`

A string, 1–1024 chars, that satisfies **all** of the following. `relPathIssues()`
reports every violation, each as an error code:

| Rule | Code |
|------|------|
| Not empty, ≤ 1024 chars; no segment is `""`, `.` or `..`; no segment ends with `.` or space | `ERR_PATH_SEGMENT` |
| No leading `/`, no drive letter (`^[a-zA-Z]:`), no backslash | `ERR_PATH_NOT_RELATIVE_POSIX` |
| Equal to its NFC normalisation | `ERR_PATH_NOT_NFC` |
| No `< > : " \| ? *`, no C0 control (U+0000–U+001F), no DEL. `:` also rules out NTFS alternate data streams | `ERR_PATH_INVALID_CHAR` |
| No segment matches Windows device names `CON PRN AUX NUL COM1–9 LPT1–9`, case-insensitive, with or without an extension — enforced on **every** platform | `ERR_PATH_RESERVED_NAME` |

## Plan (input)

```json
{
  "apiVersion": "axiom.dev/v2",
  "kind": "Plan",
  "name": "golden-basic",
  "intent": "Three inline files: text, nested path, and a binary payload.",
  "artifacts": [
    { "path": "src/index.ts",
      "source": { "type": "inline", "content": "export const answer = 42;\n" } },
    { "path": "README.md", "mode": "0644", "op": "overwrite",
      "source": { "type": "inline", "content": "# golden\n\nhéllo — ✓ 日本語\n" } },
    { "path": "bin/run.sh", "mode": "0755",
      "source": { "type": "inline", "encoding": "base64",
                  "content": "IyEvYmluL3NoCmVjaG8gAGJpbmFyeQo=" } }
  ],
  "checks": [
    { "id": "no-secrets", "predicate": "content.noSecrets", "params": {} }
  ]
}
```

| Field | Type | Constraint |
|-------|------|------------|
| `apiVersion` | literal | `"axiom.dev/v2"` |
| `kind` | literal | `"Plan"` |
| `name` | string | `^[a-z0-9][a-z0-9-]{0,63}$` — lowercase kebab-case, ≤ 64 chars |
| `intent` | string | ≤ 2000 chars; human-readable purpose, recorded in the attestation |
| `profile` | string | min 1, default `"default"`. Name of the check profile (`default`, `strict`, `permissive`, or `<root>/.axiom/profiles/<name>.json`) |
| `capabilities` | enum[] | any of `fs net secret ai compute git`; default `[]`. Recorded, not enforced by a sandbox |
| `artifacts` | `PlanArtifact[]` | 1–2000 entries |
| `checks` | `CheckRef[]` | default `[]`; merged after the profile's checks (same `id` → the plan's wins) |
| `metadata` | record<string, json> | default `{}`; free-form, hashed into `planDigest` |

### `PlanArtifact`

| Field | Type | Constraint |
|-------|------|------------|
| `path` | `RelPath` | target relative to the root |
| `mode` | `"0644" \| "0755"` | default `"0644"`; recorded but not applied on Windows |
| `op` | `"create" \| "overwrite" \| "delete"` | default `"create"` |
| `source` | `PlanArtifactSource` | **required** unless `op` is `delete`; **must be absent** when `op` is `delete`. Both violations → `ERR_INVALID_PLAN` |

Op semantics at apply time:

- `create` — target must not exist (`ERR_EXISTS` otherwise). Existing directory
  or symlink at the target → `ERR_TARGET_TYPE`.
- `overwrite` — target may or may not exist; if it exists its pre-image is
  backed up and re-hashed at commit (`ERR_PREIMAGE_CHANGED` on drift).
- `delete` — target is moved into `.axiom/backup/`; no `digest` in the manifest.

### `PlanArtifactSource` (discriminated on `type`)

| `type` | Fields | Limits / notes |
|--------|--------|----------------|
| `inline` | `content: string`, `encoding: "utf8" \| "base64"` (default `utf8`) | `content` ≤ 262 144 chars (`INLINE_CONTENT_MAX`, 256 KiB). Decoded bytes ≈ 192 KiB when base64. Compiled into `bundle.blobs`. |
| `cas` | `digest: DigestRef` | Bytes must already be at `<root>/.axiom/cas/sha256/<aa>/<hex>`; missing → `ERR_BLOB_MISSING`. |
| `ref` | `uri: url` (`file:` or `https:` only), `digest: DigestRef` | Accepted by the schema; **not fetched in v2.0** → `ERR_REF_OFFLINE`. Network refs are v2.2. |
| `template` | `emitter: string`, `template: string`, `params: record` (default `{}`) | Reserved for v2.1 so v2.0 tooling can parse v2.1 plans; compile rejects with `ERR_UNSUPPORTED_OP`. |

### `CheckRef`

| Field | Type | Constraint |
|-------|------|------------|
| `id` | string | 1–128 chars; unique within the merged check list |
| `predicate` | string | `^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$` — `<group>.<name>`, must be registered (`ERR_PREDICATE_UNKNOWN`) |
| `params` | json | validated against the predicate's own Zod schema (`ERR_PREDICATE_PARAMS`) |
| `severity` | `Severity` | default `"error"`; findings from this check are re-labelled with it |

The predicate catalogue and each `params` shape: [checks.md](checks.md).

## Manifest and ManifestBundle (output)

`axiom_plan_compile` produces a `ManifestBundle`. Only `bundle.manifest` is
hashed; everything else is transport.

### `ManifestBody` — the hashed object

`manifestDigest = "sha256:" + hex(sha256(utf8(JCS(manifest))))`, JCS = RFC 8785.

| Field | Type | Constraint |
|-------|------|------------|
| `apiVersion` | literal | `"axiom.dev/v2"` |
| `kind` | literal | `"Manifest"` |
| `name` | `PlanName` | copied from the plan |
| `profile` | string | min 1 |
| `planDigest` | `DigestRef` | sha256(JCS(Plan with every `source` replaced by `{type, digest}`)) — identical for an inline plan and its CAS twin |
| `artifacts` | `ManifestArtifact[]` | 1–2000; **sorted by path in UTF-8 byte order, unique** (`ERR_NOT_CANONICAL`) |
| `checks` | `CheckRef[]` | **sorted by id, unique** (`ERR_NOT_CANONICAL`) |
| `toolchain` | `{ axiom: string, emitters: record<string,string> }` | versions that produced the bundle; keys sorted by JCS |

No timestamps, no invocation ids, no absolute paths. Two compiles of the same
plan on different operating systems yield the same `manifestDigest`; this is
pinned by `packages/testkit/golden/*.expected.json` and compared across
ubuntu/windows/macos in CI.

### `ManifestArtifact`

| Field | Type | Constraint |
|-------|------|------------|
| `path` | `RelPath` | |
| `op` | `create \| overwrite \| delete` | |
| `mode` | `0644 \| 0755` | |
| `digest` | `Digest` | required unless `op` is `delete` (`ERR_INVALID_MANIFEST`); sha256 of the exact bytes written — no newline or BOM normalisation |
| `bytes` | int ≥ 0 | optional; decoded size |
| `origin` | `inline \| template \| cas \| ref` | optional; where the bytes came from |

### `ManifestBundle` — what moves between tools

| Field | Type | Notes |
|-------|------|-------|
| `manifest` | `ManifestBody` | the hashed part |
| `manifestDigest` | `DigestRef` | must equal the recomputed hash (`ERR_NOT_CANONICAL`) |
| `attestation` | in-toto Statement v1 | optional; `subject[0].digest.sha256` is the manifest hex; `predicateType` `https://slsa.dev/provenance/v1`; timestamps live here, outside the hash |
| `envelope` | DSSE envelope | optional; `payloadType: "application/vnd.in-toto+json"`. Signing is v2.2; in v2.0 `signed` is `true` only if `signatures.length > 0` |
| `blobs` | record<`DigestRef`, `{ encoding: utf8 \| base64, data: string }`> | default `{}`; inline side-channel. Sum of decoded sizes ≤ 4 MiB (`BUNDLE_BLOB_BYTES_MAX`) → `ERR_BUNDLE_TOO_LARGE` |

Content resolution order at check/apply time: `blobs` → CAS (`<root>/.axiom/cas`)
→ `ref`. A digest found nowhere aborts before any write with `ERR_BLOB_MISSING`.
Every resolved blob is re-hashed; a mismatch is `ERR_DIGEST_MISMATCH` (or
`ERR_SIZE_MISMATCH` when `bytes` disagrees).

## Profile

| Field | Type | Constraint |
|-------|------|------------|
| `apiVersion`, `kind` | literals | `"axiom.dev/v2"`, `"Profile"` |
| `name` | string | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `extends` | profile name | optional; resolved parent-first, cycles → `ERR_INVALID_PROFILE` |
| `checks` | `CheckRef[]` | child entries replace parent entries with the same `id` |
| `limits` | `{ maxArtifacts?, maxTotalBytes?, maxBlobBytes? }` | positive ints; merged shallowly over the parent |
| `facts` | `{ allowRepo: bool = true, allowGuards: bool = false }` | `allowRepo=false` skips repo predicates; `allowGuards` gates `guard.external` (v2.1) |

Built-in profiles and their check lists: [checks.md](checks.md#built-in-profiles).

## CheckReport

| Field | Type | Notes |
|-------|------|-------|
| `apiVersion`, `kind` | literals | `"axiom.dev/v2"`, `"CheckReport"` |
| `manifestDigest` | `DigestRef` | the bundle that was checked |
| `profile` | string | resolved profile name |
| `verdict` | `pass \| fail \| error` | `error` = a provider, predicate lookup, params validation or predicate run failed. Never a silent pass |
| `findings` | `Finding[]` | sorted by `(severity, id, path)` |
| `factsDigest` | `DigestRef` | sha256(JCS(all facts)) so a report can be re-derived |
| `durationMs` | int ≥ 0 | |
| `providers` | `{ name, status: ok \| skipped \| error, ms }[]` | `manifest`, `content`, `repo`, `guard` |

`Finding`: `{ id, severity, predicate, message, path?: RelPath, facts: record }`.
Provider failures carry `facts.code` (an error code) and `facts.__provider: true`.

## ApplyResult

| Field | Type | Notes |
|-------|------|-------|
| `apiVersion`, `kind` | literals | `"axiom.dev/v2"`, `"ApplyResult"` |
| `manifestDigest` | `DigestRef` | |
| `mode` | `dry-run \| fs \| pr` | `pr` is reserved for v2.1 |
| `status` | `applied \| noop \| rolled-back \| failed` | `failed` requires `error` |
| `root` | string | absolute, realpath'd, as authorised |
| `files` | `{ path, op, digest?, status: written \| deleted \| unchanged \| skipped }[]` | empty on failure before phase 2 |
| `diff` | string | dry-run only; unified diff capped at 1 MiB |
| `journal` | string | path of `.axiom/journal/<hex>.json` when phase 2 started |
| `git` | `{ branch, commit?, compareUrl? }` | v2.1 |
| `error` | `{ code: ErrorCode, message, path? }` | present on `failed` and `rolled-back` |

### Journal (`.axiom/journal/<hex>.json`)

`{ manifestDigest, phase: staged | committing | committed | rolling-back | rolled-back,
steps: [{ path, op, backup?, done }], startedAt: ISO datetime, pid }`. Written
and fsynced before phase 2; see [apply.md](apply.md).

## Error codes

Closed enum in `packages/schema/src/errors.ts`. Anything else is a bug
(`check-error-codes` guard).

| Code | Meaning |
|------|---------|
| `ERR_PATH_NOT_RELATIVE_POSIX` | leading `/`, drive letter, or backslash in a path |
| `ERR_PATH_SEGMENT` | empty, `.`, `..`, trailing dot/space segment, or length out of range |
| `ERR_PATH_NOT_NFC` | path is not NFC-normalised |
| `ERR_PATH_RESERVED_NAME` | a segment is a Windows device name |
| `ERR_PATH_INVALID_CHAR` | `<>:"\|?*`, C0 control or DEL in a path |
| `ERR_PATH_CASE_COLLISION` | two artifacts (or an artifact and an existing file on a case-insensitive FS) differ only by case |
| `ERR_SYMLINK_IN_PATH` | a symlink or junction in the target's ancestry |
| `ERR_CONTAINMENT` | realpath of the target's directory is outside the root |
| `ERR_TARGET_TYPE` | target exists but is a directory or symlink |
| `ERR_EXISTS` | `op: create` but the target exists |
| `ERR_NOT_FOUND` | `op: delete` (or a read) on a path that does not exist |
| `ERR_BLOB_MISSING` | no bytes for a digest in blobs, CAS or ref |
| `ERR_DIGEST_FORMAT` | not `sha256:` + 64 lowercase hex |
| `ERR_DIGEST_MISMATCH` | bytes do not hash to the declared digest |
| `ERR_SIZE_MISMATCH` | decoded size differs from `bytes` |
| `ERR_BLOB_TOO_LARGE` | a single inline blob exceeds 256 KiB |
| `ERR_BUNDLE_TOO_LARGE` | inline blobs total more than 4 MiB (also the MCP payload cap) |
| `ERR_LOCKED` | `.axiom/lock` held by a live process after the 30 s wait |
| `ERR_ROOT_NOT_ALLOWED` | requested root is not inside the `--root` allowlist |
| `ERR_ROOT_REQUIRED` | no `root` given and more than one root is allowlisted |
| `ERR_ROOT_NOT_DIR` | root does not exist or is not a directory |
| `ERR_CONFIRM_DIGEST_MISMATCH` | `confirmDigest !== bundle.manifestDigest` |
| `ERR_CHECKS_FAILED` | pre-apply check verdict was not `pass` |
| `ERR_PREIMAGE_CHANGED` | a file changed between staging and commit (TOCTOU guard) |
| `ERR_JOURNAL_CORRUPT` | journal file unreadable or fails schema |
| `ERR_EBUSY` | rename kept failing (Windows open handle) after retries |
| `ERR_INVALID_PLAN` | Plan fails schema (details carry Zod issues) |
| `ERR_INVALID_MANIFEST` | bundle fails schema |
| `ERR_INVALID_PROFILE` | profile missing, not JSON, wrong name, cycle, or fails schema |
| `ERR_PREDICATE_UNKNOWN` | `CheckRef.predicate` is not registered |
| `ERR_PREDICATE_PARAMS` | `CheckRef.params` fail the predicate's schema |
| `ERR_PROVIDER_FAILED` | a fact provider or predicate threw |
| `ERR_GUARD_TIMEOUT` | external guard exceeded `timeoutMs` (v2.1) |
| `ERR_GUARD_OUTPUT` | external guard stdout was not a valid `GuardOutput` (v2.1) |
| `ERR_REF_OFFLINE` | `ref` source in v2.0 (no network) |
| `ERR_NOT_CANONICAL` | manifest not sorted/unique, or `manifestDigest` does not match the recomputed hash |
| `ERR_UNSUPPORTED_OP` | v2.1+ feature used in v2.0 (`template` source, `guard.external`, `mode: pr`) |
| `ERR_INTERNAL` | invariant violation inside AXIOM; please report |
