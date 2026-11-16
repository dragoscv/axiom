import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalDigestRef } from "@codai/axiom-canon";
import {
  API_VERSION,
  type AppliedFile,
  type ApplyError,
  type ApplyResult,
  ApplyResultSchema,
  type ArtifactOp,
  AxiomError,
  type CheckReport,
  type DigestRef,
  isValidRelPath,
  type Journal,
  type JournalStep,
  type ManifestArtifact,
  type ManifestBundle,
  ManifestBundleSchema,
} from "@codai/axiom-schema";
import { resolveContent } from "./blobs.js";
import {
  checkOnDiskPathCollision,
  checkReservedDir,
  checkTargetType,
  gitDirReal,
  isReservedDirPath,
  probeCaseInsensitive,
  reservedDirReal,
  resolveContained,
  validateArtifactPaths,
} from "./contain.js";
import { type DiffEntry, unifiedDiff } from "./diff.js";
import {
  errnoCode,
  fileDigestOrAbsent,
  IS_WIN32,
  isContained,
  lstatOrNull,
  nsPath,
  rmrf,
  sha256Of,
} from "./fsx.js";
import {
  addWorktree,
  assertPathsClean,
  assertRepoToplevel,
  branchExists,
  compareUrlFor,
  defaultBranchName,
  defaultCommitMessage,
  headCommit,
  materializeWorktreePaths,
  removeWorktree,
  runGit,
  validateBranchName,
} from "./git.js";
import {
  finalizeJournal,
  listJournals,
  newJournal,
  readHistory,
  readJournal,
  recordTerminal,
  removeJournal,
  setPhase,
  writeJournal,
} from "./journal.js";
import { type Intent, LOCK_TIMEOUT_MS, registerIntent, withLock } from "./lock.js";
import { realpathNative } from "./realpath.js";
import { renameRetry, unlinkRetry, writeAtomic } from "./write.js";

export interface StagedFile {
  path: string;
  op: ArtifactOp;
  /** Absolute path of the staged content (absent for delete). */
  stagingPath?: string;
  digest?: string;
  preImage: string;
  /** realpath of the target's parent as captured in `prepare` (A1-2: re-checked at commit). */
  parentReal: string;
}

export interface StagedTree {
  root: string;
  stagingDir: string;
  manifestDigest: DigestRef;
  files: StagedFile[];
}

export interface ApplyOptions {
  bundle: ManifestBundle;
  root: string;
  mode: "dry-run" | "fs" | "pr";
  confirmDigest?: string;
  keepBackups?: number;
  preChecks?: (staged: StagedTree) => Promise<CheckReport>;
  /** How long to wait in the lock queue (ms, default `LOCK_TIMEOUT_MS`); timeout → `ERR_LOCKED`. */
  lockTimeoutMs?: number;
  /** PR mode: branch to create (default `axiom/<name>/<digest12>`). */
  branch?: string;
  /** PR mode: commit message, passed to git on stdin (`-F -`). */
  commitMessage?: string;
}

export const JOURNAL_FSYNC_EVERY = 32;
export const DEFAULT_KEEP_BACKUPS = 3;

export interface RollbackOptions {
  /**
   * Roll back even when a target no longer holds what the manifest wrote (a later human or
   * agent edit would be overwritten). Default `false` → `ERR_PREIMAGE_CHANGED`.
   */
  force?: boolean;
}

function hexOf(d: DigestRef): string {
  return d.slice("sha256:".length);
}

export function axiomDir(root: string): string {
  return path.join(root, ".axiom");
}
export function stagingDir(root: string, digest: DigestRef): string {
  return path.join(root, ".axiom", "staging", hexOf(digest));
}
export function backupDir(root: string, digest: DigestRef): string {
  return path.join(root, ".axiom", "backup", hexOf(digest));
}

/**
 * A1-1/A1-11: a step's backup is always `.axiom/backup/<this journal's digest hex>/<step path>`.
 * The journal therefore does not need to store it, and recovery can restore a pre-image whose
 * step was never flushed to disk (the process was killed between the backup and the journal
 * write) instead of declaring it rolled back and deleting the originals.
 */
function backupRelOf(digest: DigestRef, relPath: string): string {
  return `.axiom/backup/${hexOf(digest)}/${relPath}`;
}

export function appliedPath(root: string, digest: DigestRef): string {
  return path.join(root, ".axiom", "applied", `${hexOf(digest)}.json`);
}
/** PR mode (S-704): the axiom-owned linked worktree for a digest. */
export function worktreeDir(root: string, digest: DigestRef): string {
  return path.join(root, ".axiom", "wt", hexOf(digest).slice(0, 12));
}

function toApplyError(err: unknown): ApplyError {
  if (err instanceof AxiomError) {
    const out: ApplyError = { code: err.code, message: err.message };
    if (err.path !== undefined && isValidRelPath(err.path)) out.path = err.path;
    if (err.details !== undefined && Object.keys(err.details).length > 0) out.details = err.details;
    return out;
  }
  return { code: "ERR_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

/**
 * A commit failed AND its rollback failed: the tree may now be inconsistent, which is a
 * different (worse) situation than the original error — surfaced as `ERR_ROLLBACK`, with
 * the original error kept in `cause`/message so the operator sees both.
 */
function rollbackFailure(original: unknown, rbErr: unknown): AxiomError {
  const o = toApplyError(original);
  const r = toApplyError(rbErr);
  return new AxiomError(
    "ERR_ROLLBACK",
    `rollback failed (${r.code}: ${r.message}) after ${o.code}: ${o.message}; run \`axiom rollback\` or inspect .axiom/journal`,
    { cause: original, details: { original: o, rollback: r }, ...(o.path ? { path: o.path } : {}) },
  );
}

async function realRoot(root: string): Promise<string> {
  let real: string;
  try {
    real = await realpathNative(root);
  } catch (err) {
    throw new AxiomError("ERR_ROOT_NOT_DIR", "root does not exist", {
      cause: err,
      details: { root },
    });
  }
  if (IS_WIN32 && real.startsWith("\\\\?\\")) real = real.slice(4);
  const st = await fs.stat(real);
  if (!st.isDirectory()) {
    throw new AxiomError("ERR_ROOT_NOT_DIR", "root is not a directory", { details: { root } });
  }
  return real;
}

function expectedDigest(a: ManifestArtifact): string {
  return a.op === "delete" ? "absent" : (a.digest?.sha256 ?? "absent");
}

/** Artifacts whose on-disk digest differs from what this manifest declares. */
async function driftedArtifacts(
  rootReal: string,
  artifacts: readonly ManifestArtifact[],
): Promise<string[]> {
  const out: string[] = [];
  for (const a of artifacts) {
    const cur = await fileDigestOrAbsent(path.join(rootReal, ...a.path.split("/")));
    if (cur !== expectedDigest(a)) out.push(a.path);
  }
  return out;
}

async function writeAppliedMarker(rootReal: string, result: ApplyResult): Promise<void> {
  const p = appliedPath(rootReal, result.manifestDigest);
  await writeAtomic(p, new TextEncoder().encode(JSON.stringify(result)));
}

/**
 * A1-19: a `committed` journal whose applied marker was never written (the process died between
 * the phase flip and the marker write) otherwise makes that digest permanently unusable — a
 * re-apply of the same bundle fails with `ERR_EXISTS` / `ERR_PREIMAGE_CHANGED` forever. Rebuild
 * the marker from the journal's own `postImage` values, which are what the commit wrote.
 */
async function ensureAppliedMarker(rootReal: string, j: Journal): Promise<void> {
  if ((await lstatOrNull(appliedPath(rootReal, j.manifestDigest))) !== null) return;
  const files: AppliedFile[] = j.steps.map((s) => {
    const f: AppliedFile = {
      path: s.path,
      op: s.op,
      status: s.op === "delete" ? "deleted" : "written",
    };
    if (s.op !== "delete" && s.postImage !== undefined) f.digest = { sha256: s.postImage };
    return f;
  });
  await writeAppliedMarker(rootReal, {
    apiVersion: API_VERSION,
    kind: "ApplyResult",
    manifestDigest: j.manifestDigest,
    mode: "fs",
    status: "applied",
    root: rootReal,
    files,
  });
}

/**
 * Keep the backups of the `keep` most recent applies. Order comes from the journal chain
 * (S-706/S-707: a copy or a clock change can reset an mtime, a chain `seq` cannot); a backup
 * the chain does not know (pre-2.4 root, chain unreadable) falls back to mtime and sorts after
 * every chained one, so it is pruned first.
 */
async function pruneBackups(rootReal: string, keep: number): Promise<void> {
  const dir = path.join(rootReal, ".axiom", "backup");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  const seqOf = new Map<string, number>();
  try {
    for (const h of await readHistory(rootReal)) {
      const hex = hexOf(h.manifestDigest);
      if (!seqOf.has(hex)) seqOf.set(hex, h.seq);
    }
  } catch {
    // chain unreadable → mtime order for everything (never block an apply on pruning)
  }
  const entries: { name: string; seq: number; mtime: number }[] = [];
  for (const n of names) {
    const st = await lstatOrNull(path.join(dir, n));
    if (st?.isDirectory()) entries.push({ name: n, seq: seqOf.get(n) ?? -1, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => b.seq - a.seq || b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  for (const e of entries.slice(Math.max(0, keep))) await rmrf(path.join(dir, e.name));
}

/**
 * Append the terminal journal to the tamper-evident chain (S-706). The apply itself already
 * happened; a broken chain must not turn a successful write into a thrown error, so the fault is
 * reported on stderr-free result data by the caller (`axiom verify --journal` fails closed).
 */
async function chainTerminal(
  rootReal: string,
  journal: Journal,
  opts: { state?: "failed"; code?: string } = {},
): Promise<void> {
  try {
    await recordTerminal(rootReal, journal, opts);
  } catch {
    // ERR_JOURNAL_CHAIN (chain already broken) or IO: surfaced by `verify --journal` / `status`.
  }
}

/** Journals left mid-flight, for the dry-run report (A1-13). Recovers nothing. */
async function interruptedDigests(root: string): Promise<DigestRef[]> {
  const { journals } = await listJournals(root, { pendingOnly: true });
  return journals
    .filter((j) => j.phase === "staged" || j.phase === "committing" || j.phase === "rolling-back")
    .map((j) => j.manifestDigest);
}

/**
 * A journal is input from disk — anyone who can write `.axiom/journal/` can plant one. Before any
 * rollback moves a byte: every step path must be a contained, non-`.axiom` target, and every
 * `backup` must be exactly `.axiom/backup/<this journal's hex>/<step.path>` and contained.
 * Violation → `ERR_JOURNAL_CORRUPT`, nothing touched.
 */
async function validateJournal(rootReal: string, j: Journal): Promise<void> {
  const axiomReal = await reservedDirReal(rootReal);
  const gitReal = await gitDirReal(rootReal);
  const forged = new Set(["ERR_CONTAINMENT", "ERR_SYMLINK_IN_PATH", "ERR_PATH_RESERVED_DIR"]);
  for (const step of j.steps) {
    try {
      if (isReservedDirPath(step.path)) {
        throw new AxiomError("ERR_PATH_RESERVED_DIR", "journal step targets a reserved dir", {
          path: step.path,
        });
      }
      if (step.backup !== undefined && step.backup !== backupRelOf(j.manifestDigest, step.path)) {
        throw new AxiomError("ERR_CONTAINMENT", "backup is outside this journal's backup set", {
          path: step.path,
        });
      }
      const { parentReal } = await resolveContained(rootReal, step.path);
      checkReservedDir(step.path, parentReal, axiomReal, gitReal);
      await resolveContained(rootReal, backupRelOf(j.manifestDigest, step.path));
    } catch (err) {
      if (!(err instanceof AxiomError)) throw err;
      // e.g. ERR_TARGET_TYPE (a parent became a file): not an escape; the replay reports it.
      if (!forged.has(err.code)) continue;
      throw new AxiomError("ERR_JOURNAL_CORRUPT", "journal step fails containment", {
        path: step.path,
        cause: err,
        details: { digest: j.manifestDigest, backup: step.backup ?? null, reason: err.code },
      });
    }
  }
}

/**
 * A1-1: every pre-image this journal can still lose must be recoverable BEFORE anything moves —
 * either the target still holds it, or its backup (derived, never read from the journal) is on
 * disk. Otherwise `ERR_ROLLBACK` and the backup set is left untouched for a human, instead of
 * being deleted while the originals were never restored ("rolled-back" with data loss).
 */
async function assertRestorable(rootReal: string, j: Journal): Promise<void> {
  for (const step of j.steps) {
    if (step.preImage === undefined || step.preImage === "absent") continue;
    const backupRel = backupRelOf(j.manifestDigest, step.path);
    const backupAbs = path.join(rootReal, ...backupRel.split("/"));
    if ((await lstatOrNull(backupAbs)) !== null) continue;
    const target = path.join(rootReal, ...step.path.split("/"));
    const now = await fileDigestOrAbsent(target);
    if (now === step.preImage) continue;
    // The pre-image is neither on disk nor backed up. It is OUR doing only when the step shows
    // evidence we mutated the target: the post-image is on disk, the step was flushed `done`, or
    // (a delete) the file is simply gone. A third party replacing the file is drift the commit
    // refused — restoring it is impossible and not a reason to abort the whole journal.
    const ours =
      step.op === "delete" || step.done || (step.postImage !== undefined && now === step.postImage);
    if (!ours) continue;
    throw new AxiomError("ERR_ROLLBACK", "pre-image backup is missing (pruned?)", {
      path: step.path,
      details: { digest: j.manifestDigest, backup: backupRel, reason: "unrestored" },
    });
  }
}

/**
 * A1-1: the backup set may only be deleted when every pre-image is provably back on disk.
 */
async function assertRestored(rootReal: string, j: Journal): Promise<void> {
  for (const step of j.steps) {
    if (step.preImage === undefined) continue;
    const target = path.join(rootReal, ...step.path.split("/"));
    const now = await fileDigestOrAbsent(target);
    if (now === step.preImage) continue;
    // A1-17: a `create` (or an overwrite of an absent file) whose target holds something that is
    // NOT what the commit wrote was taken over by someone else; the rollback deliberately leaves
    // those bytes alone, which is not a failed restore. A pre-image we overwrote and did not put
    // back, or a file we wrote and did not remove, still is.
    if (step.preImage === "absent" && step.postImage !== undefined && now !== step.postImage) {
      continue;
    }
    // Same for an overwrite: bytes that are neither the pre-image nor the post-image are a third
    // party's, and the rollback must not touch them.
    if (step.postImage !== undefined && now !== step.postImage) continue;
    // ... and an apparent delete whose path someone else has since recreated.
    if (step.op === "delete" && now !== "absent") continue;
    throw new AxiomError("ERR_ROLLBACK", "rollback did not restore the pre-image", {
      path: step.path,
      details: {
        digest: j.manifestDigest,
        expected: step.preImage,
        actual: now,
        reason: "restore-failed",
      },
    });
  }
}

/** What a done step left on disk: `step.postImage`, else the applied marker's digest. */
async function expectedPostImages(
  rootReal: string,
  j: Journal,
): Promise<Map<string, string | undefined>> {
  const fromMarker = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(nsPath(appliedPath(rootReal, j.manifestDigest)), "utf8"),
    );
    const parsed = ApplyResultSchema.safeParse(raw);
    if (parsed.success) {
      for (const f of parsed.data.files) {
        if (f.digest !== undefined) fromMarker.set(f.path, f.digest.sha256);
      }
    }
  } catch {
    // no marker (committing journal) → postImage only
  }
  const out = new Map<string, string | undefined>();
  for (const s of j.steps) {
    out.set(s.path, s.op === "delete" ? "absent" : (s.postImage ?? fromMarker.get(s.path)));
  }
  return out;
}

/** Done steps whose target no longer holds what the commit wrote → `ERR_PREIMAGE_CHANGED`. */
async function assertNoDrift(rootReal: string, j: Journal): Promise<void> {
  if (j.phase !== "committed" && j.phase !== "committing") return;
  const expected = await expectedPostImages(rootReal, j);
  const drifted: { path: string; expected: string; actual: string }[] = [];
  for (const s of j.steps) {
    const exp = expected.get(s.path);
    if (!s.done || exp === undefined) continue; // pre-2.8 journal without a known post-image
    const actual = await fileDigestOrAbsent(path.join(rootReal, ...s.path.split("/")));
    if (actual !== exp) drifted.push({ path: s.path, expected: exp, actual });
  }
  const first = drifted[0];
  if (first !== undefined) {
    throw new AxiomError(
      "ERR_PREIMAGE_CHANGED",
      "target changed after apply; rollback would overwrite it (pass force to override)",
      {
        path: first.path,
        details: { phase: "rollback", expected: first.expected, actual: first.actual, drifted },
      },
    );
  }
}

/**
 * Scoped rollback of one journal: replay `steps` in reverse. Each step is decided from what is on
 * disk, never from the journal's optional bookkeeping: the backup path is derived from the digest
 * (A1-1), the target's own digest says whether the step was already undone, and `postImage` /
 * the staged file say whether the commit got as far as the move (a step's `done` flag may not
 * have been flushed before a crash). Containment is re-resolved immediately before every move
 * (A1-2). Refuses with `ERR_ROLLBACK` rather than deleting a backup set that is still needed.
 */
async function rollbackJournal(rootReal: string, journal: Journal): Promise<Journal> {
  let j = journal;
  await validateJournal(rootReal, j);
  await assertRestorable(rootReal, j);
  if (j.phase !== "rolling-back") j = await setPhase(rootReal, j, "rolling-back");
  const stg = stagingDir(rootReal, j.manifestDigest);
  const axiomReal = await reservedDirReal(rootReal);
  const gitReal = await gitDirReal(rootReal);
  for (let i = j.steps.length - 1; i >= 0; i--) {
    const step = j.steps[i];
    if (step === undefined) continue;
    const segs = step.path.split("/");
    const target = path.join(rootReal, ...segs);
    const staged = path.join(stg, ...segs);
    // Derive, never trust the stored field (A1-1/A1-11).
    const backupRel = backupRelOf(j.manifestDigest, step.path);
    const backupAbs = path.join(rootReal, ...backupRel.split("/"));
    const now = await fileDigestOrAbsent(target);
    // Already the pre-image (a resumed rollback, or a step the crash never reached): nothing to
    // undo, and no reason to touch the tree or require containment for it.
    if (step.preImage !== undefined && now === step.preImage) continue;
    // A1-2: the parent is re-resolved right before every move. A directory swapped for a junction
    // since `prepare` (or since `validateJournal`) must not be followed out of the root.
    const { parentReal } = await resolveContained(rootReal, step.path);
    checkReservedDir(step.path, parentReal, axiomReal, gitReal);
    const stagedExists = (await lstatOrNull(staged)) !== null;
    const backupExists = (await lstatOrNull(backupAbs)) !== null;
    // "Was it renamed into place": the post-image on disk is proof, `done` is the record, and a
    // consumed staging file is the crash-time fallback.
    const renamed =
      step.done || (step.postImage !== undefined && now === step.postImage) || !stagedExists;
    if (step.op === "create") {
      if (renamed) await fs.rm(nsPath(target), { force: true });
    } else if (step.preImage === "absent") {
      // Overwrite of a file that did not exist: there is no backup, undo it like a create.
      if (step.op === "overwrite" && renamed) await fs.rm(nsPath(target), { force: true });
    } else if (backupExists) {
      await renameRetry(backupAbs, target, step.path);
    } else if (step.preImage === undefined && renamed) {
      // pre-2.8 journal with no recorded pre-image: best effort.
      await fs.rm(nsPath(target), { force: true });
    } else if (renamed) {
      throw new AxiomError("ERR_ROLLBACK", "pre-image backup vanished during rollback", {
        path: step.path,
        details: { digest: j.manifestDigest, backup: backupRel, reason: "backup-vanished" },
      });
    }
    // else: nothing of ours to undo — the pre-image is missing through a third party, which
    // `assertRestorable` already refused when it was our own doing.
  }
  await assertRestored(rootReal, j);
  await rmrf(stg);
  await rmrf(backupDir(rootReal, j.manifestDigest));
  const out = await setPhase(rootReal, j, "rolled-back");
  await chainTerminal(rootReal, out);
  return out;
}

/**
 * CLI entry: roll back an applied/committing manifest by digest. Returns the final journal.
 *
 * - no journal → `ERR_NOT_FOUND`; journal only `staged` (nothing committed) → `ERR_NOT_FOUND`.
 * - already `rolled-back` → no-op, the journal is returned unchanged (a second rollback must
 *   never delete what a later apply wrote).
 * - a target edited after apply → `ERR_PREIMAGE_CHANGED` unless `force: true`.
 * - a needed backup pruned → `ERR_ROLLBACK`; a planted/forged journal → `ERR_JOURNAL_CORRUPT`.
 *   All three refuse before anything moves.
 */
export async function rollback(
  root: string,
  digest: DigestRef,
  options: RollbackOptions = {},
): Promise<Journal> {
  const rootReal = await realRoot(root);
  return withLock(rootReal, digest, async () => {
    const j = await readJournal(rootReal, digest);
    if (j === undefined) {
      throw new AxiomError("ERR_NOT_FOUND", "no journal for digest", { details: { digest } });
    }
    if (j.phase === "rolled-back") return j;
    if (j.phase === "staged") {
      throw new AxiomError("ERR_NOT_FOUND", "journal never reached commit; nothing to roll back", {
        details: { digest, phase: j.phase },
      });
    }
    await validateJournal(rootReal, j);
    if (options.force !== true) await assertNoDrift(rootReal, j);
    const out = await rollbackJournal(rootReal, j);
    await fs.rm(appliedPath(rootReal, digest), { force: true });
    return out;
  });
}

/**
 * Crash recovery (§4.2): any journal left in `committing`/`rolling-back` is
 * rolled back; `staged` journals are discarded with their staging tree;
 * `committed` journals need their staging tree removed and their applied marker rebuilt
 * (A1-19). Caller must hold the lock.
 */
export async function recoverIfNeeded(rootReal: string): Promise<DigestRef[]> {
  // A1-18: only the journals still in the pending index are read. A root with thousands of
  // terminal journals costs the same to recover as a fresh one.
  const { journals } = await listJournals(rootReal, { pendingOnly: true });
  const recovered: DigestRef[] = [];
  for (const j of journals) {
    if (j.phase === "committing" || j.phase === "rolling-back") {
      try {
        await rollbackJournal(rootReal, j);
      } catch (err) {
        // A forged/inconsistent journal is reported like a corrupt one (`status`, `rollback`),
        // never acted on — validation runs before anything moves.
        if (err instanceof AxiomError && err.code === "ERR_JOURNAL_CORRUPT") continue;
        throw err;
      }
      await fs.rm(appliedPath(rootReal, j.manifestDigest), { force: true });
      recovered.push(j.manifestDigest);
      continue;
    }
    if (j.phase === "staged") {
      await rmrf(stagingDir(rootReal, j.manifestDigest));
      await removeJournal(rootReal, j.manifestDigest); // drops the pending marker too
      continue;
    }
    // `committed`: the crash landed between the phase flip and the marker/staging cleanup.
    await rmrf(stagingDir(rootReal, j.manifestDigest));
    await ensureAppliedMarker(rootReal, j);
    await finalizeJournal(rootReal, j.manifestDigest);
  }
  return recovered;
}

interface Prepared {
  staged: StagedTree;
  files: AppliedFile[];
  diffEntries: DiffEntry[];
}

async function prepare(
  rootReal: string,
  bundle: ManifestBundle,
  wantDiff: boolean,
  /** Re-apply of an applied digest: `create` targets that exist are overwritten, not `ERR_EXISTS`. */
  reapply = false,
  /** Root whose `.axiom/cas` holds CAS blobs (PR mode: the shared root, not the worktree). */
  casRoot: string = rootReal,
  /** Staging directory override (dry-run on a root without `.axiom/` stages in os.tmpdir()). */
  stgOverride?: string,
): Promise<Prepared> {
  const { manifest, manifestDigest } = bundle;
  validateArtifactPaths(manifest.artifacts);
  for (const a of manifest.artifacts) {
    checkReservedDir(a.path);
  }
  const caseInsensitive = await probeCaseInsensitive(rootReal, {
    create: stgOverride === undefined,
  });
  const axiomReal = await reservedDirReal(rootReal);
  const gitReal = await gitDirReal(rootReal);

  // S-402: a manifest compiled against a tree names that tree. On a FIRST apply the
  // declared pre-images must still hold; a re-apply (marker present) is exempt — the
  // manifest's own writes changed the tree, and drift is handled by `drifted`.
  if (!reapply && manifest.preImage !== undefined) {
    for (const p of manifest.preImage) {
      const { abs } = await resolveContained(rootReal, p.path);
      const now = await fileDigestOrAbsent(abs);
      if (now !== p.sha256) {
        throw new AxiomError(
          "ERR_PREIMAGE_CHANGED",
          "tree differs from the manifest pre-image (compiled against a different tree)",
          { path: p.path, details: { expected: p.sha256, actual: now, phase: "prepare" } },
        );
      }
    }
  }

  // Containment + target type + pre-image capture, all before any write.
  const files: StagedFile[] = [];
  for (const a of manifest.artifacts) {
    const { abs, parentReal } = await resolveContained(rootReal, a.path);
    // Name aliases the string check cannot see (8.3 `AXIOM~1`, case-insensitive volumes).
    checkReservedDir(a.path, parentReal, axiomReal, gitReal);
    await checkTargetType(abs, a.path, reapply && a.op === "create" ? "overwrite" : a.op);
    // Every existing segment, not only the last one: `SRC/main.ts` must not write through `src/`.
    await checkOnDiskPathCollision(rootReal, a.path, caseInsensitive);
    const preImage = await fileDigestOrAbsent(abs);
    // A drifted `create` is committed as an overwrite so the foreign pre-image is backed up.
    const op: ArtifactOp =
      reapply && a.op === "create" && preImage !== "absent" ? "overwrite" : a.op;
    const f: StagedFile = { path: a.path, op, preImage, parentReal };
    if (a.digest !== undefined) f.digest = a.digest.sha256;
    files.push(f);
  }

  // Resolve every blob before writing anything.
  const casDir = path.join(casRoot, ".axiom", "cas");
  const contents = new Map<string, Uint8Array>();
  for (const a of manifest.artifacts) {
    if (a.op === "delete") continue;
    contents.set(a.path, await resolveContent(bundle, a, casDir));
  }

  // Staging tree.
  const stg = stgOverride ?? stagingDir(rootReal, manifestDigest);
  await rmrf(stg);
  await fs.mkdir(nsPath(stg), { recursive: true });
  for (const [i, a] of manifest.artifacts.entries()) {
    const f = files[i];
    if (f === undefined || a.op === "delete") continue;
    const bytes = contents.get(a.path);
    if (bytes === undefined) throw new AxiomError("ERR_INTERNAL", "content vanished");
    const sp = path.join(stg, ...a.path.split("/"));
    await writeAtomic(sp, bytes, a.mode);
    f.stagingPath = sp;
  }

  const applied: AppliedFile[] = [];
  const diffEntries: DiffEntry[] = [];
  for (const a of manifest.artifacts) {
    const f = files.find((x) => x.path === a.path);
    const out: AppliedFile = {
      path: a.path,
      op: a.op,
      status: a.op === "delete" ? (f?.preImage === "absent" ? "skipped" : "deleted") : "written",
    };
    if (a.digest !== undefined) out.digest = a.digest;
    applied.push(out);
    if (wantDiff) {
      const abs = path.join(rootReal, ...a.path.split("/"));
      const st = await lstatOrNull(abs);
      const before = st?.isFile() ? new Uint8Array(await fs.readFile(nsPath(abs))) : undefined;
      diffEntries.push({ path: a.path, before, after: contents.get(a.path) });
    }
  }
  return {
    staged: { root: rootReal, stagingDir: stg, manifestDigest, files },
    files: applied,
    diffEntries,
  };
}

async function backupPreImage(
  rootReal: string,
  digest: DigestRef,
  relPath: string,
  target: string,
): Promise<void> {
  const rel = `.axiom/backup/${hexOf(digest)}/${relPath}`;
  const abs = path.join(rootReal, ...rel.split("/"));
  await fs.mkdir(nsPath(path.dirname(abs)), { recursive: true });
  try {
    await fs.link(nsPath(target), nsPath(abs));
  } catch {
    await fs.copyFile(nsPath(target), nsPath(abs));
  }
}

/**
 * A1-17: commit a `create` with link-then-unlink. A plain rename would silently replace a file
 * that appeared between the pre-image re-hash and the move — with no backup, because the
 * recorded pre-image was `absent`. `link` fails with `EEXIST` in exactly that case, which the
 * caller maps to `ERR_PREIMAGE_CHANGED`.
 */
async function linkIntoPlace(stagingPath: string, target: string, relPath: string): Promise<void> {
  const concurrent = (): AxiomError =>
    new AxiomError("ERR_PREIMAGE_CHANGED", "target appeared between staging and commit", {
      path: relPath,
      details: { reason: "created-concurrently" },
    });
  try {
    await fs.link(nsPath(stagingPath), nsPath(target));
  } catch (err) {
    const c = errnoCode(err);
    if (c === "EEXIST") throw concurrent();
    if (c !== "EPERM" && c !== "EACCES" && c !== "ENOSYS" && c !== "EXDEV" && c !== "ENOTSUP") {
      throw err;
    }
    // No hardlink support on this volume: keep the guarantee as far as the filesystem allows.
    if ((await lstatOrNull(target)) !== null) throw concurrent();
    await renameRetry(stagingPath, target, relPath);
    return;
  }
  await fs.rm(nsPath(stagingPath), { force: true });
}

async function commit(rootReal: string, staged: StagedTree, journal: Journal): Promise<Journal> {
  // Mutates `journal.steps` in place so the caller can roll back with the real state on error.
  const steps: JournalStep[] = journal.steps;
  const j: Journal = { ...journal, phase: "committing", steps };
  await writeJournal(rootReal, j);
  const axiomReal = await reservedDirReal(rootReal);
  const gitReal = await gitDirReal(rootReal);
  let sinceFsync = 0;
  for (const [i, f] of staged.files.entries()) {
    const step = steps[i];
    if (step === undefined) continue;
    const target = path.join(rootReal, ...f.path.split("/"));
    // A1-2: containment is re-resolved per step, right before the move, and compared with the
    // parent captured in `prepare`. `resolveContained` itself is the guarantee (a parent swapped
    // for a junction, or a path that now climbs out of the root, throws); the comparison is the
    // backstop A1-2 asks for. It allows the parent to be DEEPER than the captured one — that is
    // this very bundle creating its own directories — and refuses an unrelated realpath.
    const { parentReal } = await resolveContained(rootReal, f.path);
    if (parentReal !== f.parentReal && !isContained(f.parentReal, parentReal)) {
      throw new AxiomError(
        "ERR_CONTAINMENT",
        "parent directory changed between staging and commit",
        { path: f.path, details: { expected: f.parentReal, actual: parentReal } },
      );
    }
    checkReservedDir(f.path, parentReal, axiomReal, gitReal);
    // TOCTOU guard: pre-image must be exactly what we captured at staging time.
    const now = await fileDigestOrAbsent(target);
    if (now !== f.preImage) {
      throw new AxiomError("ERR_PREIMAGE_CHANGED", "target changed between staging and commit", {
        path: f.path,
        details: { expected: f.preImage, actual: now },
      });
    }
    let backedUp = false;
    if (f.op === "delete") {
      if (f.preImage !== "absent") {
        await backupPreImage(rootReal, j.manifestDigest, f.path, target);
        backedUp = true;
        // The backup may be a hardlink to `target`; POSIX rename(target, backup) would then
        // be a no-op and leave the file in place. The pre-image is already preserved, so unlink.
        await unlinkRetry(target, f.path);
      }
    } else {
      if (f.op === "overwrite" && f.preImage !== "absent") {
        await backupPreImage(rootReal, j.manifestDigest, f.path, target);
        backedUp = true;
      }
      if (f.stagingPath === undefined) throw new AxiomError("ERR_INTERNAL", "missing staging path");
      await fs.mkdir(nsPath(path.dirname(target)), { recursive: true });
      // A1-17: a `create` must not overwrite a file that appeared in the window (no backup exists
      // for it); link-then-unlink makes that race fail with EEXIST instead of losing the file.
      if (f.op === "create") await linkIntoPlace(f.stagingPath, target, f.path);
      else await renameRetry(f.stagingPath, target, f.path);
      const written = await fileDigestOrAbsent(target);
      if (written !== f.digest) {
        step.done = true;
        throw new AxiomError("ERR_DIGEST_MISMATCH", "post-commit re-hash differs", {
          path: f.path,
          details: { expected: f.digest, actual: written },
        });
      }
    }
    step.done = true;
    // A1-1: the journal is flushed after every step that took a backup, so a kill can never leave
    // a pre-image on disk that the journal does not know about. The periodic flush still bounds
    // the cost of very large manifests of backup-less steps.
    sinceFsync++;
    if (backedUp || sinceFsync >= JOURNAL_FSYNC_EVERY) {
      await writeJournal(rootReal, j);
      sinceFsync = 0;
    }
  }
  return setPhase(rootReal, j, "committed");
}

/** Two-phase-commit apply of a manifest bundle into `root` (§4.2). Never throws; errors land in `result.error`. */
export async function apply(options: ApplyOptions): Promise<ApplyResult> {
  const { mode } = options;
  // A1-24: from the moment the bundle passes validation, everything below uses the PARSED value.
  // The raw input may be schema-valid without the defaults the engine relies on (`blobs`).
  let bundle = options.bundle;
  const keep = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
  const base = {
    apiVersion: API_VERSION,
    kind: "ApplyResult" as const,
    manifestDigest: bundle.manifestDigest,
    mode,
  };
  const fail = (
    root: string,
    err: unknown,
    status: "failed" | "rolled-back" = "failed",
  ): ApplyResult => ({
    ...base,
    status,
    root,
    files: [],
    error: toApplyError(err),
  });

  let rootReal: string;
  try {
    rootReal = await realRoot(options.root);
  } catch (err) {
    return fail(options.root, err);
  }

  try {
    if (mode !== "dry-run" && options.confirmDigest !== bundle.manifestDigest) {
      throw new AxiomError(
        "ERR_CONFIRM_DIGEST_MISMATCH",
        "confirmDigest must equal bundle.manifestDigest",
        {
          details: { confirmDigest: options.confirmDigest, manifestDigest: bundle.manifestDigest },
        },
      );
    }
    const parsed = ManifestBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      throw new AxiomError("ERR_INVALID_MANIFEST", "bundle does not match schema", {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      });
    }
    bundle = parsed.data;
    const recomputed = canonicalDigestRef(bundle.manifest);
    if (recomputed !== bundle.manifestDigest) {
      throw new AxiomError(
        "ERR_NOT_CANONICAL",
        "manifestDigest does not match canonical hash of manifest",
        {
          details: { declared: bundle.manifestDigest, recomputed },
        },
      );
    }
  } catch (err) {
    return fail(rootReal, err);
  }

  const touched = bundle.manifest.artifacts.map((a) => a.path);
  const sharedRoot = rootReal;
  /** Self-check: the result we hand out must be schema-valid. */
  const finalize = (r: ApplyResult): ApplyResult => {
    const v = ApplyResultSchema.safeParse(r);
    return v.success
      ? v.data
      : fail(sharedRoot, new AxiomError("ERR_INTERNAL", "result failed schema validation"));
  };

  /**
   * The 2PC engine (§4.2) against the tree `rootReal` (the shared root, or a PR worktree —
   * the parameter deliberately shadows the outer root so the body is mode-agnostic). CAS
   * blobs are read from `casRoot`. Caller holds the shared root's lock.
   */
  const runEngine = async (
    rootReal: string,
    casRoot: string,
    /** Dry-run on a root without `.axiom/`: stage in os.tmpdir(), write nothing under the root. */
    tmpStaging?: string,
    /** `false` for a dry-run: a read-annotated preview never mutates the tree (A1-13). */
    recover = true,
  ): Promise<ApplyResult> => {
    if (recover) await recoverIfNeeded(rootReal);

    // Idempotency (design §apply): applied marker + on-disk match → noop; marker but
    // drifted files → re-apply, reporting which artifacts were re-written.
    let drifted: string[] | undefined;
    if ((await lstatOrNull(appliedPath(rootReal, bundle.manifestDigest))) !== null) {
      drifted = await driftedArtifacts(rootReal, bundle.manifest.artifacts);
      if (drifted.length === 0) {
        return {
          ...base,
          status: "noop",
          root: rootReal,
          files: bundle.manifest.artifacts.map((a) => {
            const f: AppliedFile = { path: a.path, op: a.op, status: "unchanged" };
            if (a.digest !== undefined) f.digest = a.digest;
            return f;
          }),
        } satisfies ApplyResult;
      }
    }

    let prepared: Prepared;
    try {
      prepared = await prepare(
        rootReal,
        bundle,
        mode === "dry-run",
        drifted !== undefined,
        casRoot,
        tmpStaging,
      );
    } catch (err) {
      await rmrf(tmpStaging ?? stagingDir(rootReal, bundle.manifestDigest));
      return fail(rootReal, err);
    }
    const { staged } = prepared;

    try {
      if (options.preChecks !== undefined) {
        const report = await options.preChecks(staged);
        if (report.verdict !== "pass") {
          throw new AxiomError("ERR_CHECKS_FAILED", `pre-apply checks: ${report.verdict}`, {
            details: {
              verdict: report.verdict,
              findings: report.findings.filter((f) => f.severity === "error").map((f) => f.id),
            },
          });
        }
      }
    } catch (err) {
      await rmrf(staged.stagingDir);
      return fail(rootReal, err);
    }

    if (mode === "dry-run") {
      const diff = unifiedDiff(prepared.diffEntries);
      await rmrf(staged.stagingDir);
      const dry: ApplyResult = {
        ...base,
        status: "applied",
        root: rootReal,
        files: prepared.files,
        diff,
      };
      if (drifted !== undefined) dry.drifted = drifted;
      return dry;
    }

    // Phase 1 complete → journal `staged`, fsynced.
    const steps: JournalStep[] = staged.files.map((f) => {
      const s: JournalStep = { path: f.path, op: f.op, preImage: f.preImage, done: false };
      if (f.op !== "delete" && f.digest !== undefined) s.postImage = f.digest;
      return s;
    });
    let journal = newJournal(bundle.manifestDigest, steps);
    const journalFile = await writeJournal(rootReal, journal);

    // Phase 2.
    try {
      journal = await commit(rootReal, staged, journal);
    } catch (err) {
      try {
        await rollbackJournal(rootReal, journal);
      } catch (rbErr) {
        // A1-28: a commit that failed AND could not be rolled back is exactly the state the chain
        // must carry forward — record it as a terminal `failed` entry with its code.
        await chainTerminal(rootReal, journal, { state: "failed", code: "ERR_ROLLBACK" });
        return {
          ...fail(rootReal, rollbackFailure(err, rbErr), "failed"),
          journal: journalFile,
        };
      }
      return { ...fail(rootReal, err, "rolled-back"), journal: journalFile };
    }
    await chainTerminal(rootReal, journal);

    const done: ApplyResult = {
      ...base,
      status: "applied",
      root: rootReal,
      files: prepared.files,
      journal: journalFile,
    };
    if (drifted !== undefined) done.drifted = drifted;
    await writeAppliedMarker(rootReal, done);
    await rmrf(staged.stagingDir);
    // A1-18: the digest leaves the pending index only now — the marker exists and no staging tree
    // is left, so recovery has nothing to do for it and must not pay for reading it again.
    await finalizeJournal(rootReal, bundle.manifestDigest);
    await pruneBackups(rootReal, keep);
    return done;
  };

  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;

  if (mode === "dry-run") {
    // Read-only: never registers an intent, never fails ERR_CONFLICT, and never runs crash
    // recovery (A1-13) — it reports the interrupted journals instead.
    try {
      const interrupted = await interruptedDigests(sharedRoot);
      let result: ApplyResult;
      if ((await lstatOrNull(axiomDir(sharedRoot))) === null) {
        // No AXIOM state to protect or recover: no lock, staging outside the repo (S-rc3 P2:
        // a preview must not create `.axiom/{queue,staging,tmp}` in a repo that had none).
        const tmp = await fs.mkdtemp(path.join(tmpdir(), "axiom-dry-"));
        try {
          result = await runEngine(sharedRoot, sharedRoot, path.join(tmp, "staging"), false);
        } finally {
          await rmrf(tmp);
        }
      } else {
        result = await withLock(
          sharedRoot,
          bundle.manifestDigest,
          () => runEngine(sharedRoot, sharedRoot, undefined, false),
          lockTimeoutMs,
        );
      }
      if (interrupted.length > 0) result = { ...result, interrupted };
      return finalize(result);
    } catch (err) {
      return fail(sharedRoot, err);
    }
  }

  /**
   * S-704 PR mode: the SHARED tree's HEAD, index and files are never touched. Everything
   * happens in an axiom-owned linked worktree at `.axiom/wt/<hex12>` on a new branch started
   * from HEAD; the worktree is removed afterwards and, unless the commit landed, so is the branch.
   * Held under the shared root's lock so git operations on one repo are serialised.
   */
  const runPr = async (): Promise<ApplyResult> => {
    const branch = options.branch ?? defaultBranchName(bundle.manifest.name, bundle.manifestDigest);
    await validateBranchName(sharedRoot, branch);
    await assertRepoToplevel(sharedRoot);
    // Not needed for correctness any more (the worktree starts clean from HEAD), but kept: it
    // is a documented promise (ERR_GIT_DIRTY), and a PR built from HEAD would otherwise
    // silently ignore the user's uncommitted edits to the very paths it rewrites.
    await assertPathsClean(sharedRoot, touched);
    if (await branchExists(sharedRoot, branch)) {
      throw new AxiomError("ERR_GIT_BRANCH_EXISTS", "branch already exists", {
        details: { branch },
      });
    }
    const wtPath = worktreeDir(sharedRoot, bundle.manifestDigest);
    return withLock(
      sharedRoot,
      bundle.manifestDigest,
      async () => {
        // A leftover from a crashed run of the same digest (we hold the lock: nobody uses it).
        await removeWorktree(sharedRoot, wtPath);
        // Re-checked under the lock so a branch we fail to create is never one we then delete.
        if (await branchExists(sharedRoot, branch)) {
          return fail(
            sharedRoot,
            new AxiomError("ERR_GIT_BRANCH_EXISTS", "branch already exists", {
              details: { branch },
            }),
          );
        }
        await fs.mkdir(path.dirname(wtPath), { recursive: true });
        let createdBranch = false;
        let keepBranch = false;
        let engineApplied = false;
        try {
          let wtReal: string;
          try {
            wtReal = await addWorktree(sharedRoot, wtPath, branch);
            createdBranch = true;
          } catch (err) {
            // It did not exist before (checked above, under our intent): if it does now, it is ours.
            createdBranch = await branchExists(sharedRoot, branch).catch(() => false);
            throw err;
          }
          // QA-3: a fresh checkout can differ from the shared tree byte for byte (core.autocrlf or
          // `.gitattributes` rewrite line endings), while the manifest's pre-images were taken from
          // the SHARED tree. Put the shared bytes in place for exactly the paths this bundle
          // touches; the engine then overwrites or deletes every one of them.
          await materializeWorktreePaths(sharedRoot, wtReal, touched);
          // Idempotency in PR mode is content-based: HEAD already holds the manifest's result.
          if ((await driftedArtifacts(wtReal, bundle.manifest.artifacts)).length === 0) {
            return {
              ...base,
              status: "noop",
              root: sharedRoot,
              files: bundle.manifest.artifacts.map((a) => {
                const f: AppliedFile = { path: a.path, op: a.op, status: "unchanged" };
                if (a.digest !== undefined) f.digest = a.digest;
                return f;
              }),
            } satisfies ApplyResult;
          }
          // The worktree's own `.axiom/` (journal, staging, marker) is discarded with it.
          const { journal: _wtJournal, ...r } = await runEngine(wtReal, sharedRoot);
          if (r.status !== "applied") return { ...r, root: sharedRoot };
          engineApplied = true;
          const paths = r.files
            .filter((f) => f.status === "written" || f.status === "deleted")
            .map((f) => f.path);
          if (paths.length > 0) await runGit(wtReal, ["add", "--", ...paths]);
          const message =
            options.commitMessage ??
            defaultCommitMessage(
              bundle.manifest.name,
              bundle.manifestDigest,
              bundle.manifest.planDigest,
            );
          await runGit(wtReal, ["commit", "--quiet", "-F", "-"], { stdin: message });
          const commitSha = await headCommit(wtReal);
          keepBranch = true;
          const git: NonNullable<ApplyResult["git"]> = { branch, commit: commitSha };
          const compareUrl = await compareUrlFor(sharedRoot, branch);
          if (compareUrl !== undefined) git.compareUrl = compareUrl;
          return { ...r, root: sharedRoot, git };
        } catch (err) {
          // Nothing reached the shared tree; a commit that did not land is reported rolled-back.
          return fail(sharedRoot, err, engineApplied ? "rolled-back" : "failed");
        } finally {
          await removeWorktree(sharedRoot, wtPath);
          if (createdBranch && !keepBranch) {
            await runGit(sharedRoot, ["branch", "--quiet", "-D", branch]).catch(() => undefined);
          }
        }
      },
      lockTimeoutMs,
    );
  };

  // S-703: announce what we are about to touch BEFORE queueing for the lock; an overlapping
  // live intent of another manifest → ERR_CONFLICT up front instead of a late TOCTOU failure.
  let intent: Intent;
  try {
    intent = await registerIntent(sharedRoot, bundle.manifestDigest, touched);
  } catch (err) {
    return fail(sharedRoot, err);
  }
  try {
    const r =
      mode === "pr"
        ? await runPr()
        : await withLock(
            sharedRoot,
            bundle.manifestDigest,
            () => runEngine(sharedRoot, sharedRoot),
            lockTimeoutMs,
          );
    return finalize(r);
  } catch (err) {
    return fail(sharedRoot, err);
  } finally {
    await intent.release().catch(() => undefined);
  }
}

export { sha256Of };
