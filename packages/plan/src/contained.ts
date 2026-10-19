import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/**
 * What lives at `<root>/<relPath>`, read WITHOUT following links. Mirrors apply's
 * `fileDigestOrAbsent`: a symlink or junction in any segment is `non-file:symlink`, never
 * the bytes behind it. A missing path, a path through a regular file and a directory at the
 * target are `absent` (apply's own containment checks reject such writes).
 */
export type PreImageState =
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "absent" }
  | { kind: "non-file"; what: "symlink" | "other" };

const IS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function errno(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

/** `candidate` equals or lies under `root` (both realpath'd); case-insensitive on win32/darwin. */
export function isUnder(rootReal: string, candidateReal: string): boolean {
  const a = IS_CASE_INSENSITIVE ? rootReal.toLowerCase() : rootReal;
  const b = IS_CASE_INSENSITIVE ? candidateReal.toLowerCase() : candidateReal;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** realpath of `root`; a root that does not exist yet is returned unchanged. */
export async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (err) {
    if (errno(err) === "ENOENT") return root;
    throw err;
  }
}

/**
 * Contained read of `relPath` (POSIX, already validated by PlanSchema) under `rootReal`.
 * lstat-walks every segment from the root; the parent's realpath must stay under the root;
 * the open handle must be the inode lstat saw (a swap reads as `non-file`, never as bytes).
 */
export async function readContained(rootReal: string, relPath: string): Promise<PreImageState> {
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
    if (st.isSymbolicLink()) return { kind: "non-file", what: "symlink" };
    const last = i === segments.length - 1;
    if (!last && !st.isDirectory()) return { kind: "absent" };
    if (last && st.isDirectory()) return { kind: "absent" };
    if (last && !st.isFile()) return { kind: "non-file", what: "other" };
  }
  if (!isUnder(rootReal, await realpath(dirname(cur)))) {
    return { kind: "non-file", what: "symlink" };
  }
  const fh = await open(cur, "r");
  try {
    const held = await fh.stat();
    const now = await lstat(cur);
    if (!held.isFile() || !now.isFile() || held.ino !== now.ino || held.dev !== now.dev) {
      return { kind: "non-file", what: "other" };
    }
    return { kind: "file", bytes: new Uint8Array(await fh.readFile()) };
  } finally {
    await fh.close();
  }
}
