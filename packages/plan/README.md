# @codai/axiom-plan

Plan → ManifestBundle compiler for AXIOM v2 (design §2).

**What:** `compilePlan(plan, opts)` validates a `Plan`, resolves every
artifact's bytes (inline utf8/base64, or CAS under `<root>/.axiom/cas`),
hashes them, and emits a canonical `ManifestBody` whose `manifestDigest` is
`sha256(JCS(body))`. Content travels beside the manifest — inline `blobs`
(default) or the CAS (`store: "cas"`) — so the digest is transport-independent.
An in-toto Statement v1 / SLSA provenance is attached as `attestation`.

**Determinism:** artifacts sorted by UTF-8 path order, checks by id, toolchain
keys sorted, no timestamps in the body. Permuting a plan's artifacts, switching
inline↔CAS, or passing a clock never changes `manifestDigest`.

## API

- `compilePlan(plan, { store?, root?, toolchain?, now?, invocationId? }) → { bundle, statement }`
  Errors are `AxiomError` with codes `ERR_INVALID_PLAN`, `ERR_BLOB_TOO_LARGE`,
  `ERR_BUNDLE_TOO_LARGE`, `ERR_BLOB_MISSING`, `ERR_DIGEST_MISMATCH`,
  `ERR_REF_OFFLINE` (ref, v2.0), `ERR_UNSUPPORTED_OP` (template, v2.1).
- `verifyBundle(bundle)` — schema, recomputed digest, blob hashes, attestation subject. Never throws.
- `diffManifests(a, b)` — `{ added, removed, changed[{path, from, to}] }` by path/digest.
- `casPath / casPut / casGet / casHas` — tmp→fsync→rename content store.

Build: tsdown, ESM, Node ≥ 22.14. `isolatedDeclarations` is off in this
package's tsconfig because inferred Zod types cannot be annotated explicitly.
