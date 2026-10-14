---
"@codai/axiom-mcp": minor
---

New MCP tool `axiom_write`: a one-tool, two-step transactional write. Call it with `files` (write/delete, utf8/base64, mode) to get a `preview` (manifestDigest, diff, pre-apply checks; nothing outside `.axiom/` touched), then call it again with the same files and `confirmDigest` to apply exactly like `axiom_apply` (journal, two-phase commit, one-step rollback). Pre-images are bound into the digest, so a target changed since the preview fails with `ERR_CONFIRM_DIGEST_MISMATCH`.
