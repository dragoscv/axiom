---
"@codai/axiom-schema": minor
"@codai/axiom-apply": minor
"@codai/axiom-checks": minor
"@codai/axiom-mcp": minor
---

Idempotency and error-code hygiene (S-407).

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
