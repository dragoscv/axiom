# @codai/axiom-apply

Transactional apply engine for AXIOM v2 `ManifestBundle`s (design §4). `apply()` never throws; every
failure is an `AxiomError` code from `@codai/axiom-schema` surfaced in `ApplyResult.error`.

## Guarantees

- **Nothing outside `root` is ever written.** Every artifact path is schema-validated (POSIX-relative, NFC,
  Windows reserved names rejected on every OS), checked for case-insensitive collisions, walked segment by
  segment with `lstat` (symlink/junction → `ERR_SYMLINK_IN_PATH`) and realpath-contained (`ERR_CONTAINMENT`).
- **Content is what the manifest says.** Blobs are re-hashed on resolution (`ERR_DIGEST_MISMATCH`,
  `ERR_SIZE_MISMATCH`) and again after every write; the whole bundle is resolved before the first write.
- **All-or-nothing on the user tree.** Phase 1 stages under `.axiom/staging/<digest>/` (tmp → fsync →
  rename). Phase 2 re-verifies each target's pre-image right before its rename (`ERR_PREIMAGE_CHANGED`,
  closes the check-then-apply TOCTOU window), backs up pre-images, then renames. Any phase-2 error rolls
  back in reverse order, scoped to exactly the manifest's paths, and returns `status: "rolled-back"`.
- **Single writer per root.** `.axiom/lock` (O_EXCL, `{pid, hostname, startedAt, manifestDigest}`); stale
  if the pid is dead or older than 1 h; 30 s wait → `ERR_LOCKED`.
- **Idempotent.** Same digest applied twice with matching on-disk content → `status: "noop"`.
- **Crash-safe.** A journal left in `committing`/`rolling-back` is rolled back at the next `apply`; `rollback(root, digest)` is exposed for the CLI.
- `mode: "dry-run"` runs phase 1 only, returns a unified diff (≤ 1 MiB) and leaves the tree untouched.
- `mode: "pr"` wraps the fs apply in a git branch + commit (`git.ts`, spawn args array, **no shell**):
  branch validated by regex + `git check-ref-format --branch`, default name `axiom/<name>/<digest12>`
  (deterministic), touched paths must be clean (`git status --porcelain -- <paths>`), `git switch -c`,
  fs apply, `git add -- <paths>` explicit only, `git commit --quiet -F -` with the message on stdin,
  `result.git = { branch, commit, compareUrl? }`. Hooks are honoured. **No push, no PR creation, no
  network** — run `gh pr create --head <branch>` afterwards. Failures: `ERR_GIT_NOT_REPO`, `ERR_GIT_DIRTY`,
  `ERR_GIT_BRANCH_EXISTS`, `ERR_GIT_BRANCH_INVALID`, `ERR_GIT_NOT_FOUND`, `ERR_GIT_FAILED`; an fs or commit
  failure rolls the apply back and drops the branch.

## Non-guarantees

- No protection against a *concurrent* writer that ignores `.axiom/lock`; the pre-image check narrows the
  window to the instant before rename but cannot close it on POSIX/NTFS without a snapshotting FS.
- Directory `fsync` is skipped on Windows; file mode `0755` is recorded but not applied on Windows.
- `ref` artifact sources are not fetched in v2.0 (`ERR_REF_OFFLINE`); only inline blobs and the local CAS.
- Backups (`keepBackups`, default 3 manifests) are a convenience, not a version-control system.

## `.axiom/` layout

```
.axiom/lock                  single-writer lockfile
.axiom/staging/<hex>/        full new tree, deleted after commit or on any failure
.axiom/journal/<hex>.json    Journal (phase + steps), fsynced before phase 2
.axiom/backup/<hex>/         pre-images of overwritten/deleted files (hardlink, else copy)
.axiom/applied/<hex>.json    ApplyResult; presence == idempotency marker
.axiom/cas/sha256/<aa>/<hex> optional content-addressed store read by resolveContent
.axiom/tmp/                  case-sensitivity probe scratch
```

Note: this package keeps `isolatedDeclarations: true` from the base tsconfig.
