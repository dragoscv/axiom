---
"@codai/axiom-canon": minor
"@codai/axiom-schema": minor
"@codai/axiom-plan": minor
"@codai/axiom-checks": minor
"@codai/axiom-mcp": minor
"@codai/axiom-axm-lsp": patch
---

DSSE signing, key pinning and anti-rollback (PLAN.md S-302 / D-16) — see `docs/signing.md`.

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
