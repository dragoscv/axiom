---
"@codai/axiom-schema": minor
"@codai/axiom-canon": minor
"@codai/axiom-checks": minor
"@codai/axiom-mcp": minor
---

Signing hardening (S-409):

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
