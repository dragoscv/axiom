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
If the marker exists but files drifted, the apply proceeds as a re-apply.

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
- **No git operations.** `mode: pr` is a v2.1 item; v2.0 writes files only.
- **`ref` sources are not fetched** (`ERR_REF_OFFLINE`); only inline blobs and the
  local CAS.
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
