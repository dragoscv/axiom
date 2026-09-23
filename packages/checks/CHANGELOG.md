# @codai/axiom-checks

## 2.3.0

### Minor Changes

- 3e357c2: feat(checks): add `repo.requireReference` predicate — content-level ripple.
  
  `repo.requireCompanion` only proves a companion _path_ exists. Real ripple
  rules are about content: a new MCP tool must be listed in `spec/tools.json`,
  a new marketing page in the sitemap, a new gateway route in the SDK. Any of
  those can drift with the companion file untouched and `requireCompanion`
  green.
  
  - `rules[]: { name, when: glob, in: relpath, mustContain: template, mustChange?,
  jsonPointer? }`. For every artifact matching `when`, the companion `in`
    (plan blob first, then the repo unless `mustChange`) must contain the
    rendered template — `${path}`, `${basename}`, `${dirname}` of the
    triggering artifact.
  - `jsonPointer` (RFC 6901) parses `in` as JSON and checks the pointed value:
    string → substring, array → member equality, object → own key.
  - Finding id `repo.requireReference.<name>`, `path` = the triggering
    artifact, `facts: { in, expected, source: "plan" | "repo" | "absent" }`.
  - Fails closed (`ERR_PROVIDER_FAILED`, `verdict: error`) when the companion
    exists but is unreadable, is not UTF-8, is not JSON while `jsonPointer` is
    set, or the pointer does not resolve to something that can contain a string.
  - A plan `delete` of the companion counts as absent — the repo copy is not
    consulted, because after apply it will be gone.
  
  18 built-ins now; `axm-lsp` vocabulary gains the entry.

### Patch Changes

- @codai/axiom-canon@2.3.0
  - @codai/axiom-schema@2.3.0

## 2.2.1

### Patch Changes

- 5b9efcd: Standalone binaries, MCP Registry listing and the docs site (Phase 5, D-27…D-31).
  
  - **mcp**: new single-executable entry `src/sea.ts` + `tsdown.sea.config.ts`
    (`pnpm build:sea` → one inlined CommonJS bundle) and `scripts/build-sea.mjs`
    (`node --build-sea`, Node ≥ 25.5). `release.yml` builds `axiom-{linux,darwin}-{x64,arm64}`
    and `axiom-win-x64.exe` natively on five runners, attaches them with `SHA256SUMS` and a
    Sigstore build-provenance attestation to the GitHub release, publishes `server.json` to
    the MCP Registry as `io.github.dragoscv/axiom`, and moves the `v2` tag of
    `dragoscv/axiom/action`. The package version is resolved through `src/version.ts`
    (`define`d at build time in the binary; read from `package.json` otherwise).
    `server.json` ships in the npm tarball. No wire or tool change.
  - **checks**: `expr.cedar` treats `ERR_UNKNOWN_BUILTIN_MODULE` (what a Node single
    executable raises for any non-builtin specifier) as "optional dependency not installed" and
    fails closed with `ERR_PROVIDER_FAILED`, instead of rethrowing.
  - Documentation restructured under `docs/{getting-started,concepts,guides,reference,integration,design}`
    and published at <https://dragoscv.github.io/axiom/> (Astro Starlight, `apps/site`), with
    `llms.txt`, `install.sh` and `install.ps1`.
- @codai/axiom-canon@2.2.1
  - @codai/axiom-schema@2.2.1

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
- 7cb7db7: Predicate quality (S-408).
  
  - `content.noSecrets` `card`: a digit run is a PAN only when it passes Luhn, is
    not a single repeated digit and is not part of a UUID — zero/placeholder UUIDs
    (`00000000-0000-0000-0000-000000000000`), epoch-ms timestamps and sequential
    placeholders no longer fail the check; every real test PAN is still caught.
  - `repo.requireCompanion` gains `expect[].mustChange: true`: the companion must
    be in the plan, an existing repo file no longer satisfies the rule.
  - Every glob parameter auto-escapes Next.js route groups (`app/(app)/**`
    matches the literal directory); real extglobs and `\(app\)` are untouched.
  - `guard.external` attaches `facts.evidence = { exitCode, stdout, stderr }`
    (2 KiB tails) to every finding it produces, including `ERR_GUARD_OUTPUT` /
    `ERR_GUARD_TIMEOUT` (which previously used ad-hoc `exitCode`/`stdout`/`stderr`
    facts).
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

- Updated dependencies [801d29e]
- Updated dependencies [b51eb33]
- Updated dependencies [c8de39b]
- Updated dependencies [38ff1c0]
- Updated dependencies [02527d8]
- Updated dependencies [28a39a0]
- Updated dependencies [ae3d6a6]
  - @codai/axiom-schema@2.2.0
  - @codai/axiom-canon@2.2.0

## 2.1.0

### Minor Changes

- 5d1d33f: New predicate `expr.cel` (PLAN.md S-301 / D-15): a boolean CEL expression over `manifest`,
  `artifacts`, `content` (path → `{bytes, sha256, text?}`) and `repo` (`exists` map, only with an
  authorised root — referencing it without one is an `error`, never a pass). Evaluated with
  `@marcbachmann/cel-js` 8 behind a lazy `import()` so the MCP eager bundle grows by 8 KB only
  (872.4 → 880.2 KB). The determinism bar is enforced in the predicate: closed function allowlist
  (no `timestamp`/`duration`/`now`/`base64`/`json`/`bind`), literal RE2-safe `matches()` (no
  lookaround/backrefs), expression ≤ 4096 chars, AST depth ≤ 24 / ≤ 2000 nodes, 100 ms evaluation
  budget, closed variable set. Parse/type/runtime errors and non-bool results are provider-style
  `error` findings; `false` yields exactly one finding with the optional `message`. Ships with a
  345-case vector suite, a purity test and fast-check properties. `builtinRegistry().list()` now has
  16 ids; the `.axm` LSP completion list gained `expr.cel`.
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

### Patch Changes

- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-canon@2.1.0
  - @codai/axiom-schema@2.1.0

## 2.0.0

### Minor Changes

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

- Updated dependencies [f2e60b0]
  - @codai/axiom-schema@2.0.0
  - @codai/axiom-canon@2.0.0
