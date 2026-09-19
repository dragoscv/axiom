---
"@codai/axiom-canon": minor
"@codai/axiom-apply": minor
"@codai/axiom-mcp": minor
---

`axiom verify <bundle> --tree <root> [--pre] [--attest <out>]` (S-403, D-20/D-21):
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
