---
"@codai/axiom-schema": patch
"@codai/axiom-checks": patch
"@codai/axiom-apply": patch
"@codai/axiom-mcp": patch
---

Hardening from the first CodeQL (security-extended) scan:

- Linear-time parsing where a regex was polynomial on adversarial input: base64 padding in `blobByteLength` (schema), trailing separators in root containment (mcp), git remote path trimming (apply), and legacy `FAIL name: reason` guard output (checks).
- No check-then-read window: `repo.read` facts and pre-image hashing read through one file handle, and pre-image / worktree `.git` reads confirm the handle is the same inode `lstat` saw (a swap to a symlink reads as drift, never hashed).
- `axiom doctor` refuses to probe a daemon whose `~/.axiom/daemon.json` names a non-loopback host, so a tampered state file cannot send the bearer token off the machine (same rule as the hook client).
