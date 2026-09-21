# @codai/axiom-canon

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
