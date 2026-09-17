import fs from "node:fs/promises";
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
  checkOnDiskCaseCollision,
  checkTargetType,
  probeCaseInsensitive,
  resolveContained,
  validateArtifactPaths,
} from "./contain.js";
import { type DiffEntry, unifiedDiff } from "./diff.js";
import {
  errnoCode,
  fileDigestOrAbsent,
  IS_WIN32,
  lstatOrNull,
  nsPath,
  rmrf,
  sha256Of,
} from "./fsx.js";
import {
  listJournals,
  newJournal,
  readJournal,
  removeJournal,
  setPhase,
  writeJournal,
} from "./journal.js";
import { withLock } from "./lock.js";
import { realpathNative } from "./realpath.js";
import { renameRetry, writeAtomic } from "./write.js";

export interface StagedFile {
  path: string;
  op: ArtifactOp;
  /** Absolute path of the staged content (absent for delete). */
  stagingPath?: string;
  digest?: string;
  preImage: string;
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
  mode: "dry-run" | "fs";
  confirmDigest?: string;
  keepBackups?: number;
  preChecks?: (staged: StagedTree) => Promise<CheckReport>;
  /** Test hook: override the lock wait (ms). */
  lockTimeoutMs?: number;
}

export const JOURNAL_FSYNC_EVERY = 32;
export const DEFAULT_KEEP_BACKUPS = 3;

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
export function appliedPath(root: string, digest: DigestRef): string {
  return path.join(root, ".axiom", "applied", `${hexOf(digest)}.json`);
}

function toApplyError(err: unknown): ApplyError {
  if (err instanceof AxiomError) {
    const out: ApplyError = { code: err.code, message: err.message };
    if (err.path !== undefined && isValidRelPath(err.path)) out.path = err.path;
    return out;
  }
  return { code: "ERR_INTERNAL", message: err instanceof Error ? err.message : String(err) };
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

async function onDiskMatchesAll(
  rootReal: string,
  artifacts: readonly ManifestArtifact[],
): Promise<boolean> {
  for (const a of artifacts) {
    const cur = await fileDigestOrAbsent(path.join(rootReal, ...a.path.split("/")));
    if (cur !== expectedDigest(a)) return false;
  }
  return true;
}

async function writeAppliedMarker(rootReal: string, result: ApplyResult): Promise<void> {
  const p = appliedPath(rootReal, result.manifestDigest);
  await writeAtomic(p, new TextEncoder().encode(JSON.stringify(result)));
}

async function pruneBackups(rootReal: string, keep: number): Promise<void> {
  const dir = path.join(rootReal, ".axiom", "backup");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  const entries: { name: string; mtime: number }[] = [];
  for (const n of names) {
    const st = await lstatOrNull(path.join(dir, n));
    if (st?.isDirectory()) entries.push({ name: n, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  for (const e of entries.slice(Math.max(0, keep))) await rmrf(path.join(dir, e.name));
}

/**
 * Scoped rollback of one journal: replay `steps` in reverse. Uses the presence
 * of the staged file as the discriminator for "was the rename performed" so it
 * is correct both in-process and after a crash (a step's `done` flag may not
 * have been fsynced yet).
 */
async function rollbackJournal(rootReal: string, journal: Journal): Promise<Journal> {
  let j = journal;
  if (j.phase !== "rolling-back") j = await setPhase(rootReal, j, "rolling-back");
  const stg = stagingDir(rootReal, j.manifestDigest);
  for (let i = j.steps.length - 1; i >= 0; i--) {
    const step = j.steps[i];
    if (step === undefined) continue;
    const segs = step.path.split("/");
    const target = path.join(rootReal, ...segs);
    const staged = path.join(stg, ...segs);
    const backupAbs =
      step.backup === undefined ? undefined : path.join(rootReal, ...step.backup.split("/"));
    const stagedExists = (await lstatOrNull(staged)) !== null;
    const backupExists = backupAbs !== undefined && (await lstatOrNull(backupAbs)) !== null;
    const renamed = step.done || (step.op === "delete" ? backupExists : !stagedExists);
    if (step.op === "create") {
      if (renamed) await fs.rm(nsPath(target), { force: true });
    } else if (step.op === "overwrite") {
      if (renamed && backupAbs !== undefined && backupExists) {
        await renameRetry(backupAbs, target, step.path);
      } else if (!renamed && backupAbs !== undefined && backupExists) {
        // backup taken but rename never happened → target is still the original
        await fs.rm(nsPath(backupAbs), { force: true });
      }
    } else if (backupAbs !== undefined && backupExists) {
      await renameRetry(backupAbs, target, step.path);
    }
  }
  await rmrf(stg);
  await rmrf(backupDir(rootReal, j.manifestDigest));
  return setPhase(rootReal, j, "rolled-back");
}

/** CLI entry: roll back an applied/committing manifest by digest. Returns the final journal. */
export async function rollback(root: string, digest: DigestRef): Promise<Journal> {
  const rootReal = await realRoot(root);
  return withLock(rootReal, digest, async () => {
    const j = await readJournal(rootReal, digest);
    if (j === undefined) {
      throw new AxiomError("ERR_NOT_FOUND", "no journal for digest", { details: { digest } });
    }
    const out = await rollbackJournal(rootReal, j);
    await fs.rm(appliedPath(rootReal, digest), { force: true });
    return out;
  });
}

/**
 * Crash recovery (§4.2): any journal left in `committing`/`rolling-back` is
 * rolled back; `staged` journals are discarded with their staging tree;
 * `committed` journals only need their staging tree removed. Caller must hold the lock.
 */
export async function recoverIfNeeded(rootReal: string): Promise<DigestRef[]> {
  const { journals } = await listJournals(rootReal);
  const recovered: DigestRef[] = [];
  for (const j of journals) {
    if (j.phase === "committing" || j.phase === "rolling-back") {
      await rollbackJournal(rootReal, j);
      await fs.rm(appliedPath(rootReal, j.manifestDigest), { force: true });
      recovered.push(j.manifestDigest);
    } else if (j.phase === "staged") {
      await rmrf(stagingDir(rootReal, j.manifestDigest));
      await removeJournal(rootReal, j.manifestDigest);
    } else if (j.phase === "committed") {
      await rmrf(stagingDir(rootReal, j.manifestDigest));
    }
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
): Promise<Prepared> {
  const { manifest, manifestDigest } = bundle;
  validateArtifactPaths(manifest.artifacts);
  for (const a of manifest.artifacts) {
    if (a.path === ".axiom" || a.path.startsWith(".axiom/")) {
      throw new AxiomError("ERR_CONTAINMENT", "artifacts may not target .axiom/", { path: a.path });
    }
  }
  const caseInsensitive = await probeCaseInsensitive(rootReal);

  // Containment + target type + pre-image capture, all before any write.
  const files: StagedFile[] = [];
  for (const a of manifest.artifacts) {
    const { abs } = await resolveContained(rootReal, a.path);
    await checkTargetType(abs, a.path, a.op);
    if (caseInsensitive) await checkOnDiskCaseCollision(abs, a.path, a.op);
    const preImage = await fileDigestOrAbsent(abs);
    const f: StagedFile = { path: a.path, op: a.op, preImage };
    if (a.digest !== undefined) f.digest = a.digest.sha256;
    files.push(f);
  }

  // Resolve every blob before writing anything.
  const casDir = path.join(rootReal, ".axiom", "cas");
  const contents = new Map<string, Uint8Array>();
  for (const a of manifest.artifacts) {
    if (a.op === "delete") continue;
    contents.set(a.path, await resolveContent(bundle, a, casDir));
  }

  // Staging tree.
  const stg = stagingDir(rootReal, manifestDigest);
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
): Promise<string> {
  const rel = `.axiom/backup/${hexOf(digest)}/${relPath}`;
  const abs = path.join(rootReal, ...rel.split("/"));
  await fs.mkdir(nsPath(path.dirname(abs)), { recursive: true });
  try {
    await fs.link(nsPath(target), nsPath(abs));
  } catch {
    await fs.copyFile(nsPath(target), nsPath(abs));
  }
  return rel;
}

async function commit(rootReal: string, staged: StagedTree, journal: Journal): Promise<Journal> {
  // Mutates `journal.steps` in place so the caller can roll back with the real state on error.
  const steps: JournalStep[] = journal.steps;
  const j: Journal = { ...journal, phase: "committing", steps };
  await writeJournal(rootReal, j);
  let sinceFsync = 0;
  for (const [i, f] of staged.files.entries()) {
    const step = steps[i];
    if (step === undefined) continue;
    const target = path.join(rootReal, ...f.path.split("/"));
    // TOCTOU guard: pre-image must be exactly what we captured at staging time.
    const now = await fileDigestOrAbsent(target);
    if (now !== f.preImage) {
      throw new AxiomError("ERR_PREIMAGE_CHANGED", "target changed between staging and commit", {
        path: f.path,
        details: { expected: f.preImage, actual: now },
      });
    }
    if (f.op === "delete") {
      if (f.preImage !== "absent") {
        step.backup = await backupPreImage(rootReal, j.manifestDigest, f.path, target);
        await renameRetry(target, path.join(rootReal, ...step.backup.split("/")), f.path);
      }
    } else {
      if (f.op === "overwrite" && f.preImage !== "absent") {
        step.backup = await backupPreImage(rootReal, j.manifestDigest, f.path, target);
      }
      if (f.stagingPath === undefined) throw new AxiomError("ERR_INTERNAL", "missing staging path");
      await fs.mkdir(nsPath(path.dirname(target)), { recursive: true });
      await renameRetry(f.stagingPath, target, f.path);
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
    if (++sinceFsync >= JOURNAL_FSYNC_EVERY) {
      await writeJournal(rootReal, j);
      sinceFsync = 0;
    }
  }
  return setPhase(rootReal, j, "committed");
}

/** Two-phase-commit apply of a manifest bundle into `root` (§4.2). Never throws; errors land in `result.error`. */
export async function apply(options: ApplyOptions): Promise<ApplyResult> {
  const { bundle, mode } = options;
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

  let lockErr: unknown;
  let result: ApplyResult | undefined;
  try {
    result = await withLock(
      rootReal,
      bundle.manifestDigest,
      async () => {
        await recoverIfNeeded(rootReal);

        // Idempotency.
        if ((await lstatOrNull(appliedPath(rootReal, bundle.manifestDigest))) !== null) {
          if (await onDiskMatchesAll(rootReal, bundle.manifest.artifacts)) {
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
          prepared = await prepare(rootReal, bundle, mode === "dry-run");
        } catch (err) {
          await rmrf(stagingDir(rootReal, bundle.manifestDigest));
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
          return {
            ...base,
            status: "applied",
            root: rootReal,
            files: prepared.files,
            diff,
          } satisfies ApplyResult;
        }

        // Phase 1 complete → journal `staged`, fsynced.
        const steps: JournalStep[] = staged.files.map((f) => ({
          path: f.path,
          op: f.op,
          done: false,
        }));
        let journal = newJournal(bundle.manifestDigest, steps);
        const journalFile = await writeJournal(rootReal, journal);

        // Phase 2.
        try {
          journal = await commit(rootReal, staged, journal);
        } catch (err) {
          try {
            await rollbackJournal(rootReal, journal);
          } catch (rbErr) {
            return {
              ...fail(rootReal, err, "failed"),
              journal: journalFile,
              error: {
                ...toApplyError(err),
                message: `${toApplyError(err).message}; rollback failed: ${toApplyError(rbErr).message}`,
              },
            };
          }
          return { ...fail(rootReal, err, "rolled-back"), journal: journalFile };
        }

        const done: ApplyResult = {
          ...base,
          status: "applied",
          root: rootReal,
          files: prepared.files,
          journal: journalFile,
        };
        await writeAppliedMarker(rootReal, done);
        await rmrf(staged.stagingDir);
        await pruneBackups(rootReal, keep);
        return done;
      },
      options.lockTimeoutMs,
    );
  } catch (err) {
    lockErr = err;
  }
  if (result === undefined) return fail(rootReal, lockErr);
  // Self-check: the result we hand out must be schema-valid.
  const v = ApplyResultSchema.safeParse(result);
  return v.success
    ? v.data
    : fail(rootReal, new AxiomError("ERR_INTERNAL", "result failed schema validation"));
}

export { sha256Of };
