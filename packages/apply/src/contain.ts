import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ArtifactOp,
  AxiomError,
  type ManifestArtifact,
  relPathIssues,
} from "@codai/axiom-schema";
import { errnoCode, IS_WIN32, isContained, lstatOrNull, nsPath } from "./fsx.js";
import { realpathNative } from "./realpath.js";

/**
 * §4.1-1..3: schema-level path validation on every OS plus case-insensitive
 * collision detection across the artifact set (NFC + lowercase).
 */
export function validateArtifactPaths(artifacts: readonly Pick<ManifestArtifact, "path">[]): void {
  const seen = new Map<string, string>();
  for (const a of artifacts) {
    const issues = relPathIssues(a.path);
    const first = issues[0];
    if (first !== undefined) {
      const code =
        first === "ERR_PATH_NOT_RELATIVE_POSIX" ||
        first === "ERR_PATH_SEGMENT" ||
        first === "ERR_PATH_NOT_NFC" ||
        first === "ERR_PATH_RESERVED_NAME" ||
        first === "ERR_PATH_INVALID_CHAR"
          ? first
          : "ERR_PATH_SEGMENT";
      throw new AxiomError(code, `invalid artifact path: ${issues.join(",")}`, {
        path: a.path,
        details: { issues },
      });
    }
    const key = a.path.normalize("NFC").toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new AxiomError("ERR_PATH_CASE_COLLISION", "artifact paths collide case-insensitively", {
        path: a.path,
        details: { other: prev },
      });
    }
    seen.set(key, a.path);
  }
}

export interface ResolvedTarget {
  /** Absolute target path (`rootReal` + relPath), not realpath'd (target may not exist). */
  abs: string;
  /** realpath.native of the deepest existing ancestor directory. */
  parentReal: string;
}

/** AXIOM's own state directory; artifacts may never write into it, under any alias. */
export const RESERVED_DIR = ".axiom";

/**
 * Git's own state directory. Reserved exactly like `.axiom`: a transactional write must never
 * plant a hook, rewrite `config` or replace an object file (A1-14 / A1-29). The gate denies
 * `.git/**` through checks; apply refuses it independently, on every platform.
 */
export const RESERVED_DIR_GIT = ".git";

const RESERVED_DIRS: readonly string[] = [RESERVED_DIR, RESERVED_DIR_GIT];

/** First path segment equals `.axiom` after NFC + lowercase (`.AXIOM/x`, `.Axiom/x`, …). */
export function isReservedAxiomPath(relPath: string): boolean {
  const first = relPath.split("/")[0] ?? "";
  return first.normalize("NFC").toLowerCase() === RESERVED_DIR;
}

/** First path segment equals `.axiom` or `.git` after NFC + lowercase (`.GIT/config`, …). */
export function isReservedDirPath(relPath: string): boolean {
  const first = (relPath.split("/")[0] ?? "").normalize("NFC").toLowerCase();
  return RESERVED_DIRS.some((d) => d === first);
}

/** The reserved directory the first segment names, or `undefined`. */
function reservedDirNamedBy(relPath: string): string | undefined {
  const first = (relPath.split("/")[0] ?? "").normalize("NFC").toLowerCase();
  return RESERVED_DIRS.find((d) => d === first);
}

/**
 * Refuse a target inside AXIOM's state directory: by name (case/normalisation-insensitive) and,
 * when `axiomReal` (realpath of `<root>/.axiom`) is known, by the resolved parent — which catches
 * aliases the name check cannot see (Windows 8.3 short names such as `AXIOM~1`).
 * `.git` is refused the same way, with `gitReal` (realpath of `<root>/.git`) as its alias probe.
 */
export function checkReservedDir(
  relPath: string,
  parentReal?: string,
  axiomReal?: string,
  gitReal?: string,
): void {
  const named = reservedDirNamedBy(relPath);
  const byName = named !== undefined;
  const underAxiom =
    parentReal !== undefined && axiomReal !== undefined && isContained(axiomReal, parentReal);
  const underGit =
    parentReal !== undefined && gitReal !== undefined && isContained(gitReal, parentReal);
  if (byName || underAxiom || underGit) {
    throw new AxiomError("ERR_PATH_RESERVED_DIR", "artifacts may not target a reserved directory", {
      path: relPath,
      details: {
        via: byName ? "name" : "realpath",
        dir: named ?? (underAxiom ? RESERVED_DIR : RESERVED_DIR_GIT),
      },
    });
  }
}

/** realpath.native of `<rootReal>/.axiom`, or undefined when it does not exist. */
export async function reservedDirReal(rootReal: string): Promise<string | undefined> {
  return dirReal(rootReal, RESERVED_DIR);
}

/** realpath.native of `<rootReal>/.git`, or undefined when it does not exist. */
export async function gitDirReal(rootReal: string): Promise<string | undefined> {
  return dirReal(rootReal, RESERVED_DIR_GIT);
}

async function dirReal(rootReal: string, name: string): Promise<string | undefined> {
  try {
    let real = await realpathNative(nsPath(path.join(rootReal, name)));
    if (IS_WIN32 && real.startsWith("\\\\?\\")) real = real.slice(4);
    return real;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * §4.1-4: walk each existing directory segment with `lstat`; symlink/junction →
 * ERR_SYMLINK_IN_PATH. The realpath of the deepest existing ancestor must be
 * inside `rootReal` → else ERR_CONTAINMENT. A segment that exists but is not a
 * directory → ERR_TARGET_TYPE.
 */
export async function resolveContained(rootReal: string, relPath: string): Promise<ResolvedTarget> {
  const segments = relPath.split("/");
  const abs = path.join(rootReal, ...segments);
  // `path.join` normalises, so a `..` segment (or anything else that climbs out) shows up here
  // even when every ancestor that exists is a plain directory (A1-28: the containment property).
  if (!isContained(rootReal, abs)) {
    throw new AxiomError("ERR_CONTAINMENT", "artifact path escapes root", {
      path: relPath,
      details: { abs },
    });
  }
  let cur = rootReal;
  let deepestExisting = rootReal;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = path.join(cur, segments[i] ?? "");
    const st = await lstatOrNull(cur);
    if (st === null) break;
    if (st.isSymbolicLink()) {
      throw new AxiomError("ERR_SYMLINK_IN_PATH", "symlink or junction in artifact path", {
        path: relPath,
        details: { segment: segments.slice(0, i + 1).join("/") },
      });
    }
    if (!st.isDirectory()) {
      throw new AxiomError("ERR_TARGET_TYPE", "path segment is not a directory", {
        path: relPath,
        details: { segment: segments.slice(0, i + 1).join("/") },
      });
    }
    deepestExisting = cur;
  }
  let parentReal: string;
  try {
    parentReal = await realpathNative(nsPath(deepestExisting));
  } catch (err) {
    throw new AxiomError("ERR_CONTAINMENT", "cannot resolve parent directory", {
      path: relPath,
      cause: err,
    });
  }
  if (IS_WIN32 && parentReal.startsWith("\\\\?\\")) parentReal = parentReal.slice(4);
  if (!isContained(rootReal, parentReal)) {
    throw new AxiomError("ERR_CONTAINMENT", "artifact path escapes root", {
      path: relPath,
      details: { parentReal },
    });
  }
  return { abs, parentReal };
}

/**
 * §4.1-5: the target itself. Symlink/dir where a file is expected →
 * ERR_TARGET_TYPE; existing file with op=create → ERR_EXISTS; delete of a
 * non-file → ERR_TARGET_TYPE. Absent delete targets are allowed (idempotent).
 */
export async function checkTargetType(abs: string, relPath: string, op: ArtifactOp): Promise<void> {
  const st = await lstatOrNull(abs);
  if (st === null) return;
  if (st.isSymbolicLink() || st.isDirectory() || !st.isFile()) {
    throw new AxiomError("ERR_TARGET_TYPE", "target exists and is not a regular file", {
      path: relPath,
      details: { kind: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "other" },
    });
  }
  if (op === "create") {
    throw new AxiomError("ERR_EXISTS", "target exists; use op overwrite", { path: relPath });
  }
}

/** Platform default used when probing would have to create `.axiom/` (dry-run on a fresh root). */
export const DEFAULT_CASE_INSENSITIVE: boolean =
  process.platform === "win32" || process.platform === "darwin";

/**
 * §4.1-3: probe once whether the FS under `root` is case-insensitive. With `create: false` and no
 * `.axiom/` under the root, nothing is written and the platform default is returned (read-only
 * dry-run must not create AXIOM state in a repo that has none).
 */
export async function probeCaseInsensitive(
  root: string,
  opts: { create?: boolean } = {},
): Promise<boolean> {
  if (opts.create === false && (await lstatOrNull(path.join(root, RESERVED_DIR))) === null) {
    return DEFAULT_CASE_INSENSITIVE;
  }
  const dir = path.join(root, ".axiom", "tmp");
  await fs.mkdir(dir, { recursive: true });
  const probe = path.join(dir, `CaseProbe-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, "");
    try {
      await fs.lstat(probe.replace(/CaseProbe/, "caseprobe"));
      return true;
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return false;
      throw err;
    }
  } finally {
    await fs.rm(probe, { force: true });
    // A1-28: leave no probe scratch directory behind in a root that had none. Non-recursive on
    // purpose: a directory someone else fills (or that already existed) is left alone.
    await rmdirQuiet(dir);
  }
}

/**
 * Remove an empty directory we created, tolerating the Windows window where a just-unlinked file
 * still pins its parent. `ENOTEMPTY` (someone else is using the directory) is never retried and
 * never an error.
 */
async function rmdirQuiet(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 11; attempt++) {
    try {
      await fs.rmdir(dir);
      return;
    } catch (err) {
      const c = errnoCode(err);
      if (c !== "EPERM" && c !== "EACCES" && c !== "EBUSY") return;
      await sleep(5);
    }
  }
}

/**
 * On a case-insensitive FS an artifact `Foo.ts` must not silently write through an existing
 * `foo.ts` (or an NFD-spelled sibling of an NFC name) — for every op, compare against on-disk
 * sibling names. `details.kind` is `"case"` or `"normalization"`. With `caseInsensitive: false`
 * only normalisation twins are refused (two visually identical names are never intended).
 */
export async function checkOnDiskCaseCollision(
  abs: string,
  relPath: string,
  _op?: ArtifactOp,
  caseInsensitive = true,
): Promise<void> {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let names: string[];
  try {
    names = await fs.readdir(nsPath(dir));
  } catch {
    return;
  }
  const lower = base.normalize("NFC").toLowerCase();
  for (const n of names) {
    if (n !== base && n.normalize("NFC").toLowerCase() === lower) {
      const kind = n.normalize("NFC") === base.normalize("NFC") ? "normalization" : "case";
      if (kind === "case" && !caseInsensitive) continue;
      throw new AxiomError(
        "ERR_PATH_CASE_COLLISION",
        "artifact collides with existing on-disk name",
        {
          path: relPath,
          details: { existing: n, kind },
        },
      );
    }
  }
}

/**
 * A1-14: the whole path, not only its last segment. On a case-insensitive volume `SRC/main.ts`
 * resolves into an existing `src/` and would write through it (and `.GIT/config` into `.git/`).
 * Walk every existing segment and compare NFC + lowercase against the on-disk names; stop at the
 * first segment that does not exist (nothing below it can collide). `kind: "case"` is skipped on a
 * case-sensitive FS; a normalisation twin is refused everywhere.
 */
export async function checkOnDiskPathCollision(
  rootReal: string,
  relPath: string,
  caseInsensitive: boolean,
): Promise<void> {
  let cur = rootReal;
  for (const seg of relPath.split("/")) {
    let names: string[];
    try {
      names = await fs.readdir(nsPath(cur));
    } catch {
      // The directory does not exist (or this segment is a file): nothing below can collide.
      return;
    }
    const target = seg.normalize("NFC").toLowerCase();
    let exact = false;
    for (const n of names) {
      if (n === seg) {
        exact = true;
        continue;
      }
      if (n.normalize("NFC").toLowerCase() !== target) continue;
      const kind = n.normalize("NFC") === seg.normalize("NFC") ? "normalization" : "case";
      if (kind === "case" && !caseInsensitive) continue;
      throw new AxiomError(
        "ERR_PATH_CASE_COLLISION",
        "artifact path aliases an existing on-disk name",
        { path: relPath, details: { existing: n, kind, segment: seg } },
      );
    }
    if (!exact) return;
    cur = path.join(cur, seg);
  }
}
