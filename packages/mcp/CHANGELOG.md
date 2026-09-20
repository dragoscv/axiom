# @codai/axiom-mcp

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
- 50900d6: New predicate `expr.cedar` (S-411, D-25): Cedar policies over the same facts
  `expr.cel` sees.
  
  - **checks**: `expr.cedar { policies, mode?: "forbid" | "permit", message?,
    severity? }` runs one Cedar `isAuthorized` request per artifact — principal
    `Axiom::Plan::"<name>"`, action `Axiom::Action::"<op>"`, resource
    `Axiom::Artifact::"<path>"` (attrs `path`, `op`, `mode`, `ext`, `dir`, and
    when present `sha256`, `bytes`, `origin`, `text`, `exists`), parent
    `Axiom::Manifest::"<digest>"`, context `{ manifest, repo? }`. `mode: forbid`
    (default) appends a permit-all so every `deny` is a per-path finding;
    `mode: permit` is default-deny. Evaluated by `@cedar-policy/cedar-wasm`
    4.13 declared as an **optional** dependency and imported lazily; a host
    without it reports `ERR_PROVIDER_FAILED` (verdict `error`), never `pass`.
    Any Cedar evaluation error (missing attribute, type error, overflow) is a
    provider error — Cedar's "erroring policy does not apply" rule is not
    inherited. Templates, > 256 policies and parse errors →
    `ERR_PREDICATE_PARAMS`; 2 s wall-clock budget per manifest. 156-case
    hand-authored vector suite (`cedar-vectors.json`) + purity test.
  - **axm-lsp**: `expr.cedar` completion/hover; 17 built-ins in parity.
  - **mcp**: declares the same optional dependency so `npm i @codai/axiom-mcp`
    brings the WASM by default (`--no-optional` opts out; `expr.cedar` then
    fails closed).
  - Docs: `docs/checks.md` §expr.cedar including the OWASP Agent Control
    Standard mapping (AXIOM = Guardian on the write channel; `allow`/`deny`
    only) and why OPA/Rego was not chosen.
- 5382984: Gate v2 (S-404, D-18) — `axiom gate --stdin`:
  
  - **Fail-closed by default.** Malformed payload, empty/oversized/timed-out stdin,
    unreadable profile or any internal error now **deny** (`ERR_INTERNAL`, exit 2)
    with a reason. `--fail-open` restores the 2.1 behaviour; `--strict` is
    accepted and ignored.
  - **Unknown write → deny.** A write-class tool whose target cannot be determined
    (no recognised path key / V4A body) is denied `ERR_UNSUPPORTED_OP` instead of
    silently allowed.
  - **Shell scan.** `Bash`, `run_in_terminal`, `execute_command`, PowerShell and
    friends are scanned for write primitives (`>`, `>>`, `tee`, `rm`, `mv`, `cp`,
    `sed -i`, `dd of=`, `git checkout|restore|reset|rm|mv|stash|clean`,
    `Set-Content`/`Remove-Item`/…); their operands go through the same
    containment + profile checks. Documented heuristic; `--no-shell-scan` opts out.
  - **Root discovery.** The payload `cwd` is walked up to the nearest `.git` or
    repository `.axiom/` (never the home directory), so a sub-directory cwd still
    sees `.git/**` and `.env` in the profile and loads the repo's gate profile.
    Relative targets stay relative to `cwd`. `--no-root-discovery` opts out.
  - **One deny document** on stdout: Claude `hookSpecificOutput`, Copilot flat
    `permissionDecision`/`permissionDecisionReason`, and `axiom.verdict` in the
    OWASP Agent Control Standard v0.1 vocabulary (`allow|deny|modify|ask|defer`)
    plus `code`, `path`, `toolClass`.
  - `GateResult` gains `verdict`, `toolClass`, `root`; `extractTargets` now returns
    `{ cls, targets, undetermined }`.
  - Measured e2e p50 89 ms / p95 104 ms (15 spawns, Windows, Node 26); gate chunk
    283 KB, still SDK-free.
- 6928def: MCP SDK v2 and the 2026-07-28 protocol revision (S-405, D-19):
  
  - **SDK v2.** `@modelcontextprotocol/sdk` 1.30 → `@modelcontextprotocol/server` 2.0.0, reached
    through one seam, `src/adapter.ts` (new guard `check-sdk-adapter`: no other runtime module may
    import the SDK; tests may import `@modelcontextprotocol/client`).
  - **Two eras, one entry.** stdio is served by `serveStdio(factory)`, HTTP by `createMcpHandler`
    for 2026-07-28 requests plus the sessionful transport for 2025-era clients routed by
    `isLegacyRequest`. `axiom mcp --wire 2026|2025|2026-only` (default `2026` = both eras;
    `2026-only` refuses `initialize` openings). Clients on SDK v1 keep working unchanged.
  - **Cache hints (SEP-2549).** 2026-era `tools/list` / `resources/templates/list` /
    `server/discover` carry `ttlMs: 300000, cacheScope: "public"`; `resources/read` 24 h public
    (content-addressed); `resources/list` 10 s private. Capabilities now advertise
    `listChanged: false` (the catalogue is static).
  - **Bundle.** The SDK moved into the `mcp-lazy` / `http-lazy` chunks: eager `cli.js + cli-main.js`
    dropped from 947 KB to 453 KB (limit 950 KB); `compile`/`verify`/`gate`/`apply` never load it.
  - **Behaviour change.** An unknown tool is answered with JSON-RPC `-32602` (spec) instead of an
    `isError` result — the two conformance scenarios that passed vacuously on that
    (`tools-call-simple-text`, `tools-call-error`) moved to `baseline.yml`.
- c36c818: `content.noSecrets`: PII patterns become opt-in and every pattern gets
  corpus-derived precision (S-414).
  
  Replaying the recent commits of 30 OSS repositories through the `default`
  profile (the codai SWE-harness write gate) rejected real, harmless edits: 110 of
  3240 files matched `email` (maintainer addresses in `pyproject.toml`,
  `git@github.com`, `user@example.com`) and 107 matched `credentialAssignment`
  (`token: str`, `token = var.set(...)`, `token: write`).
  
  - **checks**: new param `pii: boolean` (default `false`). `cnp`, `email`,
    `phoneRo`, `card` run only with `pii: true`; `credentialAssignment`, `awsKey`,
    `githubToken`, `privateKey`, `jwt`, `slackToken` always run.
    `credentialAssignment` now requires a quoted literal ≥ 8 chars and skips
    placeholders/interpolations/identifier-shaped values (9/3240 corpus files
    left, all real quoted credentials in tests/READMEs); `email` skips RFC
    2606/6761 domains, `*@github.com`, `git@`/`noreply@` and asset
    pseudo-addresses; `cnp` validates month/day/county and the mod-11 control
    digit. `SECRET_PATTERNS[i].kind` (`"secret" | "pii"`) and
    `PII_PATTERN_NAMES` exported.
  - **mcp**: gate profile gains `pii: boolean` (default `false`), forwarded to
    `content.noSecrets`.
  
  **Behaviour change**: a profile that relied on `params: {}` catching e-mails,
  CNPs, Romanian phone numbers or card numbers must set `pii: true` (brivio and
  metu profiles updated alongside this release).
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
- ae3d6a6: `axiom verify <bundle> --tree <root> [--pre] [--attest <out>]` (S-403, D-20/D-21):
  compare a real tree with a manifest — every artifact present with its digest
  (deletes absent), or with `--pre` the manifest's declared `preImage` set.
  Exit 1 lists `mismatches[]`; nothing under `.axiom/` is touched. `--attest`
  writes a JCS-canonical in-toto Statement with `predicateType
  https://axiom.dev/attestation/apply/v1` (subjects = manifest + each present
  path) and the bare predicate for `actions/attest`. New `verifyTree()` in
  `@codai/axiom-apply` and `buildApplyAttestation()` in `@codai/axiom-canon`.
  Composite GitHub Action `dragoscv/axiom/action` (inputs `bundle`, `root`,
  `pre`, `attest`, `attestation-path`, `version`; outputs `ok`,
  `manifest-digest`, `mismatches`, `attestation-path`) fails a PR whose tree
  drifted and can upload the attestation; dogfooded by the `verify-action` CI job.
  Docs: `docs/verify-tree.md`.

### Patch Changes

- 02527d8: Doc/code drift sweep (S-410): the `template` source is no longer described as
  "reserved for v2.1 / compile rejects" in the Plan JSON schema, the `.axm` LSP
  hover and the docs — it has been rendered by registered emitters since 2.1.0.
  `VerifyResult.signed` documents that structural verification never verifies
  signatures (use `axiom verify --root` or the `signature.*` predicates). v1-era
  docs (`ir_spec`, `plugin_api`, `reverse_ir_spec`, `MCP-ONLY-PUBLIC-SURFACE`)
  moved to `docs/archive/v1/`. New repo guard `check-stale-markers` fails on any
  forward-looking "planned for vX.Y" note whose version is already released.
- Updated dependencies [801d29e]
- Updated dependencies [50900d6]
- Updated dependencies [c36c818]
- Updated dependencies [b51eb33]
- Updated dependencies [7cb7db7]
- Updated dependencies [c8de39b]
- Updated dependencies [38ff1c0]
- Updated dependencies [02527d8]
- Updated dependencies [28a39a0]
- Updated dependencies [ae3d6a6]
  - @codai/axiom-schema@2.2.0
  - @codai/axiom-apply@2.2.0
  - @codai/axiom-checks@2.2.0
  - @codai/axiom-plan@2.2.0
  - @codai/axiom-axm@2.2.0
  - @codai/axiom-canon@2.2.0
  - @codai/axiom-emitters-web@2.2.0

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
- d9bcbbe: Streamable HTTP transport: `axiom mcp --http <host:port> [--http-token-env NAME]` serves MCP at
  `POST/GET/DELETE /mcp` (+ unauthenticated `GET /health`) on plain `node:http` — one session per
  `Mcp-Session-Id`, 30-min idle eviction, 4 MiB body limit, DNS-rebinding protection on loopback,
  mandatory constant-time bearer token on any non-loopback bind (refuses to start without one).
  Loaded lazily from `dist/http-lazy.js`; stdio stays the default and the eager bundle is unchanged.
  A new private `packages/conformance` harness runs `@modelcontextprotocol/conformance` against it in
  CI with an expected-failures baseline (0 unexpected failures).
- 40d88ee: `axiom migrate v1 <manifest.json> [-o plan.json] [--profile <name>] [--cas <root>] [--content <dir>] [--overwrite]` — lift an AXIOM 1.0.x manifest into a v2 `Plan` (S-305). Paths become POSIX `RelPath`s, `contentUtf8`/`contentBase64` become `inline` sources, hash-only artifacts are read from the v1 output tree and re-verified against their `sha256` (or stored in `<root>/.axiom/cas` with `--cas`), known policy evidence and the built-in `budget`/`edge` profile constraints map to `content.noSecrets`/`deps.max`/`manifest.maxTotalBytes`/`content.maxBytes`, and every field without a v2 equivalent (`buildId`, `irHash`, `createdAt`, per-artifact `sha256`/`bytes`/`kind`, runtime evidence) is listed in `metadata.migration.dropped` with a reason — no timestamps enter the Plan. Exit 0 clean, 1 migrated with warnings (still written), 2 not a v1 manifest (`ERR_INVALID_MANIFEST`). `migrateV1()` is exported for programmatic use; the code ships as a lazy chunk (`dist/migrate-lazy.js`) so the eager CLI bundle is unchanged. See `docs/migrate.md`.
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

### Patch Changes

- Updated dependencies [5d1d33f]
- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-checks@2.1.0
  - @codai/axiom-canon@2.1.0
  - @codai/axiom-schema@2.1.0
  - @codai/axiom-plan@2.1.0
  - @codai/axiom-emitters-web@2.1.0
  - @codai/axiom-apply@2.1.0
  - @codai/axiom-axm@2.1.0

## 2.0.0

### Major Changes

- 23d80d5: New `@codai/axiom-mcp` 2.0.0: stdio MCP server (`McpServer.registerTool` with annotations, Zod v4 input/output
  schemas, `structuredContent`), 9 tools (`axiom_plan_validate|plan_compile|manifest_verify|check|apply_dry_run|apply|rollback|manifest_diff|roots_list`),
  5 resource templates (`axiom://manifest|report|applied|profile|schema`), frozen `--root` allowlist with no
  env/cwd fallback, stderr-only JSON-lines logging, 4 MiB payload guard, `spec/tools.json` generated from the
  registry, and an `axiom` CLI (`compile|verify|check|apply|rollback|diff|schema|mcp`) bundled into a single
  self-contained `dist/cli.js`.

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
- c629d26: New `@codai/axiom-axm`: the `.axm` v2 front-end (S-204). Chevrotain 13 lexer + CST parser implementing the
  §6 EBNF (`axiom "2"`, `plan Ident { intent | profile | capabilities [..] | artifact String {..} | check Ident using
  QualIdent [Json] | meta Json }`, sources `inline <<HEREDOC | template | cas | ref`) compiled 1:1 into a
  `PlanSchema`-validated `Plan`. `parseAxm(source)` never throws and returns `{ plan?, diagnostics[] }` with
  1-based `{line, column}` ranges and closed `ERR_*` codes (lexer, parser with expected-token messages, semantic:
  duplicate artifact path / unknown capability / Zod issues mapped back to source). `formatAxm(plan)` is the
  deterministic inverse (`parseAxm(formatAxm(p)).plan` deep-equals `p`, property-tested). CRLF input is normalised
  to LF; heredoc terminators must be alone on their line.
  
  `@codai/axiom-mcp`: new read-only tool `axiom_axm_parse { source } → { plan?, diagnostics[] }` and
  `axiom compile <plan.axm>` (parses first; on errors prints diagnostics JSON and exits 2). The parser is a
  lazily imported chunk, so `cli.js + cli-main.js` stay inside the 950 KB budget and cold start is unchanged.
- 04ec4ab: Emit `spec/codai-tools.json` — the 9 MCP tools in the entry shape of codai's
  `packages/agent-core/spec/tools-v2.json` (`{ name, risk, description, parameters }`) so codai agents can
  gate them under `APPROVAL_MATRIX`; generated by `build:spec` alongside `spec/tools.json` and pinned by the
  parity test. `axiom_plan_compile` is now annotated `readOnlyHint: false` (risk `ACT`): with `store: cas` or
  a `root` it writes under `<root>/.axiom/`. See `docs/integration/codai.md`.
- f2e60b0: New `axiom gate --stdin [--root <dir>] [--profile <file>] [--strict] [--log-level …]` — PreToolUse hook
  mode (S-203, v2-architecture §5.6). Reads one Claude Code (`tool_name`/`tool_input`/`cwd`) or Copilot CLI
  (`toolName`/`toolArgs` JSON string/`cwd`) payload, extracts the write target(s) of
  `Write|Edit|MultiEdit|NotebookEdit|create_file|replace_string_in_file|insert_edit_into_file|apply_patch|multi_replace_string_in_file|edit_notebook_file|write|edit`
  and runs only the fast rules: realpath containment + `RelPath` validation (`..`, `CON`, NTFS ADS →
  `ERR_CONTAINMENT`/`ERR_PATH_*`), `path.deny`, `path.allow`, `content.noSecrets` and `content.maxBytes`
  (real `@codai/axiom-checks` predicates over a synthetic single-artifact context) from
  `--profile` → `<root>/.axiom/gate-profile.json` → `~/.axiom/gate-profile.json` → built-in default.
  Allow = exit 0, silent. Deny = exit 2, `AXIOM GATE DENY <code>: <reason> (<relpath>)` on stderr and the
  Claude `hookSpecificOutput` deny JSON on stdout. Malformed payload / 2 s stdin timeout / internal error
  fail **open** (exit 0 + warn) unless `--strict`. Ships as its own lazy chunk (`dist/gate-lazy.js`, no MCP
  SDK) reached directly from `cli.js`; in-process p95 ≈ 5 ms, end-to-end ≈ 150–200 ms. New guard
  `check-gate-latency` (p95 ≤ 250 ms). Wiring for Copilot CLI, VS Code and Claude Code in `docs/hooks.md`.
- fc679b9: `guard.external` is now a real predicate (S-202, v2-architecture §3.2). It spawns a repository-owned
  guard — a relative `command` that must realpath inside `<root>/scripts/` (`.mjs/.js/.cjs` via the
  current `node`, `.ps1` via `pwsh -NoProfile -ExecutionPolicy Bypass -File`) or an absolute executable
  that exactly matches an entry of the new `guardAllowlist` — with an args array (never a shell),
  `windowsHide`, a scrubbed whitelist environment plus `params.env`, `AXIOM_MANIFEST_DIGEST` and
  `AXIOM_ROOT`, the JCS bundle/manifest on stdin, and a wall-clock timeout that kills the process tree
  (`ERR_GUARD_TIMEOUT`). stdout must be a `GuardOutput` JSON object `{ ok, findings? }`; non-JSON stdout
  on any exit code fails closed with `ERR_GUARD_OUTPUT` (stderr tail 4 KiB in facts). brivio-style
  `OK`/`FAIL` text is accepted only with `legacyText: true`. Guards run only when the profile sets
  `facts.allowGuards` **and** `runChecks` receives `allowGuards: true`; otherwise a single `error`
  finding ("external guards disabled"). `runChecks` executes guard checks in a pool of
  `min(4, os.cpus().length)` and reports the `guard` provider as `ok|skipped|error`.
  
  `@codai/axiom-mcp`: `axiom mcp|check|apply` accept `--allow-guards` and repeatable
  `--guard-allowlist <abs>`, threaded into every `runChecks` call (`createServer(policy, { guards })`).
  Docs: `docs/checks.md` (contract table), `docs/integration/brivio.md` (adapter for `run-guards.mjs`).

### Patch Changes

- Updated dependencies [f258a6e]
- Updated dependencies [f2e60b0]
- Updated dependencies [c629d26]
- Updated dependencies [fc679b9]
  - @codai/axiom-apply@2.0.0
  - @codai/axiom-schema@2.0.0
  - @codai/axiom-axm@2.0.0
  - @codai/axiom-checks@2.0.0
  - @codai/axiom-plan@2.0.0
  - @codai/axiom-canon@2.0.0
