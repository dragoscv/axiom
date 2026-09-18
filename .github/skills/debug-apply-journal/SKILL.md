---
name: debug-apply-journal
description: Diagnose a failed, interrupted or suspicious `apply` on a target root by reading the .axiom/ journal, staging and backup directories — determine the phase it died in, what was written, and whether rollback/recover is safe. Use when a user reports "apply left my tree half-written", ERR_LOCKED, a journal in `committing`, or wants to prove a rollback restored the pre-image.
---

# Debug an apply journal

`@codai/axiom-apply` is a two-phase commit. Everything it knows is on disk under
`<root>/.axiom/` — read that first, reason second, mutate last (and only via
`rollback()`/`recoverIfNeeded()`, never by hand-deleting).

Layout (from `packages/apply/src/apply.ts` + `journal.ts` + `lock.ts`):

```
<root>/.axiom/
  lock                         single writer: { pid, startedAt } — stale after 60 min
  journal/<digest-hex>.json    Journal { manifestDigest, phase, steps[], startedAt, pid }
  stage/<digest-hex>/…         phase-1 blobs, sha256-verified, not yet in place
  backup/<digest-hex>/…        pre-images of files phase 2 overwrote/deleted
  applied/<digest-hex>         marker written after a successful commit (idempotency)
```

Phases (`JournalPhaseSchema`, `packages/schema/src/apply.ts`):
`staged → committing → committed`, or `committing → rolling-back → rolled-back`.

## Steps

1. **Freeze the scene.** Do not run `apply` again yet. `git status --short`
   in the root (if it is a git tree) and list `.axiom/journal/`. Copy the whole
   `.axiom/` dir to `.copilot-tmp/axiom-forensics-<ts>/` before touching anything.
2. **Read the journal**: `Get-Content <root>/.axiom/journal/<hex>.json | ConvertFrom-Json`.
   Note `phase`, `pid`, `startedAt`, and for each step `path`, `op`, `backup`,
   `done`. `done: false` steps in `committing` = files phase 2 never reached.
3. **Match it to the manifest**: the file name is `manifestDigest` minus
   `sha256:`. If the caller still has the bundle, `axiom_manifest_verify` (or
   `verifyBundle` in `@codai/axiom-plan`) confirms it is the same digest —
   a mismatch means someone applied a *different* bundle than they think.
4. **Check the lock**: is `pid` alive? (`Get-Process -Id <pid>`). Alive →
   another apply is genuinely running; wait. Dead + `startedAt` older than
   `LOCK_STALE_MS` (60 min) → `acquireLock` will reclaim it on the next call;
   younger → `ERR_LOCKED` is *correct*, do not delete the file by hand.
5. **Classify**:
   - `staged` — nothing in the tree changed; stage dir can be discarded. Safe.
   - `committing`, some `done: true` — the tree is mixed. Every done step has a
     `backup` entry → rollback is possible and byte-exact.
   - `committed` — apply finished; if the user sees "wrong content", compare
     `sha256` of each path against `artifacts[].sha256` in the manifest before
     blaming apply (an editor or another agent may have written after).
   - `rolling-back` — a rollback was interrupted; `recoverIfNeeded(root)`
     finishes it idempotently.
6. **Verify pre-images before rolling back**: for each `done` step,
   `Get-FileHash <root>/.axiom/backup/<hex>/<path>` should equal the pre-image
   hash the journal/manifest recorded (`ArtifactPre` in the bundle). A mismatch
   is a TOCTOU finding — record it, it is the bug, not the symptom.
7. **Recover**: `rollback(root, "sha256:<hex>")` from `@codai/axiom-apply`
   (or MCP `axiom_rollback`). Then re-hash the touched paths against the
   backups: identical → **VERIFIED** restored. A second rollback must be a no-op.
8. **Reproduce in a test**, not in the user's tree: `packages/apply/src/apply.test.ts`
   has fault-injection at step *i* — add the failing step index/shape you found
   as a new case, assert `result.code` and the byte-identical tree.
9. **Report**: phase found, steps done/undone, whether backups matched, what
   restored it, and the root cause (`ERR_*` code) — with the command output.
   Add a line to `/memories/repo/axiom-overview.md` if the failure mode is new.
