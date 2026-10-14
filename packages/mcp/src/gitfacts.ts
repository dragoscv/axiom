/**
 * Git-state facts for the gate (v2.6, S-1213, D-39) — read straight from `.git` on disk, never by
 * spawning `git` (the hook latency budget and the no-shell invariant both forbid it).
 *
 * - `gitHead`: `HEAD` → branch / detached / sha (loose refs, then `packed-refs`).
 * - `gitDirtyPaths`: parses the index (DIRC v2/v3/v4) and compares every entry with the worktree
 *   (lstat first, sha1/sha256 of `blob <len>\0<bytes>` only when the stat data disagrees or the
 *   entry is racy). Staged changes are detected through the index's cache-tree (`TREE`) root
 *   against `HEAD^{tree}`; when either side cannot be read the answer is `complete: false`.
 * - `evaluateGit`: the `git.noPathspec`, `git.dirtyTree` and `git.branch` gate rules.
 *
 * Known limits (documented in docs/guides/coordination.md): no clean/smudge filters other than
 * CRLF→LF, no split index (`link` extension → read error), no per-directory `.gitignore`, no
 * negated ignore patterns, deltified commit objects in packs read as "unknown".
 */
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { inflateSync, constants as zlibConstants } from "node:zlib";
import { z } from "zod";
import type { CommandClass } from "./coord.js";
import { commandClasses } from "./coord.js";
import type { RuleVerdict } from "./gate-verdict.js";

// Local literal list: importing coord's enum at module-evaluation time would hit a TDZ when coord
// is the entry point (coord ↔ gitfacts import each other; only runtime calls cross the cycle).
const CLASS_NAMES = ["build", "install", "commit", "deploy"] as const;
const ClassSchema = z.enum(CLASS_NAMES);

export const GitRulesSchema = z.strictObject({
  /** Command classes that require a clean tree (index == HEAD, worktree == index). */
  cleanTreeFor: z.array(ClassSchema).default([]),
  /** Also count untracked files (approximate walk — see the module doc). */
  untracked: z.boolean().default(false),
  /** Refuse a `git commit` at command position without a ` -- <path>` pathspec. */
  requirePathspec: z.boolean().default(false),
  /** Commands of classes `for` only run on a branch matching `is` (exact, or `*` glob). */
  branch: z
    .strictObject({
      is: z.string().min(1),
      for: z.array(ClassSchema).min(1),
      reason: z.string().min(1).optional(),
    })
    .optional(),
});

export type GitRules = z.infer<typeof GitRulesSchema>;

/** Pseudo-path reported when the index (staged state) differs from `HEAD`. */
export const STAGED_PATH = ".git/index";

/** The clean-worktree deploy wrapper builds from its own detached checkout: never dirty-gated. */
const CLEAN_WRAPPER = /deploy-clean\.ps1/i;

// ------------------------------------------------------------------- git dirs --

export interface GitDirs {
  /** Per-checkout git dir (`HEAD`, `index`). */
  gitDir: string;
  /** Shared git dir (`objects`, `refs`, `packed-refs`, `config`). */
  commonDir: string;
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

async function realOr(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolve the git dirs of the checkout rooted at `root` from disk. `.git` directory → itself.
 * `.git` file → its `gitdir:`; a linked worktree (has `commondir`) must carry a back-link
 * (`<gitdir>/gitdir`) naming this very `.git` file, so a hand-made `.git` file cannot borrow
 * another repository's state. Not a git checkout → `undefined`.
 */
export async function gitDirs(root: string): Promise<GitDirs | undefined> {
  const dotGit = path.join(root, ".git");
  const st = await lstat(dotGit).catch(() => undefined);
  if (st === undefined) return undefined;
  if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  if (!st.isFile()) return undefined;
  let text: string;
  try {
    text = await readFile(dotGit, "utf8");
  } catch {
    return undefined;
  }
  const m = /^gitdir:[ \t]*(\S[^\r\n]*)$/m.exec(text);
  if (m?.[1] === undefined) return undefined;
  const gitDir = path.resolve(root, m[1].trim());
  let common: string | undefined;
  try {
    common = (await readFile(path.join(gitDir, "commondir"), "utf8")).trim();
  } catch (err) {
    if (errCode(err) !== "ENOENT") return undefined;
  }
  if (common === undefined) {
    // Submodule-style gitdir file: the gitdir is self-contained.
    const head = await stat(path.join(gitDir, "HEAD")).catch(() => undefined);
    return head?.isFile() === true ? { gitDir, commonDir: gitDir } : undefined;
  }
  try {
    const back = (await readFile(path.join(gitDir, "gitdir"), "utf8")).trim();
    const [backReal, selfReal] = await Promise.all([
      realOr(path.resolve(gitDir, back)),
      realOr(dotGit),
    ]);
    if (!samePath(backReal, selfReal)) return undefined;
  } catch {
    return undefined;
  }
  return { gitDir, commonDir: path.resolve(gitDir, common) };
}

async function hashLenOf(commonDir: string): Promise<20 | 32> {
  const cfg = await readFile(path.join(commonDir, "config"), "utf8").catch(() => "");
  return /^[ \t]*objectformat[ \t]*=[ \t]*sha256[ \t]*$/im.test(cfg) ? 32 : 20;
}

// ----------------------------------------------------------------------- refs --

const HEX_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function safeRefName(ref: string): boolean {
  return (
    ref.startsWith("refs/") && !ref.includes("..") && !ref.includes("\\") && !ref.includes("\0")
  );
}

async function resolveRef(d: GitDirs, ref: string, depth = 0): Promise<string | undefined> {
  if (depth > 5 || !safeRefName(ref)) return undefined;
  const dirs = samePath(d.gitDir, d.commonDir) ? [d.gitDir] : [d.gitDir, d.commonDir];
  for (const dir of dirs) {
    let text: string;
    try {
      text = (await readFile(path.join(dir, ...ref.split("/")), "utf8")).trim();
    } catch {
      continue;
    }
    if (text.startsWith("ref:")) return resolveRef(d, text.slice(4).trim(), depth + 1);
    if (HEX_OID.test(text)) return text.toLowerCase();
  }
  const packed = await readFile(path.join(d.commonDir, "packed-refs"), "utf8").catch(() => "");
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    if (line.slice(sp + 1).trim() === ref) {
      const oid = line.slice(0, sp);
      if (HEX_OID.test(oid)) return oid.toLowerCase();
    }
  }
  return undefined;
}

interface HeadInfo {
  branch?: string;
  detached: boolean;
  sha?: string;
}

async function readHead(d: GitDirs): Promise<HeadInfo | undefined> {
  let head: string;
  try {
    head = (await readFile(path.join(d.gitDir, "HEAD"), "utf8")).trim();
  } catch {
    return undefined;
  }
  if (head.startsWith("ref:")) {
    const ref = head.slice(4).trim();
    const sha = await resolveRef(d, ref);
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
    return {
      ...(branch !== undefined ? { branch } : {}),
      detached: false,
      ...(sha !== undefined ? { sha } : {}),
    };
  }
  if (HEX_OID.test(head)) return { detached: true, sha: head.toLowerCase() };
  return undefined;
}

/** `HEAD` of the checkout at `root`: branch (when on one), detached flag, commit sha (when born). */
export async function gitHead(
  root: string,
): Promise<{ branch?: string; detached: boolean; sha?: string } | undefined> {
  try {
    const d = await gitDirs(root);
    return d === undefined ? undefined : await readHead(d);
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------- objects --

const PACK_READ_BYTES = 64 * 1024;

function inflatePartial(buf: Buffer): Buffer {
  return inflateSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
}

async function readLooseObject(
  commonDir: string,
  hex: string,
): Promise<{ type: string; body: Buffer } | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path.join(commonDir, "objects", hex.slice(0, 2), hex.slice(2)));
  } catch {
    return undefined;
  }
  const data = inflatePartial(raw);
  const nul = data.indexOf(0);
  if (nul < 0) return undefined;
  const header = data.toString("latin1", 0, nul);
  const sp = header.indexOf(" ");
  return { type: header.slice(0, sp), body: data.subarray(nul + 1) };
}

const PACK_TYPES: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

async function readPackedObject(
  commonDir: string,
  oid: Buffer,
): Promise<{ type: string; body: Buffer } | undefined> {
  const packDir = path.join(commonDir, "objects", "pack");
  const names = await readdir(packDir).catch(() => [] as string[]);
  const hashLen = oid.length;
  const first = oid[0] ?? 0;
  for (const name of names) {
    if (!name.endsWith(".idx")) continue;
    const fh = await open(path.join(packDir, name), "r");
    let offset: number | undefined;
    try {
      const head = Buffer.alloc(8 + 256 * 4);
      await fh.read(head, 0, head.length, 0);
      if (head.readUInt32BE(0) !== 0xff744f63 || head.readUInt32BE(4) !== 2) continue;
      const total = head.readUInt32BE(8 + 255 * 4);
      let lo = first === 0 ? 0 : head.readUInt32BE(8 + (first - 1) * 4);
      let hi = head.readUInt32BE(8 + first * 4);
      const cand = Buffer.alloc(hashLen);
      const oidsAt = 8 + 256 * 4;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        await fh.read(cand, 0, hashLen, oidsAt + mid * hashLen);
        const cmp = cand.compare(oid);
        if (cmp === 0) {
          const offsAt = oidsAt + total * hashLen + total * 4;
          const word = Buffer.alloc(4);
          await fh.read(word, 0, 4, offsAt + mid * 4);
          const small = word.readUInt32BE(0);
          if ((small & 0x80000000) === 0) {
            offset = small;
          } else {
            const big = Buffer.alloc(8);
            await fh.read(big, 0, 8, offsAt + total * 4 + (small & 0x7fffffff) * 8);
            offset = Number(big.readBigUInt64BE(0));
          }
          break;
        }
        if (cmp < 0) lo = mid + 1;
        else hi = mid;
      }
    } finally {
      await fh.close();
    }
    if (offset === undefined) continue;
    const pack = await open(path.join(packDir, `${name.slice(0, -4)}.pack`), "r");
    try {
      const buf = Buffer.alloc(PACK_READ_BYTES);
      const { bytesRead } = await pack.read(buf, 0, buf.length, offset);
      let i = 0;
      let c = buf[i++] ?? 0;
      const type = PACK_TYPES[(c >> 4) & 7];
      let size = c & 15;
      let mul = 16;
      while ((c & 0x80) !== 0 && i < bytesRead) {
        c = buf[i++] ?? 0;
        size += (c & 0x7f) * mul;
        mul *= 128;
      }
      // Deltified (ofs/ref delta) objects are not reconstructed: the caller reads "unknown".
      if (type === undefined) return undefined;
      const body = inflatePartial(buf.subarray(i, bytesRead));
      if (body.length < size) return undefined;
      return { type, body: body.subarray(0, size) };
    } finally {
      await pack.close();
    }
  }
  return undefined;
}

/** `HEAD^{tree}` oid; `null` when HEAD is unborn; `undefined` when it cannot be read. */
async function headTree(d: GitDirs, hashLen: number): Promise<Buffer | null | undefined> {
  const head = await readHead(d);
  if (head === undefined) return undefined;
  if (head.sha === undefined) return head.detached ? undefined : null;
  if (head.sha.length !== hashLen * 2) return undefined;
  const obj =
    (await readLooseObject(d.commonDir, head.sha)) ??
    (await readPackedObject(d.commonDir, Buffer.from(head.sha, "hex")));
  if (obj?.type !== "commit") return undefined;
  const m = /^tree ([0-9a-f]+)\n/.exec(obj.body.toString("latin1", 0, 80));
  if (m?.[1] === undefined || m[1].length !== hashLen * 2) return undefined;
  return Buffer.from(m[1], "hex");
}

// ---------------------------------------------------------------------- index --

interface IndexEntry {
  path: string;
  oid: Buffer;
  mode: number;
  size: number;
  mtimeS: number;
  mtimeNs: number;
  stage: number;
  /** skip-worktree or assume-unchanged: the worktree copy is not compared. */
  ignored: boolean;
  intentToAdd: boolean;
}

interface ParsedIndex {
  entries: IndexEntry[];
  /** Cache-tree root oid; `null` = invalidated; `undefined` = no TREE extension. */
  rootTree: Buffer | null | undefined;
}

function corrupt(what: string): never {
  throw new Error(`git index: ${what}`);
}

/** git's offset varint (index v4 path-prefix strip length). */
function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let p = at;
  let c = buf[p++];
  if (c === undefined) corrupt("truncated varint");
  let value = c & 127;
  let guard = 0;
  while ((c & 128) !== 0) {
    if (++guard > 8) corrupt("varint too long");
    c = buf[p++];
    if (c === undefined) corrupt("truncated varint");
    value = (value + 1) * 128 + (c & 127);
  }
  return { value, next: p };
}

function parseTreeRoot(data: Buffer, hashLen: number): Buffer | null | undefined {
  const nul = data.indexOf(0);
  if (nul !== 0) return undefined; // the first record must be the root ("" path)
  const sp = data.indexOf(0x20, 1);
  const nl = data.indexOf(0x0a, 1);
  if (sp < 0 || nl < 0 || nl < sp) return undefined;
  const count = Number.parseInt(data.toString("latin1", 1, sp), 10);
  if (!Number.isFinite(count) || count < 0) return null;
  if (nl + 1 + hashLen > data.length) return undefined;
  return Buffer.from(data.subarray(nl + 1, nl + 1 + hashLen));
}

function parseIndex(buf: Buffer, hashLen: number): ParsedIndex {
  if (buf.length < 12 + hashLen || buf.toString("latin1", 0, 4) !== "DIRC") corrupt("bad header");
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) corrupt(`unsupported version ${version}`);
  const count = buf.readUInt32BE(8);
  const end = buf.length - hashLen;
  const entries: IndexEntry[] = [];
  let off = 12;
  let prev: Buffer = Buffer.alloc(0);
  const fixed = 40 + hashLen + 2;
  for (let i = 0; i < count; i++) {
    const start = off;
    if (start + fixed > end) corrupt("truncated entry");
    const flags = buf.readUInt16BE(start + 40 + hashLen);
    let p = start + fixed;
    let ext = 0;
    if ((flags & 0x4000) !== 0) {
      if (version < 3) corrupt("extended flags in a v2 index");
      ext = buf.readUInt16BE(p);
      p += 2;
    }
    let name: Buffer;
    if (version === 4) {
      const { value: strip, next } = readVarint(buf, p);
      if (strip > prev.length) corrupt("bad prefix length");
      const nul = buf.indexOf(0, next);
      if (nul < 0 || nul >= end) corrupt("unterminated path");
      name = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(next, nul)]);
      off = nul + 1;
    } else {
      const nul = buf.indexOf(0, p);
      if (nul < 0 || nul >= end) corrupt("unterminated path");
      name = buf.subarray(p, nul);
      off = start + ((p - start + name.length + 8) & ~7);
    }
    prev = name;
    entries.push({
      path: name.toString("utf8"),
      oid: buf.subarray(start + 40, start + 40 + hashLen),
      mode: buf.readUInt32BE(start + 24),
      size: buf.readUInt32BE(start + 36),
      mtimeS: buf.readUInt32BE(start + 8),
      mtimeNs: buf.readUInt32BE(start + 12),
      stage: (flags >> 12) & 3,
      ignored: (flags & 0x8000) !== 0 || (ext & 0x4000) !== 0,
      intentToAdd: (ext & 0x2000) !== 0,
    });
  }
  let rootTree: Buffer | null | undefined;
  while (off + 8 <= end) {
    const sig = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    if (off + 8 + size > end) corrupt("truncated extension");
    if (sig === "link") corrupt("split index is not supported");
    if (sig === "TREE") rootTree = parseTreeRoot(buf.subarray(off + 8, off + 8 + size), hashLen);
    off += 8 + size;
  }
  return { entries, rootTree };
}

// ---------------------------------------------------------------- dirty check --

const MODE_TYPE = 0o170000;
const MODE_LINK = 0o120000;
const MODE_GITLINK = 0o160000;
const NS_PER_S = 1_000_000_000n;

function blobOid(algo: string, bytes: Buffer): Buffer {
  return createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest();
}

function crlfToLf(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

interface TreeNode {
  files: Map<string, IndexEntry>;
  dirs: Map<string, TreeNode>;
}

/**
 * Root tree oid of the index's stage-0 entries, built in memory exactly as `git write-tree`
 * would (entries sorted with directories compared as `name/`). Used when the cache-tree
 * extension is absent or invalidated.
 */
function indexTreeOid(entries: readonly IndexEntry[], algo: string): Buffer {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] ?? "";
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1] ?? "", e);
  }
  const hashNode = (node: TreeNode): Buffer => {
    const items: { key: string; rec: Buffer }[] = [];
    for (const [name, e] of node.files) {
      items.push({
        key: name,
        rec: Buffer.concat([Buffer.from(`${e.mode.toString(8)} ${name}\0`), e.oid]),
      });
    }
    for (const [name, child] of node.dirs) {
      items.push({
        key: `${name}/`,
        rec: Buffer.concat([Buffer.from(`40000 ${name}\0`), hashNode(child)]),
      });
    }
    items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const body = Buffer.concat(items.map((x) => x.rec));
    return createHash(algo).update(`tree ${body.length}\0`).update(body).digest();
  };
  return hashNode(root);
}

function entryDiffers(root: string, e: IndexEntry, algo: string, indexMtimeNs: bigint): boolean {
  const abs = path.join(root, ...e.path.split("/"));
  let st: BigIntStats;
  try {
    st = lstatSync(abs, { bigint: true });
  } catch {
    return true; // deleted
  }
  const isLink = (e.mode & MODE_TYPE) === MODE_LINK;
  // core.symlinks=false checks a link out as a plain file holding the target: accept both.
  if (!(st.isFile() || (isLink && st.isSymbolicLink()))) return true;
  const sizeOk = Number(st.size & 0xffffffffn) === e.size;
  const mS = Number(st.mtimeNs / NS_PER_S);
  const mNs = Number(st.mtimeNs % NS_PER_S);
  // A git built without nanosecond stat data stores 0: compare seconds only then.
  const timeOk = mS === e.mtimeS && (e.mtimeNs === 0 || mNs === e.mtimeNs);
  const racy = st.mtimeNs >= indexMtimeNs;
  if (sizeOk && timeOk && !racy) return false;
  const bytes =
    isLink && st.isSymbolicLink()
      ? Buffer.from(readlinkSync(abs).replace(/\\/g, "/"))
      : readFileSync(abs);
  if (blobOid(algo, bytes).equals(e.oid)) return false;
  // core.autocrlf / eol=crlf checkouts: the blob holds LF, the worktree CRLF.
  return !(bytes.includes(0x0d) && blobOid(algo, crlfToLf(bytes)).equals(e.oid));
}

// ------------------------------------------------------------------ untracked --

interface IgnorePattern {
  glob: string;
  anchored: boolean;
  dirOnly: boolean;
}

const ALWAYS_SKIP = new Set([".git", "node_modules", ".axiom"]);

function parseGitignore(text: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    while (line.endsWith("/")) line = line.slice(0, -1);
    const lead = line.startsWith("/");
    if (lead) line = line.slice(1);
    if (line === "") continue;
    out.push({ glob: line.replaceAll("**", "*"), anchored: lead || line.includes("/"), dirOnly });
  }
  return out;
}

/** `*` (no `/` when `slash` is false) and `?` wildcard match — iterative, no regex. */
function wildcard(glob: string, s: string, slash: boolean): boolean {
  let g = 0;
  let i = 0;
  let starG = -1;
  let starI = 0;
  while (i < s.length) {
    const gc = glob[g];
    if (gc === "*") {
      starG = g++;
      starI = i;
    } else if (gc !== undefined && (gc === "?" || gc === s[i]) && (gc !== "?" || s[i] !== "/")) {
      g++;
      i++;
    } else if (starG >= 0 && (slash || s[starI] !== "/")) {
      g = starG + 1;
      i = ++starI;
    } else {
      return false;
    }
  }
  while (glob[g] === "*") g++;
  return g === glob.length;
}

function isIgnored(patterns: readonly IgnorePattern[], rel: string, isDir: boolean): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return patterns.some(
    (p) => (!p.dirOnly || isDir) && wildcard(p.glob, p.anchored ? rel : base, false),
  );
}

// ---------------------------------------------------------------------- public --

/**
 * Paths that make the checkout at `root` dirty: staged changes (reported as `STAGED_PATH`),
 * worktree files that differ from the index, and — with `untracked` — untracked files/dirs.
 * Stops after `limit` (default 1) dirty paths or `budgetMs` (default 300) → `complete: false`;
 * `complete: false` with no dirty path means "could not prove clean". Not a repository, an
 * unreadable or unsupported index → throws.
 */
export async function gitDirtyPaths(
  root: string,
  o: { untracked?: boolean; limit?: number; budgetMs?: number } = {},
): Promise<{ dirty: string[]; complete: boolean }> {
  const limit = Math.max(1, o.limit ?? 1);
  const deadline = Date.now() + (o.budgetMs ?? 300);
  const d = await gitDirs(root);
  if (d === undefined) throw new Error("not a git repository");
  const hashLen = await hashLenOf(d.commonDir);
  const algo = hashLen === 32 ? "sha256" : "sha1";
  const indexPath = path.join(d.gitDir, "index");
  let buf: Buffer;
  let indexMtimeNs: bigint;
  try {
    buf = await readFile(indexPath);
    indexMtimeNs = (await stat(indexPath, { bigint: true })).mtimeNs;
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    buf = Buffer.alloc(0);
    indexMtimeNs = 0n;
  }
  const index: ParsedIndex =
    buf.length === 0 ? { entries: [], rootTree: undefined } : parseIndex(buf, hashLen);

  const dirty: string[] = [];
  let complete = true;
  const full = (): boolean => dirty.length >= limit;

  // 1. Staged: index tree (cache-tree root, else computed) vs HEAD^{tree}.
  const tree = await headTree(d, hashLen);
  const conflicted = index.entries.some((e) => e.stage !== 0 || e.intentToAdd);
  if (tree === null) {
    if (index.entries.length > 0) dirty.push(STAGED_PATH);
  } else if (tree instanceof Buffer && !conflicted) {
    const indexTree =
      index.rootTree instanceof Buffer ? index.rootTree : indexTreeOid(index.entries, algo);
    if (!tree.equals(indexTree)) dirty.push(STAGED_PATH);
  } else if (tree === undefined) {
    complete = false; // unreadable HEAD commit (e.g. deltified in a pack): staged state unknown
  }
  if (full()) return { dirty, complete: false };

  // 2. Worktree vs index.
  let lastPath: string | undefined;
  for (const e of index.entries) {
    if (Date.now() > deadline) return { dirty, complete: false };
    if (e.ignored || (e.mode & MODE_TYPE) === MODE_GITLINK || e.path === lastPath) continue;
    lastPath = e.path;
    if (e.stage !== 0 || e.intentToAdd || entryDiffers(root, e, algo, indexMtimeNs)) {
      dirty.push(e.path);
      if (full()) return { dirty, complete: false };
    }
  }

  // 3. Untracked (approximate).
  if (o.untracked === true) {
    const tracked = new Set<string>();
    const trackedDirs = new Set<string>();
    for (const e of index.entries) {
      tracked.add(e.path);
      for (let s = e.path.indexOf("/"); s >= 0; s = e.path.indexOf("/", s + 1)) {
        trackedDirs.add(e.path.slice(0, s));
      }
    }
    const patterns = parseGitignore(
      await readFile(path.join(root, ".gitignore"), "utf8").catch(() => ""),
    );
    const stack: string[] = [""];
    while (stack.length > 0) {
      const rel = stack.pop() ?? "";
      let ents: Dirent[];
      try {
        ents = readdirSync(path.join(root, ...rel.split("/")), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of ents) {
        if (Date.now() > deadline) return { dirty, complete: false };
        if (ALWAYS_SKIP.has(ent.name)) continue;
        const r = rel === "" ? ent.name : `${rel}/${ent.name}`;
        const isDir = ent.isDirectory();
        if (isIgnored(patterns, r, isDir)) continue;
        if (isDir) {
          if (trackedDirs.has(r)) {
            stack.push(r);
          } else if (readdirSync(path.join(root, ...r.split("/"))).length > 0) {
            dirty.push(`${r}/`);
          }
        } else if (!tracked.has(r)) {
          dirty.push(r);
        }
        if (full()) return { dirty, complete: false };
      }
    }
  }
  return { dirty, complete };
}

const GIT_COMMIT_AT_POSITION =
  /(?:^|[;&|({\n]\s*|\bthen\s+)git(?:\.exe)?(?:\s+-[Cc]\s+\S+)*\s+commit\b/i;

function isGitCommit(command: string): boolean {
  return GIT_COMMIT_AT_POSITION.test(command);
}

/**
 * Whether the `git commit` in `command` is pathspec-limited (mirrors the house guard): a
 * ` -- <path>` in the commit segment, or it goes through `agentq.ps1`, or it is `commit-tree`,
 * `--amend` or `--allow-empty`. A command with no `git commit` at command position → `true`.
 */
export function hasPathspec(command: string): boolean {
  if (!isGitCommit(command)) return true;
  return (
    /agentq\.ps1/i.test(command) ||
    /\bcommit\b[^;|&\n]*\s--\s+\S/.test(command) ||
    /\bcommit\b[^;|&\n]*--(?:amend|allow-empty)\b/.test(command) ||
    /\bcommit-tree\b/.test(command)
  );
}

function intersects(a: readonly CommandClass[], b: readonly CommandClass[]): boolean {
  return a.some((c) => b.includes(c));
}

/**
 * The git-state gate rules for `command` in the checkout at `root`. Not a git repository →
 * `undefined`. Never throws: a state that cannot be read fails closed (`git.dirtyTree`).
 */
export async function evaluateGit(
  command: string,
  cfg: GitRules,
  root: string,
): Promise<RuleVerdict | undefined> {
  try {
    if ((await gitDirs(root)) === undefined) return undefined;
    if (cfg.requirePathspec && !hasPathspec(command)) {
      return {
        id: "git.noPathspec",
        reason:
          "`git commit` without a pathspec commits everything staged, including other agents' files.",
        fix: "git commit -m '<msg>' -- <path> <path>",
      };
    }
    const classes = commandClasses(command);
    if (intersects(classes, cfg.cleanTreeFor) && !CLEAN_WRAPPER.test(command)) {
      let res: { dirty: string[]; complete: boolean };
      try {
        res = await gitDirtyPaths(root, { untracked: cfg.untracked, limit: 1, budgetMs: 2000 });
      } catch {
        return {
          id: "git.dirtyTree",
          reason:
            "The git index could not be read, so a clean tree cannot be proven (fail closed).",
          fix: "Run it from a clean checkout at an exact commit.",
        };
      }
      const first = res.dirty[0];
      if (first !== undefined) {
        return {
          id: "git.dirtyTree",
          reason: `This ${classes.join("/")} command needs a clean tree; '${first}' has uncommitted changes.`,
          path: first,
          fix: "Commit first, then run it from a clean checkout at that commit.",
        };
      }
      if (!res.complete) {
        return {
          id: "git.dirtyTree",
          reason:
            "A clean tree could not be proven (staged state unknown or time budget spent) — fail closed.",
          fix: "Run it from a clean checkout at an exact commit.",
        };
      }
    }
    const rule = cfg.branch;
    if (rule !== undefined && intersects(classes, rule.for)) {
      const head = await gitHead(root);
      const branch = head?.branch;
      if (branch === undefined || head?.detached === true || !wildcard(rule.is, branch, true)) {
        return {
          id: "git.branch",
          reason:
            rule.reason ??
            `${classes.join("/")} commands only run on a branch matching '${rule.is}' (current: ${branch ?? "detached HEAD"}).`,
          fix: `Switch to a branch matching '${rule.is}' first.`,
        };
      }
    }
    return undefined;
  } catch {
    return {
      id: "git.dirtyTree",
      reason: "The git state could not be read (fail closed).",
    };
  }
}
