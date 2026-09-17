import { compareUtf8, type ManifestBody } from "@codai/axiom-schema";

export interface ManifestChange {
  path: string;
  /** `sha256:<hex>` of the artifact in `a`, or `null` when `a` deletes it. */
  from: string | null;
  /** `sha256:<hex>` of the artifact in `b`, or `null` when `b` deletes it. */
  to: string | null;
}

export interface ManifestDiff {
  /** Paths present in `b` but not in `a`. */
  added: string[];
  /** Paths present in `a` but not in `b`. */
  removed: string[];
  /** Paths present in both whose digest (or delete-ness) differs. */
  changed: ManifestChange[];
}

function digestOf(a: ManifestBody["artifacts"][number]): string | null {
  return a.digest === undefined ? null : `sha256:${a.digest.sha256}`;
}

/** Compare two manifests by artifact path and digest. Output is sorted by path (UTF-8). */
export function diffManifests(a: ManifestBody, b: ManifestBody): ManifestDiff {
  const byPathA = new Map(a.artifacts.map((x) => [x.path, x] as const));
  const byPathB = new Map(b.artifacts.map((x) => [x.path, x] as const));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ManifestChange[] = [];

  for (const [path, artB] of byPathB) {
    const artA = byPathA.get(path);
    if (artA === undefined) {
      added.push(path);
      continue;
    }
    const from = digestOf(artA);
    const to = digestOf(artB);
    if (from !== to) changed.push({ path, from, to });
  }
  for (const path of byPathA.keys()) {
    if (!byPathB.has(path)) removed.push(path);
  }
  added.sort(compareUtf8);
  removed.sort(compareUtf8);
  changed.sort((x, y) => compareUtf8(x.path, y.path));
  return { added, removed, changed };
}
