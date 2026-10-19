import { lstat, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { AxiomError } from "@codai/axiom-schema";

/** win32 and darwin default to case-insensitive filesystems. */
export const CASE_INSENSITIVE_FS: boolean =
  process.platform === "win32" || process.platform === "darwin";

function errno(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

/** `candidateReal` equals or lies under `rootReal` (both realpath'd). */
export function isUnder(rootReal: string, candidateReal: string): boolean {
  const a = CASE_INSENSITIVE_FS ? rootReal.toLowerCase() : rootReal;
  const b = CASE_INSENSITIVE_FS ? candidateReal.toLowerCase() : candidateReal;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** realpath of a root; unchanged when it cannot be resolved (callers then see ENOENT). */
export async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

/**
 * Resolve `<rootReal>/<relPath>` for a READ, following in-root links only. Returns the
 * realpath of the target, or `undefined` when it does not exist. A path whose realpath (or,
 * when missing, the realpath of its deepest existing ancestor) lies outside the root — a
 * symlink or junction escape — throws `ERR_CONTAINMENT`: repo facts fail closed rather than
 * answering with bytes or existence from outside the authorised root.
 */
export async function resolveForRead(
  rootReal: string,
  relPath: string,
): Promise<string | undefined> {
  const abs = join(rootReal, ...relPath.split("/"));
  let real: string | undefined;
  try {
    real = await realpath(abs);
  } catch (err) {
    const code = errno(err);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  if (real === undefined) {
    // Missing (or dangling link): the deepest existing ancestor must still be inside.
    let anc = dirname(abs);
    for (;;) {
      try {
        real = await realpath(anc);
        break;
      } catch (err) {
        const code = errno(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        const up = dirname(anc);
        if (up === anc) return undefined;
        anc = up;
      }
    }
    if (!isUnder(rootReal, real)) throw escapeError(relPath, real);
    return undefined;
  }
  if (!isUnder(rootReal, real)) throw escapeError(relPath, real);
  return real;
}

function escapeError(relPath: string, real: string): AxiomError {
  return new AxiomError("ERR_CONTAINMENT", "repo path resolves outside the authorised root", {
    path: relPath,
    details: { real },
  });
}

/**
 * lstat-walk `relPath` from the root WITHOUT following links. `symlink` when any segment is
 * a symlink or junction; `absent` when a segment is missing or not a directory; otherwise
 * the stats of the final segment.
 */
export async function lstatWalk(
  rootReal: string,
  relPath: string,
): Promise<
  | { kind: "symlink" }
  | { kind: "absent" }
  | { kind: "entry"; abs: string; stats: Awaited<ReturnType<typeof lstat>> }
> {
  const segments = relPath.split("/");
  let cur = rootReal;
  for (let i = 0; i < segments.length; i++) {
    cur = join(cur, segments[i] as string);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(cur);
    } catch (err) {
      const code = errno(err);
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
      throw err;
    }
    if (st.isSymbolicLink()) return { kind: "symlink" };
    if (i === segments.length - 1) return { kind: "entry", abs: cur, stats: st };
    if (!st.isDirectory()) return { kind: "absent" };
  }
  return { kind: "absent" };
}
