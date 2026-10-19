import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import type { PreImageEntry } from "@codai/axiom-schema";
import { isUnder, lstatWalk, realRoot } from "./contained.js";

export interface PreImageDrift {
  path: string;
  expected: string;
  actual: string;
}

/**
 * State of `relPath` under `root`, in apply's `fileDigestOrAbsent` vocabulary: sha256 hex of
 * a regular file; `absent` when missing (or a segment is a file); `non-file:symlink` when
 * any segment is a symlink/junction (never followed); `non-file:dir` / `non-file:other`.
 */
export async function currentPreImage(root: string, relPath: string): Promise<string> {
  const rootReal = await realRoot(root);
  const walked = await lstatWalk(rootReal, relPath);
  if (walked.kind === "absent") return "absent";
  if (walked.kind === "symlink") return "non-file:symlink";
  const { abs, stats } = walked;
  if (stats.isDirectory()) return "non-file:dir";
  if (!stats.isFile()) return "non-file:other";
  if (!isUnder(rootReal, await realpath(dirname(abs)))) return "non-file:symlink";
  try {
    // Open first, then confirm via lstat that the path is a regular file (not a symlink) and is
    // the inode we hold: a swap between the calls reads as drift, never as a hash of other bytes.
    const fh = await open(abs, "r");
    try {
      const now = await fh.stat();
      const st = await lstat(abs);
      if (st.isSymbolicLink()) return "non-file:symlink";
      if (!now.isFile() || !st.isFile() || now.ino !== st.ino || now.dev !== st.dev) {
        return "non-file:other";
      }
      return sha256Hex(new Uint8Array(await fh.readFile()));
    } finally {
      await fh.close();
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return "absent";
    throw err;
  }
}

/** Entries whose on-disk state differs from what the manifest recorded (S-402). */
export async function verifyPreImage(
  root: string,
  entries: readonly PreImageEntry[],
): Promise<PreImageDrift[]> {
  const out: PreImageDrift[] = [];
  for (const e of entries) {
    const actual = await currentPreImage(root, e.path);
    if (actual !== e.sha256) out.push({ path: e.path, expected: e.sha256, actual });
  }
  return out;
}
