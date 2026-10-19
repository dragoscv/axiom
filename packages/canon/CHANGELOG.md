# @codai/axiom-canon

## 3.0.0

### Major Changes

- 9122967: v3 wire identity and one policy file (D-41, D-42).
  
  - New canonical `apiVersion: "axiom.codai.ro/v3"` for every document AXIOM creates (Plan, Manifest,
    CheckReport, ApplyResult, Profile, RepoSnapshot); `"axiom.dev/v2"` keeps parsing through 3.x and a
    2.x plan still compiles to its 2.x digest. New plans therefore have new `planDigest`/`manifestDigest`
    values (golden fixtures re-pinned; `plan-basic-v2` pins the 2.x digest). Schema exports
    `API_VERSION_V2`, `API_VERSIONS`, `isLegacyApiVersion`. JSON Schema `$id`s move to
    `https://dragoscv.github.io/axiom/schemas/v3/`.
  - Attestation predicate URIs move to `https://dragoscv.github.io/axiom/spec/...`
    (`AXIOM_APPLY_ATTESTATION_V1`, `AGENT_DECISION_V0_1`, build type, builder id); the 2.x URIs stay
    exported as `*_LEGACY`.
  - `.axiom/axiom.json` (`version: 3`, `gate`, `checks`, `extends`): `loadAxiomConfig` with
    relative-file, `axiom:<pack>` and installed `@codai/axiom-pack-*` extends, union of
    deny/ask/hard/allow, cycle/depth → `ERR_INVALID_PROFILE`, version > 3 → `ERR_PROFILE_VERSION`,
    unknown keys warn. `loadProfile(name, { config })` reads its `checks` section. `migrateProfile`
    folds `.axiom/gate-profile.json` + `.axiom/profiles/<name>.json` into it without deleting them.
    New `AxiomConfig` JSON Schema.
- 9122967: Security hardening from the 2026-10-19 reality check (D-41, S-1301..S-1308, S-1313):
  
  - **Gate.** One shell lexer (`shell-lex.ts`) splits on newlines, strips quotes and PowerShell backticks, folds git global options and decodes `-EncodedCommand`. Force push, reset --hard, clean -f and worktree remove --force are detected semantically (`-uf`, `+refspec`, `--mirror`, `git -C . push -f`, ...). New `house.pushDelete`, `house.stashDrop`, `house.undecodable`. Every command rule is evaluated: a hard code wins regardless of order. Whole-tree `git clean` / `reset --hard` is `git.destructiveTree` (hard when reset/clean are) and is judged before containment. Globs are case-insensitive on Windows/macOS, 8.3 short names are refused, `\\?\` system paths are recognised.
  - **Overrides.** `axiom-override: <reason>` is read only from explanation/goal/description/reason or a trailing shell comment outside quotes and heredocs; never from file content or an apply_patch body; the reason needs ≥ 3 words and ≥ 12 letters. Every relaxed decision is journaled.
  - **Profiles.** Unknown keys warn instead of denying; `version` newer than the binary → `ERR_PROFILE_VERSION`; broken profiles → `ERR_INVALID_PROFILE`; profile errors are never covered by `--fail-open`. A linked worktree inherits the main clone's profile when its own is missing or older. `axiom init` writes enforce + the house pack + four hard codes.
  - **Daemon protocol 2.** Mandatory per-start key, HMAC-signed responses, nonce, no bearer, argv allowlist, payload roots checked after normalisation, bounded body; protocol-1 clients get 426 and spawn.
  - **Apply.** `.axiom/` is reserved under any case / NFC / 8.3 / junction alias (`ERR_PATH_RESERVED_DIR`); journal backup paths are contained (`ERR_JOURNAL_CORRUPT`); rollback is a no-op on an already rolled-back digest, refuses drift (`ERR_PREIMAGE_CHANGED`, `force`) and missing backups (`ERR_ROLLBACK`); dry-run writes nothing.
  - **Plan / checks.** A `ref` CAS hit is re-hashed (`casGetUnverified` is the raw reader); pre-image and repo-fact reads no longer follow junctions out of the root.
  - **Misc.** Empty stdin allows with a warning (oversize stays fail-closed); JSON parse errors never echo the payload; `noSecretsExclude` for PII-class findings; `create_and_run_task` is scanned; rename/move/mkdir tools are writes; Claude denies emit only `hookSpecificOutput`; Junie gets `ask`; new `kiro` format.

## 2.7.0

No changes in this release.

## 2.6.1

No changes in this release.

## 2.6.0

No changes in this release.

## 2.5.2

No changes in this release.

## 2.5.1

No changes in this release.

## 2.5.0

### Minor Changes

- 90def4c: Phase 8 (D-36, D-37): a gate cheap enough for every tool call, in every harness.
  
  - `axiom serve --hook --root <abs>…` — resident gate daemon on loopback (Origin/Host refusal, optional bearer token, `~/.axiom/daemon.json`). `axiom gate --stdin` (node and SEA) asks it first and falls back to the in-process gate when it gives no verdict; Claude Code can call it as a `type: "http"` hook with `onFailure: "block"` (no process per call, ~4–5 ms).
  - Native thin client `axiom-hook` (Rust, std only) shipped as release assets, in the brew formula and the install scripts; fails closed in the harness's format when neither the daemon nor `axiom` can run.
  - `axiom gate --format auto|claude|copilot|vscode|codex|cursor|windsurf|gemini|junie|cline` and payload support for Cursor, Windsurf/Devin, Codex `apply_patch`, Gemini CLI, Junie and Cline. Cursor `Delete` and Gemini/Cline `replace` tools are now write-class (they were allowed unchecked).
  - `axiom init` / `axiom doctor` cover all nine harnesses; `init --daemon`; doctor checks the daemon, the global bin against gate-profile keys, and VS Code's Copilot hook log for gate runs that ended `NonBlockingError` (advisory denies).
  - Gate profile `steer: off|hint|require` + `steerGlobs` (init writes `hint`) and the new MCP tool `axiom_write` (preview → apply with `confirmDigest`).
  - Gate profile `record: true` → `.axiom/decisions.jsonl`; `axiom attest decisions [--sign]` emits in-toto agent-decision v0.1 Statements (`AGENT_DECISION_V0_1`, `argsHash`, `buildAgentDecisionStatement` in `@codai/axiom-canon`).
  
  A gate profile that uses `steer`, `steerGlobs` or `record` requires axiom ≥ 2.5.0 wherever the hook runs (older gates reject unknown keys and deny every write).

## 2.4.1

No changes in this release.

## 2.4.0

No changes in this release.

## 2.3.1

No changes in this release.

## 2.3.0

No changes in this release.

## 2.2.1

No changes in this release.

## 2.2.0

### Minor Changes

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

## 2.0.0

No changes in this release.
