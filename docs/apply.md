# Apply: guarantees, layout and failure modes (v2)

`@codai/axiom-apply` takes a verified `ManifestBundle` and a root and either
writes the change set atomically (from the user tree's point of view) or leaves
the tree exactly as it found it. `apply()` never throws; every failure is an
`ApplyResult` with `status: failed | rolled-back` and an `error.code` from the
closed enum. This page describes what is promised, what is not, and what is on
disk afterwards. Package README: `packages/apply/README.md`.

## Guarantees

**Nothing outside `root` is written.** Before the first byte is staged, every
artifact path passes, in order:

1. Schema `RelPath` rules (relative POSIX, NFC, no `..`, no `<>:"|?*`, Windows
   device names rejected on every OS, no trailing dot/space).
2. Case-insensitive collision check between artifacts (`ERR_PATH_CASE_COLLISION`);
   on a case-insensitive filesystem (probed once via `.axiom/tmp/CaseProbe-…`)
   also against existing on-disk names.
3. Segment walk from the root with `lstat`: any symlink or junction in the
   ancestry → `ERR_SYMLINK_IN_PATH`.
4. `realpath.native(dirname(target))` must equal the realpath'd root or start
   with it plus a separator → `ERR_CONTAINMENT`. Compared case-insensitively on
   Windows.
5. Target type: existing directory or symlink where a file is expected →
   `ERR_TARGET_TYPE`; existing file with `op: create` → `ERR_EXISTS`.

**Content is what the manifest says.** Blobs are resolved (`blobs` → CAS) and
re-hashed before staging (`ERR_DIGEST_MISMATCH`, `ERR_SIZE_MISMATCH`,
`ERR_BLOB_MISSING`), and every staged file is re-read and re-hashed after the
write. The whole bundle is resolved before the first write.

**All-or-nothing on the user tree.** Phase 1 writes only under
`.axiom/staging/<hex>/`. Phase 2 moves files into place with `rename` and rolls
back in reverse on any error, scoped to exactly the manifest's paths. A crash
mid-commit is recovered at the next `apply` on that root.

**Hash-gated.** `mode: fs` requires `confirmDigest === bundle.manifestDigest`
(`ERR_CONFIRM_DIGEST_MISMATCH`) and a `manifestDigest` that matches the recomputed
JCS hash (`ERR_NOT_CANONICAL`). A caller must have seen the digest — typically
from `axiom_apply_dry_run` — to apply it.

**Pre-image verified at commit (TOCTOU guard).** Right before each `rename`,
the current on-disk file is hashed again and compared with what was observed
during staging. If another writer changed it in between → `ERR_PREIMAGE_CHANGED`
and the transaction rolls back. This is what makes apply safe on a tree that
several agents share.

**Single writer per root.** `.axiom/lock` is created with `O_EXCL` and holds
`{ pid, hostname, startedAt, manifestDigest }`. A lock is stale when its pid is
dead on the same host or it is older than one hour; waiters retry for 30 s and
then fail with `ERR_LOCKED` (details carry the holder).

**Idempotent.** If `.axiom/applied/<hex>.json` exists and every artifact's
on-disk digest still matches the manifest, the result is `status: noop` with
every file `unchanged`; nothing is touched and the lock is held only briefly.
If the marker exists but files drifted, the apply proceeds as a re-apply and
lists the re-written paths in `result.drifted`. A drifted `create` target is
not `ERR_EXISTS`: it is committed as an overwrite and the foreign bytes are
backed up under `.axiom/backup/<hex>/` like any pre-image. Without the marker a
`create` over an existing file is still `ERR_EXISTS`.

**Pre-image binding (S-402).** A manifest compiled with a root carries
`preImage[]` — the sha256 (or `absent`) of every artifact path as compile saw
it. On a *first* apply (no applied marker) every entry is re-verified before
staging; a mismatch is `ERR_PREIMAGE_CHANGED` with `details.phase: "prepare"`
and nothing is written. This is separate from the in-transaction TOCTOU check
(same code, no `phase`), which compares against what *staging* captured. A
manifest without `preImage` (compiled without a root) skips this step.

**Rollback failure is its own error.** When a commit step fails and the scoped
rollback also fails, the result is `status: failed` with `error.code:
ERR_ROLLBACK` (the original error is in the message and `details`), the journal
stays in `rolling-back`, and `axiom rollback <digest>` (or the recovery at the
next apply) retries it.

**Pre-apply checks are part of the transaction.** When a `preChecks` callback
is supplied (the MCP server and CLI always do, using the profile), it runs on
the staged tree after phase 1; any verdict other than `pass` aborts with
`ERR_CHECKS_FAILED` before phase 2.

## Non-guarantees

- **A writer that ignores `.axiom/lock`** can still race. The pre-image check
  narrows the window to the instant before `rename`; it cannot close it without
  a snapshotting filesystem.
- **Backups are not version control.** `.axiom/backup/` keeps pre-images for the
  last `keepBackups` manifests (default 3), then prunes.
- **No network.** `mode: pr` never pushes or opens a pull request (see below).
- **`ref` sources are never fetched by apply** (`ERR_REF_OFFLINE` when the blob is not in the
  local CAS); `axiom compile --allow-net` on the same root fetches and pins them first.
- **Directory `fsync` is skipped on Windows**; a power loss in the milliseconds
  after a rename can lose the rename on NTFS. Journal and marker files are still
  fsynced.
- **File mode `0755` is recorded but not applied on Windows.**
- Nothing is done about file ownership, ACLs, extended attributes or timestamps.

## `.axiom/` layout

```
<root>/.axiom/
  lock                     single-writer lockfile (JSON holder)
  staging/<hex>/           full new tree for one manifest; removed after commit or on any failure
  journal/<hex>.json       Journal { phase, steps[], startedAt, pid }; fsynced before phase 2
  backup/<hex>/            pre-images of overwritten/deleted files (hardlink, else copy)
  applied/<hex>.json       ApplyResult of a committed apply; presence = idempotency marker
  cas/sha256/<aa>/<hex>    optional content-addressed store (written by compile --store cas)
  manifests/               bundles stored by the MCP server when a root is given to compile
  profiles/<name>.json     custom check profiles
  tmp/                     case-sensitivity probe scratch
```

`<hex>` is the 64-char manifest digest without the `sha256:` prefix. The
`default` profile protects `.axiom/**` from being overwritten by a manifest.
Add `.axiom/` to `.gitignore`.

## Two-phase flow

```
acquire lock ─► recover any journal left in committing/rolling-back
   │
   ├─ applied marker present and on-disk digests match? ─► noop
   │
   ▼
Phase 1 (prepare)                       — no user file touched
   containment for every artifact
   resolve + hash every blob
   write staging/<hex>/… (tmp → fsync → rename → re-hash)
   record pre-image hash of every existing target
   preChecks(staged) must be pass          ─► else ERR_CHECKS_FAILED, staging removed
   dry-run? ─► unified diff, staging removed, return
   write journal { phase: staged }, fsync
   │
   ▼
Phase 2 (commit)                        — journal { phase: committing }
   for each step in path order:
     re-hash current target; differs from pre-image ─► ERR_PREIMAGE_CHANGED
     overwrite/delete: move pre-image to backup/<hex>/<path> (hardlink → copy fallback)
     create/overwrite: rename(staging/<path>, target)
     mark step done; fsync journal every 32 steps
   journal { phase: committed }
   write applied/<hex>.json; remove staging; prune old backups; release lock
```

Any exception in phase 2 triggers **rollback**: journal `rolling-back`, then
steps replayed in reverse where `done` — restore from backup or unlink the
created file — then `rolled-back`. The result is `status: rolled-back` with
`error` set to the original cause and `journal` pointing at the file. If the
rollback itself fails, `status: failed` and the message names both errors; the
journal is left for `axiom rollback <digest> --root .` or manual inspection
(`.github/skills/debug-apply-journal`).

Staging lives under the root so `rename` stays on one volume and is atomic
per file.

## Rollback on demand

`rollback(root, manifestDigest)` (CLI `axiom rollback`, MCP `axiom_rollback`)
replays the journal of a committed apply in reverse using `backup/<hex>/`. It
is scoped to the paths in that journal; files created after the apply by
someone else are not touched. A journal whose backups were already pruned
cannot be rolled back — check `keepBackups`.

## Dry-run and diff

`mode: dry-run` executes phase 1 only, then produces a unified diff of every
text artifact against the current on-disk content (binary content is reported
as differing without a hunk), removes staging and returns
`status: applied, files[], diff`. The diff is capped at 1 MiB. No journal is
written, no lock file remains, no marker is created. The `manifestDigest` in the
result is the value to pass as `confirmDigest`.

## PR mode (`mode: "pr"`)

`mode: pr` wraps the normal `fs` two-phase apply in a git branch + commit. It
is the v2 replacement for v1's `applyPR`, which spawned `git` with `shell: true`
and a caller-supplied branch name (command injection). Sequence:

1. **Branch name** — `options.branch` or the deterministic default
  `axiom/<manifest.name>/<manifestDigest hex 0..12>` (no timestamps). It must
  match `^[A-Za-z0-9._/-]{1,120}$` with no `..`, `//`, `@{`, leading `-`/`/`,
  trailing `/`, `.` or `.lock`, and then pass `git check-ref-format --branch
  <name>` (as an argv element). Anything else → `ERR_GIT_BRANCH_INVALID`, and
  no git process is spawned for the syntactic rejects.
2. `git rev-parse --show-toplevel` must be the root itself (realpath, case
  insensitive on Windows) → else `ERR_GIT_NOT_REPO`. A subdirectory of a repo
  is rejected on purpose: artifact paths are relative to the root.
3. `git status --porcelain -- <touched paths>` must be empty → else
  `ERR_GIT_DIRTY` with the dirty list in `details`. Only the paths the
  manifest touches are inspected; other agents' uncommitted work elsewhere in
  the tree is left alone and is **not** committed.
4. `refs/heads/<branch>` must not exist → else `ERR_GIT_BRANCH_EXISTS`.
5. `git switch -c <branch>`, then the ordinary fs apply (lock, staging,
  journal, TOCTOU check, rename, marker). If that fails or rolls back, axiom
  switches back to the previous branch and deletes the new one (best effort)
  and returns the fs result unchanged.
6. `git add -- <touched paths>` (explicit paths only — this stages deletions of
  tracked files too), `git commit --quiet -F -` with the message on **stdin**
  (default: `axiom: apply <name> (<digest12>)` + `Manifest:`/`Plan:` trailers),
  `git rev-parse HEAD`. If the commit fails, the fs apply is rolled back from
  its journal and the branch dropped; the result is `rolled-back` with the git
  error. Hooks (`pre-commit`, `commit-msg`) are **honoured** — a hook that
  rejects the commit rolls the apply back.
7. `result.git = { branch, commit, compareUrl? }`. `compareUrl` is derived from
  `git remote get-url origin` when it is GitHub
  (`/compare/<default>...<branch>?expand=1`, default branch from
  `refs/remotes/origin/HEAD`, fallback `main`) or GitLab
  (`/-/merge_requests/new?merge_request[source_branch]=<branch>`); otherwise
  absent.

What PR mode does **not** do: push, open a pull request, touch the network, or
run `git` through a shell. Every invocation is
`spawn("git", args, { shell: false, windowsHide: true, cwd: root, env })` with
the env reduced to `PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`/`TMP`
and `GIT_*` minus `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`, plus
`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `LC_ALL=C` so nothing can block on
a prompt. A git call that exits non-zero → `ERR_GIT_FAILED` (first stderr line
in the message, last 4 KiB in `details.stderr`); no `git` on `PATH` →
`ERR_GIT_NOT_FOUND`; 60 s timeout per call. To publish the branch afterwards:

```
git push -u origin <branch>
gh pr create --head <branch>      # or open result.git.compareUrl
```

Idempotency is unchanged: re-applying an already-applied digest is `noop` and
creates no branch.

## Windows notes

- Paths longer than 240 chars are passed as `\\?\`-prefixed namespaced paths
  for every fs call.
- `fs.realpath.native` is used so `c:` / `C:` and 8.3 short names normalise; root
  containment compares case-insensitively.
- Junctions are reported by `lstat().isSymbolicLink()` and rejected like symlinks.
- `rename` onto a file another process holds open fails with `EBUSY`/`EPERM`/
  `EACCES`; it is retried 5 times with 50 ms × attempt backoff, then
  `ERR_EBUSY` and rollback. Close editors and watchers on the target files.
- Windows reserved names are rejected on every platform so a manifest compiled
  on Linux applies on Windows.
- Directory `fsync` is a no-op; `0755` is not applied.
