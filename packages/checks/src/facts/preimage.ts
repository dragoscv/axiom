import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { compareUtf8, type ManifestBody, type PreImageEntry } from "@codai/axiom-schema";
import { isUnder, lstatWalk, realRoot } from "./contained.js";

export interface PreImageDrift {
  path: string;
  expected: string;
  actual: string;
}

export interface PreImageCoverage {
  ok: boolean;
  /** Artifact paths with no `preImage` entry. */
  missing: string[];
  /** `preImage` entries that are not artifacts of this manifest. */
  unexpected: string[];
  /** Paths listed more than once. */
  duplicates: string[];
}

/**
 * A1-20: when a manifest carries `preImage`, its paths must be exactly the artifact paths.
 * `preImage: []` on a bundle with artifacts compared nothing and still reported
 * `preImage: "verified"`, and `verify --pre` answered `ok` with zero paths checked.
 */
export function preImageCovers(manifest: ManifestBody): PreImageCoverage {
  const pre = manifest.preImage;
  if (pre === undefined) return { ok: true, missing: [], unexpected: [], duplicates: [] };
  const listed = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of pre) {
    if (listed.has(e.path)) duplicates.add(e.path);
    listed.add(e.path);
  }
  const artifacts = new Set<string>(manifest.artifacts.map((a) => a.path));
  const missing = [...artifacts].filter((p) => !listed.has(p)).sort(compareUtf8);
  const unexpected = [...listed].filter((p) => !artifacts.has(p)).sort(compareUtf8);
  const dup = [...duplicates].sort(compareUtf8);
  return {
    ok: missing.length === 0 && unexpected.length === 0 && dup.length === 0,
    missing,
    unexpected,
    duplicates: dup,
  };
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
