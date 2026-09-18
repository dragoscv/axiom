---
description: Rules for @codai/axiom-apply — containment, two-phase commit, journal and scoped rollback
applyTo: "packages/apply/**"
---

# packages/apply

`@codai/axiom-apply` is the only code in the repo that writes to a user's tree.
Every bug here is a data-loss bug. Files: `contain.ts` (path containment),
`write.ts` (write + verify), `journal.ts`, `lock.ts`, `blobs.ts`, `diff.ts`,
`realpath.ts`, `fsx.ts`, `apply.ts` (the 2PC orchestrator).

## Hard rules

1. **Containment before any fs call.** No `fs.*` on a manifest path until
   `contain()` has returned an absolute path inside the root: realpath of every
   existing ancestor, reject symlink escapes, `..`, absolute paths, NFC-mismatch,
   Windows reserved names (`CON`, `NUL`, `COM1`…), case-collision with an existing
   sibling. New checks go in `contain.ts` and get a fast-check case in
   `contain.test.ts` (the "never escapes a tmp root" property is the spec).
2. **Journal before mutate.** The journal entry (manifestDigest, every path,
   pre-image sha256 or `absent`) is fsync'd **before** the first rename into
   place. If the process dies between, `rollback` must be able to restore from
   the journal alone.
3. **Two phases, one gate.** Phase 1 stages every blob under `.axiom/stage/<digest>/`
   and verifies sha256 after write. Phase 2 re-reads each pre-image hash
   (TOCTOU guard) and renames. `confirmDigest !== manifestDigest` → `ERR_CONFIRM_MISMATCH`
   before phase 1 starts.
4. **Never throw out of `apply()`.** It returns `ApplyResult` (`ok | failed |
   rolled_back`) with an `ERR_*` code. Internal throws are caught at the
   orchestrator boundary, trigger rollback of what phase 2 already renamed, and
   are recorded in the journal. Unknown exceptions map to `ERR_INTERNAL` with the
   cause preserved.
5. **Rollback is scoped.** It restores exactly the paths in the journal entry —
   never "everything under root", never files it did not touch. A second
   rollback of the same entry is a no-op with `ok: true`.
6. **Idempotent.** `apply(bundle)` twice = second run writes nothing and reports
   `noop` per artifact. Tested by property.
7. **Single writer.** Take `.axiom/lock` (O_EXCL create, pid + timestamp inside)
   for the whole apply; stale lock (dead pid) may be reclaimed, live lock →
   `ERR_LOCKED`.
8. **No shell, no `cwd`.** `execFile`/`spawn` with args arrays only. The ONLY
   process spawning is `git.ts` → `runGit()` (PR mode): `spawn("git", args,
   { shell: false, cwd: rootReal, env: scrubbed })`, branch names validated by
   regex + `git check-ref-format --branch`, commit message on stdin (`-F -`).
   Every new git call goes through `runGit`; every path is resolved against the
   explicit root.
9. **Windows is a first-class target.** Rename-over-existing needs the
   `fsx.replaceFile` helper (unlink+rename fallback), paths are compared
   case-insensitively for collisions, `EPERM` on rename is retried with backoff.

## Tests

- `*.test.ts` create a fresh tmp root per test (`test-helpers.ts`), never write
  to the repo.
- Fault injection: `apply.test.ts` fails the fs at step *i* for every *i* and
  asserts the tree is byte-identical to the pre-image afterwards.
- Assert `result.code` / `entry.status`; never message strings.
