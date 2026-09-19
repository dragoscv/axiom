# @codai/axiom-apply

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
