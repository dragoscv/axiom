# Error codes

*Every member of the closed `ERROR_CODES` enum — what it means, which surface raises it, how it reaches you and how to fix it — plus the gate's rule codes. Branch on `code`, never on message text.*

The enum lives in `packages/schema/src/errors.ts` (`ERROR_CODES`, a readonly tuple; `AxiomError`
carries `code`, `message`, optional `path` and `details`). Adding a code means adding it there
first; the `check-error-codes` guard fails CI on any `"ERR_*"` literal elsewhere that is not in
the list, and on any code that no behavioural test asserts. Removing a code or changing which
code a failure produces is a **major** ([versioning.md](versioning.md)).

How a code reaches a caller:

| Surface | Shape |
|---|---|
| MCP tool | `isError: true` result whose text is `{ code, message, path?, details? }` — a handler never throws; `apply`/`check` failures that are *results* (`ApplyResult.error`, `Finding.facts.code`) come back as normal results with the code inside |
| CLI | result objects (`ApplyResult`, `CheckReport`) on stdout with exit `1`; every other failure is one flat JSON line on stderr, `{"code","message","details?"}`, with exit `2` ([cli.md § Errors](cli.md#errors)) |
| Library (`@codai/axiom-*`) | `AxiomError` thrown, except `apply()` which always returns an `ApplyResult` with `error.code` |
| Gate | the deny document on stdout carries `axiom.code`; stderr gets `AXIOM GATE DENY <code>: <reason>` |

"Raised by" names the package(s) whose source constructs the code (tests excluded); `mcp`
re-raises most codes on behalf of the engines and is listed only where it originates one.

## Paths and containment

Validated first by the `RelPath` schema (no I/O), then by `apply`'s containment walk against the
real filesystem, and by the gate on every write target.

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_PATH_NOT_RELATIVE_POSIX` | leading `/`, a drive letter, or a backslash in a path | schema, apply, gate, `migrate v1` | Write the path relative to the root with `/` separators. |
| `ERR_PATH_SEGMENT` | empty, `.`, `..`, trailing dot/space segment, or length out of 1–1024 | schema, apply, axm (mapped to the path literal), gate | Remove the empty, dot or trailing-space segment. |
| `ERR_PATH_NOT_NFC` | path is not NFC-normalised | schema, apply | Normalise the path to NFC. |
| `ERR_PATH_RESERVED_NAME` | a segment is a Windows device name (`CON`, `NUL`, `COM1`…) — on every OS | schema, apply, gate, `path.reservedNames` predicate | Rename the segment. |
| `ERR_PATH_INVALID_CHAR` | `<>:"\|?*`, a C0 control or DEL in a path (`:` also rules out NTFS alternate data streams) | schema, apply, gate | Remove the character from the path. |
| `ERR_PATH_CASE_COLLISION` | for any op: two artifacts differ only by case or Unicode normalisation (`details.other`), or an artifact collides with an existing on-disk sibling (`details.existing`, `details.kind: "case" \| "normalization"`). Normalisation twins are refused even on a case-sensitive filesystem | apply | Use the exact on-disk spelling, or rename one of the two. |
| `ERR_PATH_RESERVED_DIR` | the first segment is `.axiom` in any case or normalisation, or the target's resolved parent lies inside realpath(`<root>/.axiom`) — which catches aliases such as the 8.3 name `AXIOM~1`. `details.via: "name" \| "realpath"`. Also a journal step that targets `.axiom/` | apply | Write outside `.axiom/`; change policy files by hand, not through a manifest. |
| `ERR_SYMLINK_IN_PATH` | a symlink or junction in the target's ancestry, or where a file is expected in `verify --tree` | apply, gate, snapshot | Write to the real path, or remove the link. |
| `ERR_CONTAINMENT` | realpath of the target's directory is outside the root; a snapshot glob containing `..` | apply, gate, snapshot | Target a path inside the root, or set gate `outside` if writes elsewhere are intended. |
| `ERR_TARGET_TYPE` | target exists but is a directory or symlink | apply | Remove or rename the directory or link first. |
| `ERR_EXISTS` | `op: create` but the target exists (and no applied marker makes it a re-apply) | apply | Use `op: replace` with the current pre-image. |
| `ERR_NOT_FOUND` | `op: delete` on an absent path; no journal for a digest (`rollback`); trust store or keyid missing; an `axiom://` resource or stored manifest that does not exist | apply, checks (`manifest.requireSigned` provider error), mcp | Check the path, digest or key id. |

## Content and digests

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_BLOB_MISSING` | no bytes for a digest in `blobs`, the CAS or a fetched ref; a journal naming a manifest that is not stored (`gc`) | plan, apply, mcp (`gc`, `migrate v1`) | Include the blob inline or put it in the CAS before applying. |
| `ERR_DIGEST_FORMAT` | not `sha256:` + 64 lowercase hex | schema, apply, checks | Send `sha256:` followed by 64 lowercase hex characters. |
| `ERR_DIGEST_MISMATCH` | bytes do not hash to the declared digest — a blob, a CAS entry, a fetched ref, a `migrate v1` sidecar | plan, apply, mcp | Recompute the digest from the actual bytes; treat a CAS mismatch as corruption. |
| `ERR_SIZE_MISMATCH` | decoded size differs from `bytes` | apply, checks | Recompile so `bytes` matches the content. |
| `ERR_BLOB_TOO_LARGE` | a single inline blob (or rendered template, or ref body) exceeds its cap — 256 KiB inline, 32 MiB ref | plan, apply, `migrate v1` | Move the content to the CAS or a pinned `ref`. |
| `ERR_BUNDLE_TOO_LARGE` | inline blobs total more than 4 MiB; also any MCP call body over 4 MiB | plan, mcp | Compile with `store: "cas"` or split the plan into chunks. |

## Apply and roots

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_LOCKED` | `.axiom/lock` held by a live process after the wait in the FIFO queue (`.axiom/queue/`) — apply default 30 s, `--lock-timeout` / `lockTimeoutMs` 0–600 000 ms; `gc` 1 s. `details: { holder?: { pid, host, digest, since }, waitedMs, queuePosition, lock }` (`queuePosition` 1-based). Also the intent registry mutex staying busy > 10 s (`details: { lock }`). A dead or > 1 h old holder is reclaimed automatically | apply, mcp (`gc`) | See the holder with `axiom journal status`, then retry with a longer `--lock-timeout`. |
| `ERR_CONFLICT` | before queueing for the lock, a live intent (`.axiom/intents/`) of a **different** manifest on the same root touches an overlapping path — the same path, or one is a directory prefix of the other (case-insensitive on Windows/macOS). `details: { otherDigest, paths[] }` (sorted); nothing is registered or written. Never raised by a dry-run or a re-apply of the same digest | apply | Wait for `otherDigest` to finish, recompile against the new tree, apply again. |
| `ERR_ROOT_NOT_ALLOWED` | requested root is not equal to or inside a `--root` | mcp (roots policy — shared by CLI and server) | Start the server with that `--root`, or pick an allowed root. |
| `ERR_ROOT_REQUIRED` | no `root` given and zero or several roots are allowlisted | mcp | Pass `root` explicitly. |
| `ERR_ROOT_NOT_DIR` | root does not exist or is not a directory | mcp, apply | Point `root` at an existing directory. |
| `ERR_CONFIRM_DIGEST_MISMATCH` | `confirmDigest !== bundle.manifestDigest` | apply, CLI `plan apply --confirm` | Run the dry-run and pass its `manifestDigest` as the confirm digest. |
| `ERR_CHECKS_FAILED` | pre-apply check verdict was not `pass` (`fail` **or** `error`) | apply | Read the findings, fix the change set or the policy, recompile. |
| `ERR_PREIMAGE_CHANGED` | the tree differs from `ManifestBody.preImage` at check/first-apply time (`details.phase: "prepare"`); a file changed between staging and commit (TOCTOU guard, no phase); or `rollback` found a written file edited since the apply (`details.phase: "rollback"`, `expected`, `actual`, `drifted[]`) — rollback refuses unless the library option `force: true` is passed (the CLI `journal rollback` has no force flag) | apply, checks (`manifest.preImage` finding), plan | Recompile against the current tree; for rollback, save the newer edits first. |
| `ERR_JOURNAL_CORRUPT` | journal file unreadable, not JSON or fails schema; or a journal step whose path, or whose backup, fails containment — a backup must be exactly `.axiom/backup/<own digest hex>/<step path>`. Refused before anything moves; crash recovery skips such a journal instead of acting on it | apply | Inspect `.axiom/journal/` (skill `debug-apply-journal`); treat a forged step as tampering. |
| `ERR_JOURNAL_CHAIN` | the journal hash chain `.axiom/journal/chain.jsonl` does not verify — a line was edited, removed, reordered, or its tail is torn. `details: { seq, reason: prev-mismatch\|seq-gap\|parse, file, entries? }`. `axiom journal verify` exits `1` with `firstBad`; `setup doctor` fails its `chain` check; `appendChainEntry` refuses to extend a broken chain (an apply still succeeds, its entry is just not appended) | apply, mcp (`journal verify`) | Treat as tampering or a torn write; compare the line at `seq` with the journals and backups before trusting the history. |
| `ERR_EBUSY` | rename/unlink kept failing (Windows open handle) after 5 retries; also more than 8 concurrent tasks or 16 open plan sessions on the server | apply, mcp (tasks) | Close the program holding the file, or wait for running tasks, then retry. |
| `ERR_ROLLBACK` | a commit failed **and** the scoped rollback failed (`status: failed`, journal left in place, message carries both errors); or a rollback was refused before anything moved because a needed pre-image backup is missing (pruned or deleted; `details.reason: "backup-missing"`) | apply | Restore the listed files from git or the backup set; keep backups for manifests you may roll back. |

## Schema

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_INVALID_PLAN` | Plan fails `PlanSchema` (details carry Zod issues with JSON pointers); a `.axm` semantic error; duplicate path across `axiom_plan_add` chunks or after `migrate v1` normalisation | plan, axm, mcp | Fix the field at the reported JSON pointer. |
| `ERR_INVALID_MANIFEST` | bundle fails `ManifestBundleSchema`; a stored manifest that fails it (`gc`); not a v1 manifest (`migrate v1`) | plan, apply, mcp | Recompile the plan; do not hand-edit bundles. |
| `ERR_INVALID_PROFILE` | a check profile, a gate profile or `.axiom/axiom.json` cannot be used: missing (an explicit `--profile`), not JSON, fails its schema, `name` ≠ file stem, bad profile name, `extends` cycle, depth over 8, missing parent, unreadable or out-of-tree extends file, unknown `axiom:` pack, npm pack not installed. Never covered by the gate's `--fail-open` | checks, mcp (gate, axiom.json loader) | Fix the file named in the message; see [profiles.md](profiles.md). |
| `ERR_PROFILE_VERSION` | a policy file declares a `version` above what this binary understands (3). Never covered by `--fail-open` | mcp (gate, axiom.json loader) | Upgrade the `axiom` bin. |

## Checks

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_PREDICATE_UNKNOWN` | `CheckRef.predicate` is not registered | checks | Use a predicate listed in [checks.md](../guides/checks.md). |
| `ERR_PREDICATE_PARAMS` | `CheckRef.params` fail the predicate's schema; a CEL function outside the allowlist or an unsafe regex; a Cedar parse error, template or > 256 policies; a guard command that resolves outside `<root>/scripts/` or the allowlist | checks | Fix the params against the predicate's schema. |
| `ERR_PROVIDER_FAILED` | a fact provider or predicate threw; CEL/Cedar evaluation error or time budget exceeded; `cedar-wasm` not installed; unreadable trust store | checks | Install the missing optional dependency or fix the input the provider reads. |
| `ERR_GUARD_TIMEOUT` | an external guard exceeded `timeoutMs` (≤ 15 min); process tree killed | checks | Speed up the guard or raise `timeoutMs`; run long suites as tasks. |
| `ERR_GUARD_OUTPUT` | guard stdout was not a valid `GuardOutput` JSON object, or the process could not be spawned | checks | Make the guard print one `GuardOutput` JSON object on stdout. |
| `ERR_FACT_DISABLED` | a provider/predicate is disabled by the profile or a CLI gate — `guard.external` without `facts.allowGuards` **and** `--allow-guards`; a repo-needing predicate with no root — yields `verdict: error` | checks | Enable both switches, or pass a root. |

## Signing and trust

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_SIGNATURE_MISSING` | a trust store exists but the bundle carries no signature at all (`axiom plan verify --root`, `axiom_manifest_verify`) | mcp (`keys.ts`), canon | Sign the bundle with a trusted key. |
| `ERR_SIGNATURE_INVALID` | signature verification failed — unknown key, bad signature, non-canonical payload, payload/digest mismatch, rollback, unbound/mis-bound envelope — or unusable key material (`sign`, `trust add`) | mcp, canon, checks | Re-sign with a key in the trust store; never edit a signed bundle. |
| `ERR_KEYLESS_UNAVAILABLE` | Sigstore keyless signing or verification **could not run** (fail closed, never a pass). `details.reason`: `NO_OIDC` (no `SIGSTORE_ID_TOKEN` / GitHub Actions OIDC env), `SIGN_FAILED` (Fulcio/Rekor/network), `MODULE_MISSING` / `MODULE_LOAD_FAILED` / `MODULE_SHAPE` (optional `sigstore` dependency absent or unusable); on verify also `TRUSTED_ROOT` (TUF trusted root unavailable, e.g. empty cache with `offline: true`) or `VERIFY_FAILED`. The CLI prints it on stdout and exits `1`; `manifest.requireSigned { keyless }` turns it into a provider finding (`facts.code`, `facts.reason`) → verdict `error` | checks, mcp (keyless sign) | Run in CI with `id-token: write`, install `sigstore`, or warm the TUF cache. |
| `ERR_TRUST_STATE_CORRUPT` | `.axiom/trust/state.json` unreadable, not JSON, fails schema, or its HMAC is missing/wrong while `state.key` exists — never treated as "no state" | checks, mcp, apply | Investigate tampering, then rebuild the trust state from a known-good copy. |

## Template sources

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_EMITTER_UNKNOWN` | `template.emitter` is not in the compile-time registry, or no registry was given (`details.available`) | plan | Load the emitter (`--emitter`) or pick one from `details.available`. |
| `ERR_TEMPLATE_UNKNOWN` | the emitter has no template of that name (`details.available`) | plan, emitters-web | Pick a template from `details.available`. |
| `ERR_TEMPLATE_PARAMS` | `template.params` fail the template's Zod schema (`details.issues`) | plan, emitters-web | Fix the params listed in `details.issues`. |

## Patch sources

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_PATCH_FORMAT` | `patch.body` is not parseable in the declared `format` (`details.format`, `line`) | plan, axm | Fix the patch body at `line`, or declare the right `format`. |
| `ERR_PATCH_PREIMAGE` | the file under the root does not hash to `patch.preImage`, is absent, is not UTF-8, or no root was given (`details.expected`, `actual`) | plan | Re-read the file and regenerate the patch against it. |
| `ERR_PATCH_NO_MATCH` | a hunk's block or `@@` anchor did not match exactly once (`details.hunk`, `matches`, `searchedFromLine`, `block`) | plan | Add context lines until the block matches exactly once. |

## Git (PR mode)

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_GIT_NOT_FOUND` | no `git` on `PATH` | apply | Install git or add it to `PATH`. |
| `ERR_GIT_NOT_REPO` | `git rev-parse --show-toplevel` is not the root itself (a subdirectory of a repo is rejected on purpose) | apply | Pass the repository's top-level directory as root. |
| `ERR_GIT_DIRTY` | `git status --porcelain -- <touched paths>` is not empty (`details` lists them) | apply | Commit or move away the listed changes first. |
| `ERR_GIT_BRANCH_EXISTS` | `refs/heads/<branch>` already exists | apply | Choose another branch name. |
| `ERR_GIT_BRANCH_INVALID` | branch name fails the regex or `git check-ref-format --branch`; no git process is spawned for syntactic rejects | apply | Use a valid branch name. |
| `ERR_GIT_FAILED` | any git call exited non-zero or timed out (60 s); first stderr line in the message, last 4 KiB in `details.stderr` | apply | Read `details.stderr` and fix the git state. |

## Tasks and chunked plans

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_TASK_NOT_FOUND` | `taskId` / `sessionId` unknown to this server process — never created, expired after its TTL (10 min tasks, 30 min idle sessions), or already consumed | mcp | Start a new task or session. |
| `ERR_TASK_CANCELLED` | the task was cancelled (`axiom_task_cancel` or server stop); also the provider finding a killed guard reports | mcp, checks | Start the task again. |
| `ERR_PLAN_SESSION_STATE` | `axiom_plan_add` on a sealed session, or a chunk that would exceed the session's 2000-artifact / 64 MiB budget | mcp | Open a new session, or split the plan. |

## Transport and network

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_REF_OFFLINE` | a `ref` source compiled without a root, or applied while its blob is not in the CAS | plan, apply | Compile with a root so the ref lands in the CAS. |
| `ERR_NET_DISABLED` | ref not in the CAS and `--allow-net` not given (`details.host`, redacted `uri`) | plan | Pass `--allow-net` (and `--net-allow <host>`), or pre-fill the CAS. |
| `ERR_NET_DENIED` | ref refused by policy: not `https:` (`file:` without `--allow-file`), credentials in the URI, host not in `--net-allow` | plan | Use an `https:` URI without credentials on an allowed host. |
| `ERR_NET_FAILED` | ref fetch failed: timeout, redirect, network error, non-2xx (`details.status`) | plan | Check the URL and network, then retry. |
| `ERR_DAEMON_AUTH` | the resident gate daemon's answer could not be authenticated — a missing or invalid response MAC over the client's nonce (someone else answered on the daemon port), or a state file from a dead pid. By default the client warns on stderr and decides in-process; with `AXIOM_GATE_DAEMON_STRICT=1` it is a fail-closed deny with this code | mcp (daemon client) | Restart `axiom hook daemon`, or remove a stale `~/.axiom/daemon.json`. |

## Canonical form and catch-alls

| Code | Meaning | Raised by | Fix |
|---|---|---|---|
| `ERR_NOT_CANONICAL` | manifest artifacts/checks not sorted or not unique, or `manifestDigest` ≠ recomputed hash | plan (`verifyBundle`), apply | Recompile; do not hand-edit bundles. |
| `ERR_USAGE` | command-line usage error — unknown command or option, missing argument, bad flag value. Exit `2`; with `--json` the flat envelope carries `details.usage` and `details.help` ([cli.md § Errors](cli.md#errors)) | mcp (CLI) | Run `axiom <command> --help` and correct the invocation. |
| `ERR_UNSUPPORTED_OP` | an operation the engine does not implement (`axiom_repo_snapshot` with `followSymlinks: true`); in the gate, a write tool whose target cannot be determined | mcp (snapshot, gate) | Use a supported option; for the gate, report the tool's path key. |
| `ERR_INTERNAL` | invariant violation inside AXIOM — a result that fails its own schema, content that vanished between hash and write, a predicate registered twice, a bad `--http` spec or short token; in the gate, any internal failure (fail-closed) | all | Report it with `details`. |

> [!NOTE]
> Other `ERR_`-prefixed strings in the source are **not** AXIOM codes: Node's
> `ERR_PARSE_ARGS_*` is surfaced as `ERR_USAGE`, and `ERR_MODULE_NOT_FOUND` /
> `ERR_UNKNOWN_BUILTIN_MODULE`, which `expr.cedar` catches when `cedar-wasm` is absent, become
> `ERR_PROVIDER_FAILED`.

## Gate rule codes

Gate denies, asks and journal lines (`.axiom/decisions.jsonl`) use predicate-style rule codes,
not `ERR_*`. They appear as `axiom.code` in the deny document, in the stderr line, and in
`hard` lists. Configuration: [profiles.md § Gate keys](profiles.md#gate-keys).

| Code | Raised when | Fix |
|---|---|---|
| `path.deny` | a target matches a gate `deny` glob | Write elsewhere, or change the policy by hand. |
| `path.allow` | `allow` is set and a target matches none of its globs | Write inside the allowed globs. |
| `path.ask` | a target matches an `ask` glob (the human confirms) | Wait for the human's decision. |
| `content.noSecrets.<rule>` | supplied content contains a secret (`privateKey`, `awsKey`, `githubToken`, `jwt`, `slackToken`, `credentialAssignment`) or, with `pii`, personal data (`email`, `phoneRo`, `cnp`, `card`) | Remove the value; load it from the environment. |
| `content.maxBytes` | supplied content exceeds `maxBytes` | Split the file or write it through a manifest. |
| `steer.requireApply` | `steer: "require"` and a direct write touches `steerGlobs` | Write through `axiom_write`. |
| `command.deny` | a `commands.deny` rule without its own `id` matched | Use the rule's `fix`. |
| `house.*` | a [house pack](profiles.md#commands) rule matched: `gitAddAll`, `gitCommitAll`, `forcePush`, `pushDelete`, `resetHard`, `cleanForce`, `checkoutDiscard`, `restore`, `stashFlagsAfterDashDash`, `stashDrop`, `stashBare`, `sqlDestructive`, `sqlDeleteAll`, `rmRoot`, `removeItemRoot`, `commitNoPathspec`, `worktreeRemoveForce`, `worktreeRawRemove`, `worktreeRawAdd`, `playwrightLocal`, `buildUnqueued`, `undecodable` (ask) | Run the `fix` the deny shows, or ask the human. |
| `command.deployNeedsCleanTree` | a deploy or release command runs while the tree has uncommitted changes, outside `deploy-clean.ps1` | Commit, push, then deploy through `deploy-clean.ps1`. |
| `git.destructiveTree` | a shell command targets the whole tree — `git clean`, `git reset --hard`, or a write command with `.` as operand (`git rm -r --cached .`, `find . -delete`) — while the policy has any `deny` glob or `commands`; hard whenever `house.resetHard` or `house.cleanForce` is hard | Name explicit paths, or ask the human. |
| `git.dirtyTree` | a command of a `git.cleanTreeFor` class runs on a dirty tree, or the git state cannot be read | Commit first, then run from a clean checkout. |
| `git.noPathspec` | `git.requirePathspec` and a `git commit` has no ` -- <path>` | Add ` -- <path> …` to the commit. |
| `git.branch` | a command of a `git.branch.for` class runs on a branch not matching `git.branch.is` | Switch to the required branch. |
| `session.foreignWrite` | the file was written by another agent session within `sessions.windowMin` | Coordinate with that session, or re-read and retry later. |
| `blind.overwrite` | a whole-file overwrite of a file this session never read | Read the file first, then edit it. |
| `blind.staleScript` | running a script another session changed since this session last saw it | Re-read the script before running it. |
| `sessions.budget` | the session exceeded `sessions.budget.maxFiles` or `maxDeletes` within the window | Ask the human, or wait for the window to pass. |
| `coord.frozen` | a mark in `coordination.marksDir` freezes or blocks the resource | Wait until the mark is cleared. |
| `coord.leased` | the worktree slot is leased by someone else | Lease your own slot. |
| `coord.queueRequired` | a command of a `queueRequired` class runs outside its `via` wrapper | Run it through the wrapper named in `fix`. |

## Finding ids are not error codes

A `CheckReport` finding's `id` is the check's id (`path.deny`, `content.noSecrets.awsKey`,
`signature.rollback`, `repo.requireCompanion.<name>`, `brivio.<guard>`…), not an `ERR_*`. Only
provider failures carry an error code, in `facts.code` with `facts.__provider: true`. The gate's
stderr line uses whichever applies. Catalogue: [checks.md](../guides/checks.md).

---

**See also**

- [Plan format](plan-format.md) — the schemas whose violations produce the `ERR_INVALID_*` and `ERR_PATH_*` codes
- [Apply](../guides/apply.md) — the failure modes behind the apply codes
- [Profiles](profiles.md) — the policy files behind the gate rule codes
- [Invariants](../concepts/invariants.md) — invariant 4, why the enum is closed
- [Versioning](versioning.md) — an error-code change is a major
