---
"@codai/axiom-apply": patch
---

Fix `op: "delete"` on POSIX: the pre-image backup is taken with a hardlink, and
`rename(target, backup)` onto a hardlink of itself is a no-op on Linux/macOS, so
deleted files were left in place. The commit step now unlinks the target after
the backup is taken (`unlinkRetry`, same EBUSY/EPERM/EACCES retry policy as
rename). Found by the first cross-OS CI run; Windows never exhibited it.
