# @codai/axiom-canon

Zero-dependency canonicalization and attestation primitives for AXIOM v2.

**What:** RFC 8785 JSON Canonicalization (JCS), sha256 content addressing
(`sha256:<hex>`), an in-toto Statement v1 / SLSA Provenance v1 builder, and
DSSE Pre-Authentication Encoding. Only `node:crypto` at runtime.

**Why:** every AXIOM artefact (Manifest, Plan, facts, Statement) is identified
by the hash of its canonical bytes. Deterministic serialization is what makes
`manifestDigest` reproducible across OSes and lets `verify` byte-compare
instead of trusting a parser. Lifted from `codai/packages/rules-core`.

## API

- `canonicalize(value): string` — JCS; throws `CanonicalizeError` on NaN,
  bigint, lone surrogates. `undefined` members are dropped.
- `sha256Hex`, `sha256Digest`, `digestRef`, `parseDigestRef`
- `canonicalHash(value)`, `canonicalDigestRef(value)`, `verifyCanonical(text)`
- `buildStatement(input): InTotoStatementV1` + constants
  `IN_TOTO_STATEMENT_V1`, `SLSA_PROVENANCE_V1`, `AXIOM_BUILD_TYPE`, `AXIOM_BUILDER_ID`
- `pae(payloadType, payload): Uint8Array`, `DSSE_IN_TOTO_PAYLOAD_TYPE`
