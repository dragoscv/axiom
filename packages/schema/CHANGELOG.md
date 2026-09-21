# @codai/axiom-schema

## 2.2.1

No changes in this release.

## 2.2.0

### Minor Changes

- 801d29e: Idempotency and error-code hygiene (S-407).
  
  - **apply**: re-applying an already-applied digest whose files drifted now
    proceeds for `create` artifacts too (committed as an overwrite, foreign bytes
    backed up) instead of failing `ERR_EXISTS`; the re-written paths are reported
    in the new `ApplyResult.drifted`. A commit failure whose rollback *also* fails
    is now `error.code: ERR_ROLLBACK` (original error kept in message/details)
    instead of the original code with a concatenated message.
  - **schema**: new codes `ERR_FACT_DISABLED` (a predicate/provider disabled by
    the profile or a CLI gate — previously overloaded onto `ERR_UNSUPPORTED_OP`)
    and `ERR_TRUST_STATE_CORRUPT` (`.axiom/trust/state.json` unreadable/invalid —
    previously reused `ERR_JOURNAL_CORRUPT`). `ERR_UNSUPPORTED_OP` now means only
    "operation not implemented" (`axiom_repo_snapshot followSymlinks`).
  - **checks**: `guard.external` gating findings carry `ERR_FACT_DISABLED`;
    trust-state read/parse failures carry `ERR_TRUST_STATE_CORRUPT`.
  - **mcp**: `axiom_manifest_verify` / `axiom verify --root` add
    `signatures.code` (`ERR_SIGNATURE_MISSING` when the bundle has no signature,
    `ERR_SIGNATURE_INVALID` otherwise); a non-JSON `state.json` is
    `ERR_TRUST_STATE_CORRUPT`, not a raw `SyntaxError`.
  - Repo guard `check-error-codes` now fails when any enum member is never raised
    in `src` or never asserted in a behavioural test; behavioural tests added for
    `ERR_DIGEST_FORMAT`, `ERR_SIZE_MISMATCH`, `ERR_JOURNAL_CORRUPT` (corrupt
    journal → recovery still works), `ERR_GIT_NOT_FOUND`, `ERR_GIT_FAILED`
    (non-zero exit and timeout), `ERR_SIGNATURE_MISSING`, `ERR_ROLLBACK`.
- b51eb33: `patch` artifact source (S-401, D-17): `{ type: "patch", format: "unified" |
  "v4a" | "search-replace", preImage: "sha256:…" | "absent", body }`. Compile
  reads the file under the root, requires it to hash to `preImage`
  (`ERR_PATCH_PREIMAGE`), applies the diff with **exact** matching only
  (`ERR_PATCH_NO_MATCH`; malformed body → `ERR_PATCH_FORMAT`) and
  content-addresses the result, so Manifest, checks and apply never see a patch.
  A patch plan and its inline twin share `planDigest` (golden fixtures
  `plan-patch` / `plan-patch-inline`); `origin: "patch"` is recorded on the
  artifact. Three parsers (unified diff, OpenAI/Codex V4A `apply_patch` text for
  one file incl. `@@ context` anchors and `*** End of File`, Aider
  SEARCH/REPLACE) feed one applier. `.axm` gains
  `patch <format> ("sha256:…"|absent) <<HEREDOC`; the LSP completes and documents
  it. `CompileOptions.readPreImage` lets callers (gate, tests) supply pre-images
  without a filesystem root.
- c8de39b: Pre-image binding (S-402). `ManifestBody.preImage[]` records, for every
  artifact path, the sha256 (or `absent`) compile saw under the root — inside the
  canonical body, so the same Plan compiled against two trees yields two
  `manifestDigest`s while `planDigest` is unchanged. `runChecks` verifies it when
  given a root and reports `CheckReport.preImage: verified | drifted |
  unverified` (drift = `error` finding `manifest.preImage` with
  `ERR_PREIMAGE_CHANGED`, verdict `error`). `apply` refuses a first apply on a
  drifted tree with `ERR_PREIMAGE_CHANGED` (`details.phase: "prepare"`) before
  staging anything; re-applies of an already-applied digest are exempt.
  
  **Manifest format change**: manifests compiled with a root now carry
  `preImage`; the golden `plan-patch` digest is re-pinned. Manifests compiled
  without a root (no `preImage`) are unchanged (`plan-basic` digest identical).
- 38ff1c0: Signing hardening (S-409):
  
  - **Root-bound signatures.** New DSSE `payloadType`
    `application/vnd.axiom.manifest-bound+json` signs `JCS({ manifest, rootId })`.
    `TrustStore.rootId` (optional) makes a store accept only envelopes bound to
    that id — unbound or otherwise-bound envelopes fail with the new
    `signature.unbound` finding (`UNBOUND` / `ROOT_MISMATCH`). Stores without
    `rootId` accept both forms (unchanged behaviour). `axiom sign --root-id <id>`,
    `axiom trust root-id [<id> | --clear] --root .`; `signEnvelopeBound()` /
    `AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE` in canon, `RootIdSchema` in schema.
  - **Authenticated anti-rollback state.** `advanceTrustState` creates
    `.axiom/trust/state.key` (32 random bytes, 0600) and writes
    `state.json.mac = HMAC-SHA256(key, JCS(state))`. With a key on disk, a
    `state.json` whose MAC is missing or wrong is `ERR_TRUST_STATE_CORRUPT`
    (predicate → `verdict: error`; CLI/MCP → thrown), so `lastCounter` can no
    longer be lowered by editing the file. Roots without a key stay
    unauthenticated until their next apply. `trustStateMac()` /
    `trustStateMacOk()` / `TRUST_STATE_KEY_FILE` exported from checks.
  - `docs/signing.md`: root binding, authenticated state, and a CI key ceremony
    (`AXIOM_SIGNING_KEY` from a GitHub secret in a protected environment; the key
    never lives on a developer machine).
  - `ManifestBundle.schema.json` regenerated.
- 28a39a0: Long-running checks as tasks and chunked plan sessions (S-406, D-24):
  
  - **Tasks (mcp).** `axiom_check_start` runs the same evaluation as `axiom_check` but returns
    immediately as `{ taskId, status: "working", pollIntervalMs, ttlMs }`; `axiom_task_get` polls
    (attaching the `CheckReport` as `result` once `completed`, or `error` once `failed`/`cancelled`);
    `axiom_task_cancel` aborts a working task and kills every running guard process tree. Tasks are
    tool-level (SDK v2 has no `io.modelcontextprotocol/tasks` runtime), live in the server process,
    are shared by every connection/request a `serverFactory` serves, stay pollable 10 min after
    finishing, and are all aborted when the server stops. At most 8 run concurrently (`ERR_EBUSY`).
  - **Chunked plans (mcp).** `axiom_plan_begin` (header) → `axiom_plan_add` × n (artifact chunks,
    each call ≤ 4 MiB, unique paths across chunks) → `axiom_plan_seal` compiles the assembled Plan
    through the same code path as `axiom_plan_compile`; a fast-check property asserts the sealed
    `manifestDigest`, canonical manifest and blobs equal a one-shot compile for arbitrary plans and
    chunkings. Sessions: 2000 artifacts / 64 MiB, 30 min idle, 16 open per process.
  - **Guards (checks).** `guard.external.timeoutMs` cap raised 60 s → **15 min**;
    `RunChecksOptions.signal` / `GuardFacts.signal` abort the guard pool — a killed guard reports a
    provider finding `ERR_TASK_CANCELLED`.
  - **Error codes (schema).** New closed codes `ERR_TASK_NOT_FOUND`, `ERR_TASK_CANCELLED`,
    `ERR_PLAN_SESSION_STATE`.
  - 11 → 17 tools; `spec/tools.json`, `spec/codai-tools.json`, README and `docs/mcp_api.md` updated.

### Patch Changes

- 02527d8: Doc/code drift sweep (S-410): the `template` source is no longer described as
  "reserved for v2.1 / compile rejects" in the Plan JSON schema, the `.axm` LSP
  hover and the docs — it has been rendered by registered emitters since 2.1.0.
  `VerifyResult.signed` documents that structural verification never verifies
  signatures (use `axiom verify --root` or the `signature.*` predicates). v1-era
  docs (`ir_spec`, `plugin_api`, `reverse_ir_spec`, `MCP-ONLY-PUBLIC-SURFACE`)
  moved to `docs/archive/v1/`. New repo guard `check-stale-markers` fails on any
  forward-looking "planned for vX.Y" note whose version is already released.

## 2.1.0

### Minor Changes

- a483fe8: DSSE signing, key pinning and anti-rollback (PLAN.md S-302 / D-16) — see `docs/signing.md`.
  
  - **canon**: `signEnvelope(body, privateKey)`, `verifyEnvelope(env, trustedKeys)` →
    `{ ok, keyids, payload?, reason? }` with closed reasons `BAD_PAYLOAD_TYPE | NO_SIGNATURES |
    BAD_PAYLOAD | NOT_CANONICAL | UNKNOWN_KEY | BAD_SIGNATURE`; `keyidFor` (= hex sha256 of the raw
    32-byte public key), `generateKeyPair`, `privateKeyFrom` (base64 PKCS#8, raw seed or PEM),
    `publicKeyFrom`. Ed25519 via `node:crypto`, no dependency. Envelope payloadType
    `application/vnd.axiom.manifest+json`, payload `base64(JCS(body))`, DSSE PAE.
  - **schema**: `ManifestBundle.signatures?: ManifestSignature[]` (outside the canonical body —
    `manifestDigest` unchanged), `ManifestBody.counter?` and `Plan.counter?` (int ≥ 0, inside the
    hash), `TrustedKey`/`TrustStore` (`.axiom/trust/keys.json`) and `TrustState`
    (`.axiom/trust/state.json`) schemas. New closed error codes `ERR_SIGNATURE_MISSING`,
    `ERR_SIGNATURE_INVALID`, `ERR_ROLLBACK`. JSON schemas regenerated.
  - **plan**: `Plan.counter` is copied verbatim into `ManifestBody.counter`.
  - **checks**: `manifest.requireSigned` now verifies:
    `{ minSignatures?: 1, antiRollback?: false, trustFile?: ".axiom/trust/keys.json" }`. Findings
    `signature.missing | unknownKey | bad | notCanonical | rollback`; trust file missing/unreadable
    or no root → `verdict: error` (fail closed). Registry stays at 16 ids (the v2.0 presence-only
    stub is replaced).
  - **mcp**: CLI verbs `axiom keygen [--out <dir>] [--name]` (private key → file mode 0600, public
    entry → stdout), `axiom sign <bundle> [--key-file|$AXIOM_SIGNING_KEY] [-o]`,
    `axiom verify <bundle> --root <dir>` (also checks signatures), `axiom trust add|remove|list
    --root`. `axiom_manifest_verify` accepts `root` and reports `signatures: { trustFile, keyids,
    findings, ok }`. `axiom apply` / `axiom_apply` advance `lastCounter` only when the effective
    checks include `manifest.requireSigned { antiRollback: true }` and the result is `applied`.
  - Documented non-goal: cross-root replay is **not** prevented (root is deliberately not bound
    into the payload).
- f70b6d2: Template sources (S-207, D-13). `compilePlan(plan, { emitters })` now renders
  `{ type: "template", emitter, template, params }` sources through an injected
  `EmitterRegistry` (`createEmitterRegistry`, `TemplateEmitter`, `TemplateDef` exported from
  `@codai/axiom-plan`; `plan` gains no dependency). Rendered bytes follow the inline path; the
  manifest records `origin: "template"` and `toolchain.emitters[<id>] = <version>` so an emitter
  bump changes `manifestDigest`, while `params` are hashed into `planDigest`. New closed error codes
  `ERR_EMITTER_UNKNOWN`, `ERR_TEMPLATE_UNKNOWN`, `ERR_TEMPLATE_PARAMS` (template sources no longer
  raise `ERR_UNSUPPORTED_OP`).
  
  New package `@codai/axiom-emitters-web`: emitter `web@2.0.0` with seven small deterministic
  golden-stack templates — `next.route-handler`, `next.server-action`, `hono.route`,
  `drizzle.table`, `biome.config`, `tailwind.globals`, `readme.section` — each with strict Zod
  params, a committed golden file and a pinned cross-OS manifest digest. Not an app generator.
  
  `@codai/axiom-mcp` registers `web` in `axiom_plan_compile` / `axiom_plan_validate` and
  `axiom compile`, adds the `axiom emitters [--json]` verb and the static `axiom://emitters`
  resource. No tool input schema changed.
- 40d88ee: `ref` sources are resolved (PLAN.md S-303). `resolveRef(source, { root, allowNet, allowlist?,
  allowFile?, maxBytes?, timeoutMs?, fetchImpl? })` returns the bytes from `<root>/.axiom/cas` when
  the pinned digest is already there — no network, no policy — and otherwise fails closed with
  `ERR_NET_DISABLED` unless `allowNet`. With it: `https:` only (`file:` behind `allowFile`), no
  credentials in the URI, optional host allowlist with `*.example.com` wildcards
  (`ERR_NET_DENIED`), `redirect: "error"`, AbortController timeout, streamed download with a running
  sha256 and a hard byte cap (`ERR_BLOB_TOO_LARGE`), digest mismatch → `ERR_DIGEST_MISMATCH` and
  nothing stored, match → fsync + atomic rename into the CAS. Error details carry the URI redacted
  to origin + path. `compilePlan` gains `net?: RefNetOptions` (default offline); the manifest keeps
  `origin: "ref"` and ref bytes are never inlined into `blobs`. `apply` is unchanged: CAS or
  `ERR_REF_OFFLINE`.
  
  CLI: `axiom compile … --allow-net [--net-allow host[,host]] [--allow-file]`, and a new
  `axiom gc --root <dir> [--dry-run] [--older-than <n>(ms|s|m|h|d)] [--keep all-manifests|journal]`
  that removes CAS blobs no stored manifest references (plus stale `*.tmp`), under `.axiom/lock`
  (live holder → `ERR_LOCKED`), idempotent, reporting
  `{ scanned, live, missing, removed: [{sha, bytes}], skippedYoung, freedBytes }`. Neither is an MCP
  tool by design. New closed codes: `ERR_NET_DISABLED`, `ERR_NET_DENIED`, `ERR_NET_FAILED`. Docs:
  `docs/cas.md`, `docs/plan-format.md` § Ref sources.
- 40d88ee: `axiom_repo_snapshot` — deterministic, content-addressed inventory of a root (PLAN.md S-304) —
  see `docs/snapshot.md`. Successor of the v1 `reverse-ir`.
  
  - **schema**: `RepoSnapshotSchema` (`{ apiVersion, kind: "RepoSnapshot", root: { kind: "relative" },
    snapshotDigest, body: { files: [{ path, bytes, sha256?, mode, kind: "file"|"symlink" }],
    truncated, counts: { files, bytes } } }`), `RepoSnapshotBodySchema`, `RepoSnapshotEntrySchema`.
    `schemas/RepoSnapshot.schema.json` emitted.
  - **mcp**: READ tool `axiom_repo_snapshot { root?, include?, exclude?, maxFiles? (20000, cap 50000),
    maxBytes? (64 MiB), respectGitignore?, withContentDigest? }` → `RepoSnapshot` with
    `snapshotDigest = sha256(JCS(body))`; no timestamps or absolute paths, files sorted by
    `compareUtf8`, `.git/` and `.axiom/` always skipped, root `.gitignore` honoured, symlinks recorded
    but never followed (target hashed only when inside the root), globs containing `..` →
    `ERR_CONTAINMENT`. Truncated results are a deterministic sorted prefix. CLI verbs
    `axiom snapshot --root <dir> [-o] [--include] [--exclude] [--max-files] [--max-bytes] [--no-gitignore]
    [--no-digest]` and `axiom snapshot-diff <a.json> <b.json>` (pure `diffSnapshots` →
    `{ added, removed, changed }`). `axiom schema RepoSnapshot` and `axiom://schema/RepoSnapshot`.
    The server now exposes 11 tools.

## 2.0.0

### Minor Changes

- f2e60b0: Git PR mode (S-201, design §4.3). `apply({ mode: "pr", branch?, commitMessage? })`
  creates a branch (default `axiom/<name>/<digest12>`, deterministic), runs the
  ordinary two-phase fs apply, stages exactly the touched paths with
  `git add -- <paths>` and commits with the message on stdin (`-F -`). Every git
  call is `spawn("git", args, { shell: false })` with a scrubbed env
  (`GIT_DIR`/`GIT_WORK_TREE` dropped, `GIT_TERMINAL_PROMPT=0`); branch names are
  checked by regex and `git check-ref-format --branch`. Result carries
  `git: { branch, commit, compareUrl? }` (GitHub/GitLab compare URL from `origin`).
  No push, no PR creation, hooks honoured. New closed error codes:
  `ERR_GIT_NOT_FOUND`, `ERR_GIT_NOT_REPO`, `ERR_GIT_DIRTY`, `ERR_GIT_BRANCH_EXISTS`,
  `ERR_GIT_BRANCH_INVALID`, `ERR_GIT_FAILED`. MCP `axiom_apply` accepts
  `mode: "fs" | "pr"`, `branch`, `commitMessage`.
