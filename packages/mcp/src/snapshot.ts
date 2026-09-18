/**
 * `axiom_repo_snapshot` — deterministic, content-addressed inventory of a root (S-304).
 *
 * Successor of the v1 reverse-IR, which guessed "service types" from directory names and
 * hashed nothing. A RepoSnapshot records what is actually there — relative path, size,
 * sha256, mode, kind — sorted by `compareUtf8`, with no timestamps and no absolute paths, so
 * the same tree yields the same `snapshotDigest` on every machine (invariant 1). Agents use
 * it to build Plans against real pre-image digests and to diff two states of a tree.
 *
 * Read-only: never follows symlinks, never leaves the root, never spawns a process.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { canonicalDigestRef } from "@codai/axiom-canon";
import {
  AxiomError,
  compareUtf8,
  isValidRelPath,
  type RepoSnapshot,
  type RepoSnapshotBody,
  type RepoSnapshotEntry,
} from "@codai/axiom-schema";
import { isSameOrInside } from "./roots.js";

export const SNAPSHOT_MAX_FILES_DEFAULT = 20_000;
export const SNAPSHOT_MAX_FILES_CAP = 50_000;
export const SNAPSHOT_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;

/** Never inventoried, whatever `.gitignore` says. */
const ALWAYS_SKIP: ReadonlySet<string> = new Set([".git", ".axiom"]);

export interface SnapshotOptions {
  /** Globs (relative POSIX, `*`/`**`/`?` only); when given, only matching files are kept. */
  include?: readonly string[];
  /** Globs excluded after `include`. */
  exclude?: readonly string[];
  maxFiles?: number;
  maxBytes?: number;
  /** Symlinks are never followed; `true` is rejected. */
  followSymlinks?: boolean;
  /** Read `<root>/.gitignore` (root file only, negations dropped) and skip matches. Default true. */
  respectGitignore?: boolean;
  /** Hash file contents. Default true; `false` records sizes only. */
  withContentDigest?: boolean;
}

// --- globs (tiny, dependency-free: `**`, `*`, `?`, literal) --------------------------------

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

type Matcher = (rel: string) => boolean;

function matcherOf(globs: readonly string[] | undefined, whenEmpty: boolean): Matcher {
  if (globs === undefined || globs.length === 0) return () => whenEmpty;
  const res = globs.map(globToRegExp);
  return (rel) => res.some((r) => r.test(rel));
}

/** A glob must itself be a contained relative path once wildcards are removed (`..` → rejected). */
function validateGlob(g: string, label: string): void {
  const probe = g.replace(/\*+/g, "x").replace(/\?/g, "x").replace(/\/+$/, "");
  if (probe.length === 0 || !isValidRelPath(probe)) {
    throw new AxiomError(
      "ERR_CONTAINMENT",
      `${label} glob must be a contained relative path: ${g}`,
      {
        details: { glob: g },
      },
    );
  }
}

/** Root `.gitignore` → matchers, same rough translation the repo facts use (negations dropped). */
async function gitignoreMatcher(root: string): Promise<Matcher> {
  let text: string;
  try {
    text = await readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    return () => false;
  }
  const globs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.length === 0 || l.startsWith("#") || l.startsWith("!")) continue;
    let pat = l.startsWith("/") ? l.slice(1) : l.includes("/") ? l : `**/${l}`;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    globs.push(pat, `${pat}/**`);
  }
  return matcherOf(globs, false);
}

// --- hashing ---------------------------------------------------------------------------------

function sha256File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(abs)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

function modeOf(mode: number): "0644" | "0755" {
  // Windows reports 0666 for everything; an owner-exec bit is the only signal we keep.
  return process.platform !== "win32" && (mode & 0o100) !== 0 ? "0755" : "0644";
}

// --- walk ------------------------------------------------------------------------------------

/**
 * Inventory `rootReal` (already realpath'd and authorised by the caller).
 * The walk visits entries in `compareUtf8` order of their relative path (directories keyed with
 * a trailing `/`), which is exactly the final sort order — so a truncated `files` is the first
 * N paths of the full sorted inventory, deterministically.
 */
export async function snapshotRoot(
  rootReal: string,
  opts: SnapshotOptions = {},
): Promise<RepoSnapshot> {
  if (opts.followSymlinks === true) {
    throw new AxiomError(
      "ERR_UNSUPPORTED_OP",
      "followSymlinks is not supported (symlinks are recorded, never followed)",
    );
  }
  const maxFiles = Math.min(opts.maxFiles ?? SNAPSHOT_MAX_FILES_DEFAULT, SNAPSHOT_MAX_FILES_CAP);
  const maxBytes = opts.maxBytes ?? SNAPSHOT_MAX_BYTES_DEFAULT;
  if (maxFiles < 1 || maxBytes < 0) {
    throw new AxiomError("ERR_INVALID_PLAN", "maxFiles must be ≥ 1 and maxBytes ≥ 0", {
      details: { maxFiles, maxBytes },
    });
  }
  for (const g of opts.include ?? []) validateGlob(g, "include");
  for (const g of opts.exclude ?? []) validateGlob(g, "exclude");
  const include = matcherOf(opts.include, true);
  const exclude = matcherOf(opts.exclude, false);
  const ignored = opts.respectGitignore === false ? () => false : await gitignoreMatcher(rootReal);
  const withDigest = opts.withContentDigest !== false;

  const files: RepoSnapshotEntry[] = [];
  let bytes = 0;
  let truncated = false;

  const visit = async (dirAbs: string, dirRel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      const dir = await opendir(dirAbs);
      entries = [];
      for await (const e of dir) entries.push(e);
    } catch {
      return; // unreadable directory: skipped, never a crash (READ tool)
    }
    const sortKey = (d: Dirent): string => (d.isDirectory() ? `${d.name}/` : d.name);
    entries.sort((a, b) => compareUtf8(sortKey(a), sortKey(b)));
    for (const e of entries) {
      if (truncated) return;
      const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
      if (!isValidRelPath(rel)) continue; // un-representable on another platform → not part of the inventory
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || ignored(rel) || exclude(rel)) continue;
        await visit(path.join(dirAbs, e.name), rel);
        continue;
      }
      if (ignored(rel) || !include(rel) || exclude(rel)) continue;
      const abs = path.join(dirAbs, e.name);
      let entry: RepoSnapshotEntry | undefined;
      if (e.isSymbolicLink()) entry = await symlinkEntry(rootReal, abs, rel, withDigest);
      else if (e.isFile()) entry = await fileEntry(abs, rel, withDigest);
      if (entry === undefined) continue;
      if (files.length >= maxFiles || bytes + entry.bytes > maxBytes) {
        truncated = true;
        return;
      }
      files.push(entry);
      bytes += entry.bytes;
    }
  };
  await visit(rootReal, "");

  files.sort((a, b) => compareUtf8(a.path, b.path));
  const body: RepoSnapshotBody = {
    files,
    truncated,
    counts: { files: files.length, bytes },
  };
  return {
    apiVersion: "axiom.dev/v2",
    kind: "RepoSnapshot",
    root: { kind: "relative" },
    snapshotDigest: canonicalDigestRef(body),
    body,
  };
}

async function fileEntry(
  abs: string,
  rel: string,
  withDigest: boolean,
): Promise<RepoSnapshotEntry | undefined> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  const entry: RepoSnapshotEntry = {
    path: rel,
    bytes: st.size,
    mode: modeOf(st.mode),
    kind: "file",
  };
  if (withDigest) {
    try {
      entry.sha256 = await sha256File(abs);
    } catch {
      return undefined; // vanished or unreadable between lstat and read
    }
  }
  return entry;
}

/**
 * A symlink is recorded as `kind: "symlink"`. Its target is hashed only when it resolves to a
 * regular file *inside* the root; anything else (outside, dangling, directory) gets
 * `bytes: 0` and no digest — the link is inventoried, its target is not disclosed.
 */
async function symlinkEntry(
  rootReal: string,
  abs: string,
  rel: string,
  withDigest: boolean,
): Promise<RepoSnapshotEntry | undefined> {
  const entry: RepoSnapshotEntry = { path: rel, bytes: 0, mode: "0644", kind: "symlink" };
  let target: string;
  try {
    target = await realpath(abs);
  } catch {
    return entry; // dangling
  }
  if (!isSameOrInside(rootReal, target)) return entry;
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(target);
  } catch {
    return entry;
  }
  if (!st.isFile()) return entry;
  entry.bytes = st.size;
  entry.mode = modeOf(st.mode);
  if (withDigest) {
    try {
      entry.sha256 = await sha256File(target);
    } catch {
      entry.bytes = 0;
    }
  }
  return entry;
}

// --- diff ------------------------------------------------------------------------------------

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: { path: string; from: string | null; to: string | null }[];
}

/** Pure set diff of two snapshots by path; `changed` compares sha256 (or bytes when no digest). */
export function diffSnapshots(a: RepoSnapshot, b: RepoSnapshot): SnapshotDiff {
  const key = (e: RepoSnapshotEntry): string => e.sha256 ?? `bytes:${e.bytes}:${e.kind}`;
  const ma = new Map(a.body.files.map((e) => [e.path, e]));
  const mb = new Map(b.body.files.map((e) => [e.path, e]));
  const out: SnapshotDiff = { added: [], removed: [], changed: [] };
  for (const [p, eb] of mb) {
    const ea = ma.get(p);
    if (ea === undefined) out.added.push(p);
    else if (key(ea) !== key(eb) || ea.mode !== eb.mode || ea.kind !== eb.kind) {
      out.changed.push({ path: p, from: ea.sha256 ?? null, to: eb.sha256 ?? null });
    }
  }
  for (const p of ma.keys()) if (!mb.has(p)) out.removed.push(p);
  out.added.sort(compareUtf8);
  out.removed.sort(compareUtf8);
  out.changed.sort((x, y) => compareUtf8(x.path, y.path));
  return out;
}
