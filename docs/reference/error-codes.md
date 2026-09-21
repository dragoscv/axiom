# Error codes

*Every member of the closed `ERROR_CODES` enum — what it means, which surface raises it, and how it reaches you. Branch on `code`, never on message text.*

The enum lives in `packages/schema/src/errors.ts` (`ERROR_CODES`, a readonly tuple; `AxiomError`
carries `code`, `message`, optional `path` and `details`). Adding a code means adding it there
first; the `check-error-codes` guard fails CI on any `"ERR_*"` literal elsewhere that is not in
the list, and on any code that no behavioural test asserts. Removing a code or changing which
code a failure produces is a **major** ([versioning.md](versioning.md)).

How a code reaches a caller:

| Surface | Shape |
|---|---|
| MCP tool | `isError: true` result whose text is `{ code, message, path?, details? }` — a handler never throws; `apply`/`check` failures that are *results* (`ApplyResult.error`, `Finding.facts.code`) come back as normal results with the code inside |
| CLI | result objects (`ApplyResult`, `CheckReport`) on stdout with exit `1`; everything else `{ error: { code, message, details? } }` with exit `2` |
| Library (`@codai/axiom-*`) | `AxiomError` thrown, except `apply()` which always returns an `ApplyResult` with `error.code` |
| Gate | `AXIOM GATE DENY <code>: <reason>` on stderr, `axiom.code` in the stdout JSON |

"Raised by" below names the package(s) whose source constructs the code (from
`rg 'ERR_' packages/*/src`, tests excluded); `mcp` re-raises most codes on behalf of the engines
and is listed only where it originates one.

## Paths and containment

Validated first by the `RelPath` schema (no I/O), then by `apply`'s containment walk against the
real filesystem, and by the gate on every write target.

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_PATH_NOT_RELATIVE_POSIX` | leading `/`, a drive letter, or a backslash in a path | schema, apply, gate, `migrate v1` |
| `ERR_PATH_SEGMENT` | empty, `.`, `..`, trailing dot/space segment, or length out of 1–1024 | schema, apply, axm (mapped to the path literal), gate |
| `ERR_PATH_NOT_NFC` | path is not NFC-normalised | schema, apply |
| `ERR_PATH_RESERVED_NAME` | a segment is a Windows device name (`CON`, `NUL`, `COM1`…) — on every OS | schema, apply, gate, `path.reservedNames` predicate |
| `ERR_PATH_INVALID_CHAR` | `<>:"\|?*`, a C0 control or DEL in a path (`:` also rules out NTFS alternate data streams) | schema, apply, gate |
| `ERR_PATH_CASE_COLLISION` | two artifacts (or an artifact and an existing file on a case-insensitive FS) differ only by case | apply |
| `ERR_SYMLINK_IN_PATH` | a symlink or junction in the target's ancestry, or where a file is expected in `verify --tree` | apply, gate, snapshot |
| `ERR_CONTAINMENT` | realpath of the target's directory is outside the root; a snapshot glob containing `..` | apply, gate, snapshot |
| `ERR_TARGET_TYPE` | target exists but is a directory or symlink | apply |
| `ERR_EXISTS` | `op: create` but the target exists (and no applied marker makes it a re-apply) | apply |
| `ERR_NOT_FOUND` | `op: delete` on an absent path; no journal for a digest (`rollback`); trust store or keyid missing; an `axiom://` resource or stored manifest that does not exist | apply, checks (`manifest.requireSigned` provider error), mcp |

## Content and digests

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_BLOB_MISSING` | no bytes for a digest in `blobs`, the CAS or a fetched ref; a journal naming a manifest that is not stored (`gc`) | plan, apply, mcp (`gc`, `migrate v1`) |
| `ERR_DIGEST_FORMAT` | not `sha256:` + 64 lowercase hex | schema, apply, checks |
| `ERR_DIGEST_MISMATCH` | bytes do not hash to the declared digest — a blob, a CAS entry, a fetched ref, a `migrate v1` sidecar | plan, apply, mcp |
| `ERR_SIZE_MISMATCH` | decoded size differs from `bytes` | apply, checks |
| `ERR_BLOB_TOO_LARGE` | a single inline blob (or rendered template, or ref body) exceeds its cap — 256 KiB inline, 32 MiB ref | plan, apply, `migrate v1` |
| `ERR_BUNDLE_TOO_LARGE` | inline blobs total more than 4 MiB; also any MCP call body over 4 MiB | plan, mcp |

## Apply and roots

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_LOCKED` | `.axiom/lock` held by a live process after the wait (30 s for apply, 1 s for `gc`); `details.holder` names it | apply, mcp (`gc`) |
| `ERR_ROOT_NOT_ALLOWED` | requested root is not equal to or inside a `--root` | mcp (roots policy — shared by CLI and server) |
| `ERR_ROOT_REQUIRED` | no `root` given and zero or several roots are allowlisted | mcp |
| `ERR_ROOT_NOT_DIR` | root does not exist or is not a directory | mcp, apply |
| `ERR_CONFIRM_DIGEST_MISMATCH` | `confirmDigest !== bundle.manifestDigest` | apply, CLI `apply --confirm` |
| `ERR_CHECKS_FAILED` | pre-apply check verdict was not `pass` (`fail` **or** `error`) | apply |
| `ERR_PREIMAGE_CHANGED` | the tree differs from `ManifestBody.preImage` at check/first-apply time (`details.phase: "prepare"`), or a file changed between staging and commit (TOCTOU guard, no phase) | apply, checks (`manifest.preImage` finding), plan |
| `ERR_JOURNAL_CORRUPT` | journal file unreadable, not JSON or fails schema | apply |
| `ERR_EBUSY` | rename/unlink kept failing (Windows open handle) after 5 retries; also more than 8 concurrent tasks or 16 open plan sessions on the server | apply, mcp (tasks) |
| `ERR_ROLLBACK` | a commit failed **and** the scoped rollback failed; `status: failed`, journal left in place; message carries both errors | apply |

## Schema

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_INVALID_PLAN` | Plan fails `PlanSchema` (details carry Zod issues with JSON pointers); a `.axm` semantic error; duplicate path across `axiom_plan_add` chunks or after `migrate v1` normalisation | plan, axm, mcp |
| `ERR_INVALID_MANIFEST` | bundle fails `ManifestBundleSchema`; a stored manifest that fails it (`gc`); not a v1 manifest (`migrate v1`) | plan, apply, mcp |
| `ERR_INVALID_PROFILE` | profile missing, not JSON, `name` ≠ file stem, `extends` cycle or missing parent, or fails schema; bad profile name | checks |

## Checks

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_PREDICATE_UNKNOWN` | `CheckRef.predicate` is not registered | checks |
| `ERR_PREDICATE_PARAMS` | `CheckRef.params` fail the predicate's schema; a CEL function outside the allowlist or an unsafe regex; a Cedar parse error, template or > 256 policies; a guard command that resolves outside `<root>/scripts/` or the allowlist | checks |
| `ERR_PROVIDER_FAILED` | a fact provider or predicate threw; CEL/Cedar evaluation error or time budget exceeded; `cedar-wasm` not installed; unreadable trust store | checks |
| `ERR_GUARD_TIMEOUT` | an external guard exceeded `timeoutMs` (≤ 15 min); process tree killed | checks |
| `ERR_GUARD_OUTPUT` | guard stdout was not a valid `GuardOutput` JSON object, or the process could not be spawned | checks |
| `ERR_FACT_DISABLED` | a provider/predicate is disabled by the profile or a CLI gate — `guard.external` without `facts.allowGuards` **and** `--allow-guards`; a repo-needing predicate with no root — yields `verdict: error` | checks |

## Signing and trust

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_SIGNATURE_MISSING` | a trust store exists but the bundle carries no signature at all (`axiom verify --root`, `axiom_manifest_verify`) | mcp (`keys.ts`), canon |
| `ERR_SIGNATURE_INVALID` | signature verification failed — unknown key, bad signature, non-canonical payload, payload/digest mismatch, rollback, unbound/mis-bound envelope — or unusable key material (`sign`, `trust add`) | mcp, canon, checks |
| `ERR_TRUST_STATE_CORRUPT` | `.axiom/trust/state.json` unreadable, not JSON, fails schema, or its HMAC is missing/wrong while `state.key` exists — never treated as "no state" | checks, mcp, apply |

## Template sources

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_EMITTER_UNKNOWN` | `template.emitter` is not in the compile-time registry, or no registry was given (`details.available`) | plan |
| `ERR_TEMPLATE_UNKNOWN` | the emitter has no template of that name (`details.available`) | plan, emitters-web |
| `ERR_TEMPLATE_PARAMS` | `template.params` fail the template's Zod schema (`details.issues`) | plan, emitters-web |

## Patch sources

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_PATCH_FORMAT` | `patch.body` is not parseable in the declared `format` (`details.format`, `line`) | plan, axm |
| `ERR_PATCH_PREIMAGE` | the file under the root does not hash to `patch.preImage`, is absent, is not UTF-8, or no root was given (`details.expected`, `actual`) | plan |
| `ERR_PATCH_NO_MATCH` | a hunk's block or `@@` anchor did not match exactly once (`details.hunk`, `matches`, `searchedFromLine`, `block`) | plan |

## Git (PR mode)

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_GIT_NOT_FOUND` | no `git` on `PATH` | apply |
| `ERR_GIT_NOT_REPO` | `git rev-parse --show-toplevel` is not the root itself (a subdirectory of a repo is rejected on purpose) | apply |
| `ERR_GIT_DIRTY` | `git status --porcelain -- <touched paths>` is not empty (`details` lists them) | apply |
| `ERR_GIT_BRANCH_EXISTS` | `refs/heads/<branch>` already exists | apply |
| `ERR_GIT_BRANCH_INVALID` | branch name fails the regex or `git check-ref-format --branch`; no git process is spawned for syntactic rejects | apply |
| `ERR_GIT_FAILED` | any git call exited non-zero or timed out (60 s); first stderr line in the message, last 4 KiB in `details.stderr` | apply |

## Tasks and chunked plans

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_TASK_NOT_FOUND` | `taskId` / `sessionId` unknown to this server process — never created, expired after its TTL (10 min tasks, 30 min idle sessions), or already consumed | mcp |
| `ERR_TASK_CANCELLED` | the task was cancelled (`axiom_task_cancel` or server stop); also the provider finding a killed guard reports | mcp, checks |
| `ERR_PLAN_SESSION_STATE` | `axiom_plan_add` on a sealed session, or a chunk that would exceed the session's 2000-artifact / 64 MiB budget | mcp |

## Transport and network

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_REF_OFFLINE` | a `ref` source compiled without a root, or applied while its blob is not in the CAS | plan, apply |
| `ERR_NET_DISABLED` | ref not in the CAS and `--allow-net` not given (`details.host`, redacted `uri`) | plan |
| `ERR_NET_DENIED` | ref refused by policy: not `https:` (`file:` without `--allow-file`), credentials in the URI, host not in `--net-allow` | plan |
| `ERR_NET_FAILED` | ref fetch failed: timeout, redirect, network error, non-2xx (`details.status`) | plan |

## Canonical form and catch-alls

| Code | Meaning | Raised by |
|---|---|---|
| `ERR_NOT_CANONICAL` | manifest artifacts/checks not sorted or not unique, or `manifestDigest` ≠ recomputed hash | plan (`verifyBundle`), apply |
| `ERR_UNSUPPORTED_OP` | an operation the engine does not implement (`axiom_repo_snapshot` with `followSymlinks: true`); in the gate, a write tool whose target cannot be determined | mcp (snapshot, gate) |
| `ERR_INTERNAL` | invariant violation inside AXIOM — a result that fails its own schema, content that vanished between hash and write, a predicate registered twice, a bad `--http` spec or short token; in the gate, any internal failure (fail-closed). Please report with `details` | all |

> [!NOTE]
> Two other `ERR_`-prefixed strings appear in the source and are **not** AXIOM codes: Node's
> `ERR_PARSE_ARGS_*` (surfaced as a usage error, exit 2) and `ERR_MODULE_NOT_FOUND` /
> `ERR_UNKNOWN_BUILTIN_MODULE`, which `expr.cedar` catches when `cedar-wasm` is absent and turns
> into `ERR_PROVIDER_FAILED`.

## Finding ids are not error codes

A `CheckReport` finding's `id` is the check's id (`path.deny`, `content.noSecrets.awsKey`,
`signature.rollback`, `repo.requireCompanion.<name>`, `brivio.<guard>`…), not an `ERR_*`. Only
provider failures carry an error code, in `facts.code` with `facts.__provider: true`. The gate's
stderr line uses whichever applies. Catalogue: [checks.md](../guides/checks.md).

---

**See also**

- [Plan format](plan-format.md) — the schemas whose violations produce the `ERR_INVALID_*` and `ERR_PATH_*` codes
- [Apply](../guides/apply.md) — the failure modes behind the apply codes
- [Invariants](../concepts/invariants.md) — invariant 4, why the enum is closed
- [Versioning](versioning.md) — an error-code change is a major
