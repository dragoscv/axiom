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
| `counter` | int ≥ 0 | optional; anti-rollback counter copied verbatim into `ManifestBody.counter` (see [signing.md](signing.md)) |
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
| `ref` | `uri: url` (`file:` or `https:` only), `digest: DigestRef` | Pinned external content. Resolved from the CAS when the digest is already there; otherwise fetched **only** with `--allow-net` (see [Ref sources](#ref-sources)). Needs a `root`; without one → `ERR_REF_OFFLINE`. |
| `template` | `emitter: string`, `template: string`, `params: record` (default `{}`) | Rendered at compile time by an emitter from the caller-supplied `EmitterRegistry` (see [Template sources](#template-sources)); the rendered bytes then follow the `inline` path. No registry / unknown emitter → `ERR_EMITTER_UNKNOWN`; unknown template → `ERR_TEMPLATE_UNKNOWN`; bad params → `ERR_TEMPLATE_PARAMS`. |
| `patch` | `format: unified \| v4a \| search-replace`, `preImage: DigestRef \| "absent"`, `body: string` (≤ 256 KiB) | A diff instead of the whole file (see [Patch sources](#patch-sources)). Compile reads the file under the root, requires its sha256 to equal `preImage` (`ERR_PATCH_PREIMAGE`), applies the patch with exact matching only (`ERR_PATCH_NO_MATCH`), and content-addresses the *result*; unparseable body → `ERR_PATCH_FORMAT`. Needs a root (or an injected pre-image reader). |

### Ref sources

`{ type: "ref", uri, digest }` names bytes that live outside the plan — a vendored binary, a
release asset. The digest is the **pin**: whatever the URI serves, the artifact is accepted only
if `sha256(bytes) === digest`, so a URI that changes content later fails loudly instead of
silently shipping different bytes. The manifest records `origin: "ref"` and the digest; the bytes
never travel inline in the bundle (invariant 2) — they are stored in `<root>/.axiom/cas` and
`apply` reads them from there like any `cas` source.

Resolution order in `compilePlan(plan, { root, net })` (`packages/plan/src/ref.ts`):

1. **CAS hit** — `<root>/.axiom/cas/sha256/<aa>/<hex>` exists → return it. No network, no
  policy check; a ref that was fetched once compiles offline forever after.
2. **Offline default** — `net.allowNet` is `false` (the default, and the default of every MCP
  tool) → `ERR_NET_DISABLED { host, uri, digest }`. The URI in every error is redacted to
  origin + path: query strings and fragments (which may carry tokens) are never logged.
3. **Policy** (`ERR_NET_DENIED`) — scheme must be `https:`; `http:` is refused. `file:` is
  accepted only with `net.allowFile` (`--allow-file`). Credentials in the URI are refused. With
  `net.allowlist` (`--net-allow host[,host]`) the hostname must match an entry exactly or a
  `*.example.com` wildcard (proper subdomains only, case-insensitive); an empty allowlist denies
  everything, an absent one allows every https host.
4. **Fetch** — `GET` with `redirect: "error"` (no redirects are followed), an `AbortController`
  timeout (`timeoutMs`, default 30 s → `ERR_NET_FAILED { reason: "timeout" }`), non-2xx →
  `ERR_NET_FAILED { status }`. The body is streamed to a temp file next to its CAS slot with a
  running sha256 and a hard cap (`maxBytes`, default 32 MiB, also checked against
  `content-length`) → `ERR_BLOB_TOO_LARGE`, stream cancelled.
5. **Pin check** — digest mismatch → `ERR_DIGEST_MISMATCH { expected, actual, bytes }` and the
  temp file is deleted; **nothing is stored**. Match → fsync + atomic rename into the CAS.

CLI: `axiom compile plan.json --root . --allow-net [--net-allow cdn.example.com,*.github.com]
[--allow-file]`. `axiom apply` never fetches: a ref whose blob is not in the CAS fails with
`ERR_REF_OFFLINE` before any write, so run `compile --allow-net` on the same root first. The
MCP `axiom_plan_compile` tool has no network switch — agents cannot enable fetching; an operator
does it from the CLI. Blob lifecycle (`axiom gc`) is in [cas.md](cas.md).

### Template sources

`{ type: "template", emitter, template, params }` asks a registered *emitter* to render the
bytes at compile time. `compilePlan` ships no emitters; the caller passes
`{ emitters: createEmitterRegistry([...]) }` (the `axiom` CLI/MCP register `web@2.0.0` from
`@codai/axiom-emitters-web`). After rendering, the artifact is a normal blob: sha256 digest,
checks, two-phase apply. The manifest records `origin: "template"` and
`toolchain.emitters[emitter] = version`.

Digest rules: `params` are inputs, so they are hashed into `planDigest`
(`{ type, emitter, template, params, digest }` replaces the source); the emitter `version` is
toolchain, so it is hashed into `manifestDigest` only. Rendered output must be deterministic —
see [emitters.md](emitters.md) for the contract, the `web` catalogue and how to author one.

### Patch sources

`{ type: "patch", format, preImage, body }` lets an agent ship what it already produces — a
diff — instead of the whole file. Three formats are parsed into one hunk model:

| `format` | Accepted text |
|----------|---------------|
| `unified` | `@@ -a,b +c,d @@` hunks with ` `/`-`/`+` lines; `---`/`+++` headers optional; `\ No newline at end of file` honoured |
| `v4a` | OpenAI/Codex `apply_patch` text for **one** file: `*** Begin Patch` … `*** Update File: p` with `@@`/`@@ <context>` chunks and `*** End of File`, or `*** Add File: p` with `+` lines (requires `preImage: "absent"`). `*** Move to:` and multi-file patches are rejected |
| `search-replace` | Aider blocks `<<<<<<< SEARCH` … `=======` … `>>>>>>> REPLACE`; optional ``` fences |

**Matching is exact (D-17).** Each hunk's block (context + removed lines) must occur exactly
once at or after the previous hunk; a `unified` line-number hint disambiguates identical
blocks, a `v4a` `@@ <line>` anchor must itself match once and the block is searched after it.
No whitespace trimming, no fuzz factor: two machines must derive identical bytes from one
Plan or the manifest is not content-addressed. Agents that want tolerance apply it *before*
emitting the Plan.

**Pre-image binding.** `preImage` is the sha256 of the file the diff was authored against
(`"absent"` for a new file). Compile reads `<root>/<path>` and fails `ERR_PATCH_PREIMAGE`
when it does not hash to that value, so a stale diff can never be applied to a moved target.
The pre-image must be UTF-8 text.

**Digests.** The Manifest never sees the patch: the artifact carries the digest of the
*patched* bytes, `origin: "patch"`, and the blob is the full content. `planDigest` treats a
patch source exactly like an inline source with the same result — a Plan expressed as
diffs and the same Plan expressed inline have the **same** `planDigest` (golden fixtures
`plan-patch` / `plan-patch-inline`); only `manifestDigest` differs, through `origin`.

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
| `counter` | int ≥ 0 | optional; anti-rollback counter — inside the hash, so a signature binds it (`manifest.requireSigned { antiRollback }`) |
| `preImage` | `{ path: RelPath, sha256: hex \| "absent" }[]` | optional; sorted by path, unique. What compile saw on disk for **every** artifact path (S-402). Present whenever compile had a root (or an injected pre-image reader); inside the hash, so the same Plan compiled against two different trees yields two `manifestDigest`s while `planDigest` stays equal. `check` reports `preImage: verified \| drifted \| unverified`; `apply` refuses a first apply on a drifted tree with `ERR_PREIMAGE_CHANGED` (a re-apply of an applied digest is exempt — its own writes changed the tree; see `drifted`). |

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
| `origin` | `inline \| template \| cas \| ref \| patch` | optional; where the bytes came from |

### `ManifestBundle` — what moves between tools

| Field | Type | Notes |
|-------|------|-------|
| `manifest` | `ManifestBody` | the hashed part |
| `manifestDigest` | `DigestRef` | must equal the recomputed hash (`ERR_NOT_CANONICAL`) |
| `attestation` | in-toto Statement v1 | optional; `subject[0].digest.sha256` is the manifest hex; `predicateType` `https://slsa.dev/provenance/v1`; timestamps live here, outside the hash |
| `envelope` | DSSE envelope | optional; `payloadType: "application/vnd.in-toto+json"` around the attestation (unsigned record) |
| `signatures` | `ManifestSignature[]` | optional; detached DSSE v1.0.2 envelopes over `manifest`: `payloadType: "application/vnd.axiom.manifest+json"`, `payload = base64(JCS(manifest))`, Ed25519 `sig`, `keyid = sha256(raw pubkey)`. Not part of `manifestDigest`. Verified by `manifest.requireSigned` — see [signing.md](signing.md) |
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
| `facts` | `{ allowRepo: bool = true, allowGuards: bool = false }` | `allowRepo=false` skips repo predicates; `allowGuards` gates `guard.external` |

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
| `preImage` | `verified \| drifted \| unverified` | optional; `verified` = every `ManifestBody.preImage` entry matched the tree under `root`; `drifted` = at least one differed (an `error` finding `manifest.preImage` with `facts.code: ERR_PREIMAGE_CHANGED` per path, verdict `error`); `unverified` = no root or the manifest has no `preImage` |

`Finding`: `{ id, severity, predicate, message, path?: RelPath, facts: record }`.
Provider failures carry `facts.code` (an error code) and `facts.__provider: true`.

## ApplyResult

| Field | Type | Notes |
|-------|------|-------|
| `apiVersion`, `kind` | literals | `"axiom.dev/v2"`, `"ApplyResult"` |
| `manifestDigest` | `DigestRef` | |
| `mode` | `dry-run \| fs \| pr` | `pr` = fs apply + branch + commit of exactly the touched paths (no push); see [apply.md](apply.md#pr-mode) |
| `status` | `applied \| noop \| rolled-back \| failed` | `failed` requires `error` |
| `root` | string | absolute, realpath'd, as authorised |
| `files` | `{ path, op, digest?, status: written \| deleted \| unchanged \| skipped }[]` | empty on failure before phase 2 |
| `diff` | string | dry-run only; unified diff capped at 1 MiB |
| `journal` | string | path of `.axiom/journal/<hex>.json` when phase 2 started |
| `git` | `{ branch, commit?, compareUrl? }` | `pr` mode only |
| `drifted` | `RelPath[]` | re-apply of an already-applied digest: the artifacts whose on-disk bytes no longer matched and were re-written (a drifted `create` is committed as an overwrite, foreign bytes backed up) |
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
| `ERR_PREIMAGE_CHANGED` | the tree differs from `ManifestBody.preImage` at check/apply time (S-402, `details.phase: prepare`), or a file changed between staging and commit (TOCTOU guard) |
| `ERR_JOURNAL_CORRUPT` | journal file unreadable or fails schema |
| `ERR_EBUSY` | rename kept failing (Windows open handle) after retries |
| `ERR_INVALID_PLAN` | Plan fails schema (details carry Zod issues) |
| `ERR_INVALID_MANIFEST` | bundle fails schema |
| `ERR_INVALID_PROFILE` | profile missing, not JSON, wrong name, cycle, or fails schema |
| `ERR_PREDICATE_UNKNOWN` | `CheckRef.predicate` is not registered |
| `ERR_PREDICATE_PARAMS` | `CheckRef.params` fail the predicate's schema |
| `ERR_PROVIDER_FAILED` | a fact provider or predicate threw |
| `ERR_GUARD_TIMEOUT` | external guard exceeded `timeoutMs` |
| `ERR_GUARD_OUTPUT` | external guard stdout was not a valid `GuardOutput` |
| `ERR_TASK_NOT_FOUND` | `taskId` / `sessionId` unknown to this server process (never created, expired after its TTL, or already consumed) — `axiom_task_get`, `axiom_task_cancel`, `axiom_plan_add`, `axiom_plan_seal` |
| `ERR_TASK_CANCELLED` | the task was cancelled (`axiom_task_cancel` / server stop); also the provider finding a killed guard reports |
| `ERR_PLAN_SESSION_STATE` | `axiom_plan_add` on a sealed session, or a chunk that would exceed the session's 2000-artifact / 64 MiB budget |
| `ERR_FACT_DISABLED` | a fact provider / predicate is disabled by the profile or a CLI gate (`guard.external` without `facts.allowGuards` + `--allow-guards`, or without a root) → `verdict: error` |
| `ERR_SIGNATURE_MISSING` | a trust store exists but the bundle carries no signature (`axiom verify --root`, `axiom_manifest_verify`) |
| `ERR_SIGNATURE_INVALID` | signature verification failed (unknown key, bad signature, non-canonical payload, rollback) or unusable key material |
| `ERR_TRUST_STATE_CORRUPT` | `.axiom/trust/state.json` is unreadable, not JSON or fails schema — never treated as "no state" |
| `ERR_ROLLBACK` | a commit failed **and** the scoped rollback failed; `status: failed`, journal left in place for `axiom rollback`; message carries both errors |
| `ERR_EMITTER_UNKNOWN` | `template` source names an emitter that is not in the compile-time registry (or no registry was given) |
| `ERR_TEMPLATE_UNKNOWN` | the emitter exists but has no template with that name |
| `ERR_TEMPLATE_PARAMS` | `template.params` fail the template's Zod schema (details carry `issues`) |
| `ERR_PATCH_FORMAT` | `patch.body` is not parseable in the declared `format` (details: `format`, `line`) |
| `ERR_PATCH_PREIMAGE` | the file under the root does not hash to `patch.preImage` (or is absent / not UTF-8 / no root given); details carry `expected`, `actual` |
| `ERR_PATCH_NO_MATCH` | a hunk's block or `@@` anchor did not match exactly once (details: `hunk`, `matches`, `searchedFromLine`, `block`) |
| `ERR_REF_OFFLINE` | `ref` source compiled without a root, or applied while its blob is not in the CAS |
| `ERR_NET_DISABLED` | `ref` not in the CAS and `--allow-net` not given (details: `host`, redacted `uri`) |
| `ERR_NET_DENIED` | `ref` refused by policy: not `https:` (`file:` without `--allow-file`), credentials in the URI, host not in `--net-allow` |
| `ERR_NET_FAILED` | `ref` fetch failed: timeout, redirect, network error, non-2xx (`status`) |
| `ERR_NOT_CANONICAL` | manifest not sorted/unique, or `manifestDigest` does not match the recomputed hash |
| `ERR_UNSUPPORTED_OP` | an operation the engine does not implement (`axiom_repo_snapshot` with `followSymlinks: true`) |
| `ERR_INTERNAL` | invariant violation inside AXIOM; please report |
