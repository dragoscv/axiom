# @codai/axiom-apply

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

### Patch Changes

- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-canon@2.1.0
  - @codai/axiom-schema@2.1.0

## 2.0.0

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

### Patch Changes

- f258a6e: Fix `op: "delete"` on POSIX: the pre-image backup is taken with a hardlink, and
  `rename(target, backup)` onto a hardlink of itself is a no-op on Linux/macOS, so
  deleted files were left in place. The commit step now unlinks the target after
  the backup is taken (`unlinkRetry`, same EBUSY/EPERM/EACCES retry policy as
  rename). Found by the first cross-OS CI run; Windows never exhibited it.
- Updated dependencies [f2e60b0]
  - @codai/axiom-schema@2.0.0
  - @codai/axiom-canon@2.0.0
