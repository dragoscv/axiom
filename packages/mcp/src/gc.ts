import { readdir, readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { acquireLock, listJournals } from "@codai/axiom-apply";
import { AxiomError, ManifestBundleSchema } from "@codai/axiom-schema";
import { manifestsDir } from "./store.js";

export interface GcOptions {
  /**
   * `all-manifests` (default): every artifact digest of every stored manifest is live.
   * `journal`: only manifests named by an in-flight journal or an `applied/` record are live —
   * compiled-but-never-applied manifests no longer pin their blobs.
   */
  keep?: "journal" | "all-manifests";
  dryRun?: boolean;
  /** Only blobs whose mtime is older than this are candidates (protects a compile in flight). */
  olderThanMs?: number;
  /** How long to wait for `.axiom/lock` (default 1 s; a live holder → `ERR_LOCKED`). */
  lockTimeoutMs?: number;
  now?: () => number;
}

export interface GcResult {
  root: string;
  keep: "journal" | "all-manifests";
  dryRun: boolean;
  /** Blobs found under `.axiom/cas/sha256`. */
  scanned: number;
  /** Distinct digests referenced by the live set. */
  live: number;
  /** Live digests that have no blob in the CAS (informational — apply would need them). */
  missing: number;
  removed: { sha: string; bytes: number }[];
  /** Kept although unreferenced, because younger than `olderThanMs`. */
  skippedYoung: number;
  freedBytes: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function casRootDir(root: string): string {
  return path.join(root, ".axiom", "cas", "sha256");
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function loadManifestArtifactDigests(root: string, hex: string): Promise<Set<string>> {
  const file = path.join(manifestsDir(root), `${hex}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AxiomError("ERR_BLOB_MISSING", "a journal names a manifest that is not stored", {
        details: { manifestDigest: `sha256:${hex}`, file },
      });
    }
    throw err;
  }
  const parsed = ManifestBundleSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_MANIFEST", "stored manifest fails ManifestBundleSchema", {
      details: { file },
    });
  }
  const out = new Set<string>();
  for (const a of parsed.data.manifest.artifacts) {
    if (a.digest !== undefined) out.add(a.digest.sha256);
  }
  return out;
}

async function liveManifestHexes(
  root: string,
  keep: "journal" | "all-manifests",
): Promise<Set<string>> {
  const hexes = new Set<string>();
  // In-flight (or crashed) applies always pin their manifest, whatever `keep` says.
  const { journals } = await listJournals(root);
  for (const j of journals) hexes.add(j.manifestDigest.slice("sha256:".length));
  if (keep === "journal") {
    for (const n of await readdirOrEmpty(path.join(root, ".axiom", "applied"))) {
      const m = /^([0-9a-f]{64})\.json$/.exec(n);
      if (m?.[1] !== undefined) hexes.add(m[1]);
    }
    return hexes;
  }
  for (const n of await readdirOrEmpty(manifestsDir(root))) {
    const m = /^([0-9a-f]{64})\.json$/.exec(n);
    if (m?.[1] !== undefined) hexes.add(m[1]);
  }
  return hexes;
}

/**
 * Remove CAS blobs no stored manifest references. Takes `.axiom/lock` (single writer per
 * root) so it never races an apply; a live holder → `ERR_LOCKED`. Temp files (`*.tmp`)
 * left by a crashed writer are removed too. CLI-only — deliberately not an MCP tool.
 */
export async function collectGarbage(root: string, opts: GcOptions = {}): Promise<GcResult> {
  const keep = opts.keep ?? "all-manifests";
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now;
  const lock = await acquireLock(root, "gc", opts.lockTimeoutMs ?? 1000);
  try {
    const live = new Set<string>();
    for (const hex of await liveManifestHexes(root, keep)) {
      for (const d of await loadManifestArtifactDigests(root, hex)) live.add(d);
    }

    const casDir = casRootDir(root);
    const removed: { sha: string; bytes: number }[] = [];
    const present = new Set<string>();
    let scanned = 0;
    let skippedYoung = 0;
    let freedBytes = 0;
    const cutoff = opts.olderThanMs === undefined ? undefined : now() - opts.olderThanMs;
    for (const shard of (await readdirOrEmpty(casDir)).sort()) {
      const shardDir = path.join(casDir, shard);
      for (const name of (await readdirOrEmpty(shardDir)).sort()) {
        const file = path.join(shardDir, name);
        const st = await stat(file).catch(() => undefined);
        if (st === undefined || !st.isFile()) continue;
        if (!HEX64.test(name)) {
          // Orphaned temp file from a crashed writer.
          if (name.endsWith(".tmp") && (cutoff === undefined || st.mtimeMs < cutoff)) {
            if (!dryRun) await rm(file, { force: true });
            removed.push({ sha: name, bytes: st.size });
            freedBytes += st.size;
          }
          continue;
        }
        scanned++;
        present.add(name);
        if (live.has(name)) continue;
        if (cutoff !== undefined && st.mtimeMs >= cutoff) {
          skippedYoung++;
          continue;
        }
        if (!dryRun) await rm(file, { force: true });
        removed.push({ sha: name, bytes: st.size });
        freedBytes += st.size;
      }
    }
    let missing = 0;
    for (const d of live) if (!present.has(d)) missing++;
    return {
      root,
      keep,
      dryRun,
      scanned,
      live: live.size,
      missing,
      removed,
      skippedYoung,
      freedBytes,
    };
  } finally {
    await lock.release();
  }
}

/** `30d`, `12h`, `15m`, `90s`, or bare milliseconds; `undefined` when malformed. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(text.trim());
  if (m === null || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * (mult[unit] ?? 1);
}
