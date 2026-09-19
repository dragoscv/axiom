---
"@codai/axiom-schema": minor
"@codai/axiom-plan": minor
"@codai/axiom-checks": minor
"@codai/axiom-apply": minor
"@codai/axiom-mcp": minor
---

Pre-image binding (S-402). `ManifestBody.preImage[]` records, for every
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
