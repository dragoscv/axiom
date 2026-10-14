import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import type { PreImageEntry } from "@codai/axiom-schema";

export interface PreImageDrift {
  path: string;
  expected: string;
  actual: string;
}

/** sha256 of a regular file under `root`, or `absent` (missing, directory, symlink). */
export async function currentPreImage(root: string, relPath: string): Promise<string> {
  const abs = join(root, ...relPath.split("/"));
  try {
    // Open first, then confirm via lstat that the path is a regular file (not a symlink) and is
    // the inode we hold: a swap between the calls reads as drift, never as a hash of other bytes.
    const fh = await open(abs, "r");
    try {
      const now = await fh.stat();
      const st = await lstat(abs);
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return "absent";
      if (!st.isFile()) return "absent";
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
