/**
 * S-1210 — `axiom undo --session <agent>`. The gate captures the pre-image of every target of an
 * allowed write into the CAS (`.axiom/cas/sha256/<aa>/<hex>`) and appends one JSON line per
 * target to `.axiom/undo/<sha256(agentId)[:16]>.jsonl`. `undoSession` restores the FIRST
 * pre-image recorded for each path, refusing paths another agent wrote afterwards (unless forced).
 *
 * 3.0 (I-20): when the gate lets a write OUTSIDE the root through (`outside: allow|warn`) and
 * `undo: true`, `captureOutsideUndo` stores those pre-images in the same root's CAS with the
 * absolute path (`outside: true`); `undoSession` restores them too, with the same conflict rule
 * (a later write to that absolute path by another agent of this root wins unless forced).
 */
import { randomBytes } from "node:crypto";
import { realpath as realpathCb } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { acquireLock, resolveContained, writeAtomic } from "@codai/axiom-apply";
import { sha256Hex } from "@codai/axiom-canon";
import { casGet, casPut } from "@codai/axiom-plan";
import { AxiomError } from "@codai/axiom-schema";

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);

export const UNDO_TTL_MS_DEFAULT = 7 * 24 * 3600 * 1000;
/** Pre-images larger than this are not captured (`pre: "toolarge"`). */
export const UNDO_BYTES_MAX = 8 * 1024 * 1024;

export interface UndoItem {
  /** Root-relative POSIX path, or the absolute path (forward slashes) when `outside`. */
  path: string;
  action: "restore" | "delete" | "skip";
  reason?: "conflict" | "toolarge" | "missing-blob" | "unchanged";
  pre: string;
  outside?: true;
}

export interface UndoResult {
  root: string;
  agentId: string;
  dryRun: boolean;
  items: UndoItem[];
  /** Items restored or deleted (in a dry run: that would be). */
  restored: number;
  conflicts: number;
}

interface UndoLine {
  v: 1;
  at: number;
  agentId: string;
  sessionId?: string;
  tool: string;
  path: string;
  pre: string;
  /** 3.0: `path` is an absolute path outside the root. */
  outside?: true;
}

export function undoDir(root: string): string {
  return path.join(root, ".axiom", "undo");
}

function logFile(root: string, agentId: string): string {
  return path.join(undoDir(root), `${sha256Hex(agentId).slice(0, 16)}.jsonl`);
}

function safeRel(relPath: string): string | undefined {
  const rel = relPath.replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return undefined;
  if (rel.split("/").some((s) => s === ".." || s === "")) return undefined;
  return rel;
}

/** Absolute, normalised, forward-slash form of an outside path; `undefined` when not absolute. */
function safeAbs(p: string): string | undefined {
  if (!path.isAbsolute(p)) return undefined;
  return path.resolve(p).replace(/\\/g, "/");
}

function absOf(root: string, l: { path: string; outside?: true }): string {
  return l.outside === true ? path.resolve(l.path) : path.join(root, ...l.path.split("/"));
}

/** Current state of a file: `sha256:<hex>`, `absent`, or `toolarge`. */
async function preImage(root: string, rel: string, store: boolean): Promise<string> {
  return preImageAbs(root, path.join(root, ...rel.split("/")), store);
}

/** Like `preImage`, for any absolute file; blobs always go into `root`'s CAS. */
async function preImageAbs(root: string, abs: string, store: boolean): Promise<string> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return "absent";
    if (st.size > UNDO_BYTES_MAX) return "toolarge";
    const bytes = new Uint8Array(await readFile(abs));
    const hex = store ? await casPut(root, bytes) : sha256Hex(bytes);
    return `sha256:${hex}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw err;
  }
}

export async function captureUndo(
  root: string,
  e: {
    sessionId?: string;
    agentId: string;
    tool: string;
    targets: readonly { relPath: string; op: "write" | "delete" }[];
    now?: number;
  },
): Promise<void> {
  try {
    const at = e.now ?? Date.now();
    const lines: string[] = [];
    const done = new Set<string>();
    for (const t of e.targets) {
      const rel = safeRel(t.relPath);
      if (rel === undefined || done.has(rel)) continue;
      done.add(rel);
      let pre: string;
      try {
        pre = await preImage(root, rel, true);
      } catch {
        continue;
      }
      const line: UndoLine = {
        v: 1,
        at,
        agentId: e.agentId,
        ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }),
        tool: e.tool,
        path: rel,
        pre,
      };
      lines.push(JSON.stringify(line));
    }
    if (lines.length === 0) return;
    await mkdir(undoDir(root), { recursive: true });
    await appendFile(logFile(root, e.agentId), `${lines.join("\n")}\n`);
  } catch {
    // advisory capture — never fail the gate
  }
}

/**
 * Capture pre-images of absolute paths OUTSIDE `rootReal` into its undo store (I-20). Paths
 * inside the root, relative paths and duplicates are ignored (in-root targets use
 * `captureUndo`). Never throws.
 */
export async function captureOutsideUndo(
  rootReal: string,
  e: {
    sessionId?: string;
    agentId: string;
    tool: string;
    absPaths: readonly string[];
    now?: number;
  },
): Promise<void> {
  try {
    const at = e.now ?? Date.now();
    const rootN = path.resolve(rootReal).replace(/\\/g, "/");
    const lines: string[] = [];
    const done = new Set<string>();
    for (const p of e.absPaths) {
      const abs = safeAbs(p);
      if (abs === undefined || done.has(abs)) continue;
      if (abs === rootN || abs.startsWith(`${rootN}/`)) continue;
      done.add(abs);
      let pre: string;
      try {
        pre = await preImageAbs(rootReal, abs, true);
      } catch {
        continue;
      }
      const line: UndoLine = {
        v: 1,
        at,
        agentId: e.agentId,
        ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }),
        tool: e.tool,
        path: abs,
        pre,
        outside: true,
      };
      lines.push(JSON.stringify(line));
    }
    if (lines.length === 0) return;
    await mkdir(undoDir(rootReal), { recursive: true });
    await appendFile(logFile(rootReal, e.agentId), `${lines.join("\n")}\n`);
  } catch {
    // advisory capture — never fail the gate
  }
}

function parseLine(text: string): UndoLine | undefined {
  try {
    const o = JSON.parse(text) as Partial<UndoLine>;
    if (
      o.v !== 1 ||
      typeof o.at !== "number" ||
      typeof o.agentId !== "string" ||
      typeof o.path !== "string" ||
      typeof o.pre !== "string"
    ) {
      return undefined;
    }
    // An `outside` line must carry a normalised absolute path; an in-root line a safe relative one.
    if (o.outside === true ? safeAbs(o.path) !== o.path : safeRel(o.path) === undefined) {
      return undefined;
    }
    return o as UndoLine;
  } catch {
    return undefined;
  }
}

async function logNames(root: string): Promise<string[]> {
  try {
    return (await readdir(undoDir(root))).filter((n) => n.endsWith(".jsonl")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readLog(file: string): Promise<{ lines: UndoLine[]; raw: string[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], raw: [] };
    throw err;
  }
  const raw = text.split("\n").filter((l) => l.trim() !== "");
  const lines: UndoLine[] = [];
  for (const r of raw) {
    const l = parseLine(r);
    if (l !== undefined) lines.push(l);
  }
  return { lines, raw };
}

async function readAllLines(root: string): Promise<UndoLine[]> {
  const out: UndoLine[] = [];
  for (const n of await logNames(root)) {
    out.push(...(await readLog(path.join(undoDir(root), n))).lines);
  }
  return out;
}

function matchesAgent(l: UndoLine, agent: string): boolean {
  return l.agentId === agent || l.sessionId === agent || l.agentId.endsWith(`:${agent}`);
}

/** Latest foreign write time per path from the session-guard writers map (best effort). */
async function foreignWriterTimes(
  root: string,
  mine: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(root, ".axiom", "sessions", "writers.json"), "utf8"));
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null) return out;
  for (const [p, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const e = v as {
      agentId?: unknown;
      at?: unknown;
      pending?: { agentId?: unknown; at?: unknown };
    };
    const consider = (a: unknown, t: unknown): void => {
      if (typeof a === "string" && typeof t === "number" && !mine.has(a)) {
        out.set(p, Math.max(out.get(p) ?? 0, t));
      }
    };
    consider(e.agentId, e.at);
    if (typeof e.pending === "object" && e.pending !== null)
      consider(e.pending.agentId, e.pending.at);
  }
  return out;
}

export async function undoSession(
  root: string,
  o: { agent: string; dryRun?: boolean; force?: boolean; since?: string },
): Promise<UndoResult> {
  const dryRun = o.dryRun === true;
  let sinceMs = Number.NEGATIVE_INFINITY;
  if (o.since !== undefined) {
    sinceMs = Date.parse(o.since);
    if (Number.isNaN(sinceMs)) {
      throw new AxiomError("ERR_INVALID_PLAN", "--since is not an ISO date", {
        details: { since: o.since },
      });
    }
  }
  const rootReal = await realpathNative(path.resolve(root));
  const lock = await acquireLock(rootReal, "undo", 1000);
  try {
    const all = await readAllLines(rootReal);
    const own = all.filter((l) => matchesAgent(l, o.agent) && l.at >= sinceMs);
    if (own.length === 0) {
      throw new AxiomError("ERR_NOT_FOUND", "no undo log for that agent/session", {
        details: { agent: o.agent },
      });
    }
    const mine = new Set(own.map((l) => l.agentId));
    const agentId = mine.size === 1 ? (own[0]?.agentId ?? o.agent) : o.agent;
    const first = new Map<string, UndoLine>();
    const lastOwn = new Map<string, number>();
    for (const l of [...own].sort((a, b) => a.at - b.at)) {
      if (!first.has(l.path)) first.set(l.path, l);
      lastOwn.set(l.path, Math.max(lastOwn.get(l.path) ?? 0, l.at));
    }
    const foreign = await foreignWriterTimes(rootReal, mine);
    for (const l of all) {
      if (mine.has(l.agentId)) continue;
      foreign.set(l.path, Math.max(foreign.get(l.path) ?? 0, l.at));
    }

    const items: UndoItem[] = [];
    let restored = 0;
    let conflicts = 0;
    for (const [rel, line] of [...first.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const pre = line.pre;
      const out = line.outside === true ? { outside: true as const } : {};
      const skip = (reason: UndoItem["reason"] & string): void => {
        items.push({ path: rel, action: "skip", reason, pre, ...out });
      };
      if (pre === "toolarge") {
        skip("toolarge");
        continue;
      }
      const abs = absOf(rootReal, line);
      const current = await preImageAbs(rootReal, abs, false).catch(() => "toolarge");
      if (current === pre) {
        skip("unchanged");
        continue;
      }
      const foreignAt = foreign.get(rel);
      if (o.force !== true && foreignAt !== undefined && foreignAt > (lastOwn.get(rel) ?? 0)) {
        conflicts++;
        skip("conflict");
        continue;
      }
      if (pre === "absent") {
        if (!dryRun) {
          if (line.outside === true) await rm(abs, { force: true });
          else await rm((await resolveContained(rootReal, rel)).abs, { force: true });
        }
        items.push({ path: rel, action: "delete", pre, ...out });
        restored++;
        continue;
      }
      const hex = pre.startsWith("sha256:") ? pre.slice("sha256:".length) : "";
      const bytes = hex === "" ? undefined : await casGet(rootReal, hex);
      if (bytes === undefined || sha256Hex(bytes) !== hex) {
        skip("missing-blob");
        continue;
      }
      if (!dryRun) {
        if (line.outside === true) await writeAtomic(abs, bytes);
        else await writeAtomic((await resolveContained(rootReal, rel)).abs, bytes);
      }
      items.push({ path: rel, action: "restore", pre, ...out });
      restored++;
    }
    return { root: rootReal, agentId, dryRun, items, restored, conflicts };
  } finally {
    await lock.release();
  }
}

export async function undoLiveDigests(
  root: string,
  o: { ttlMs: number; now?: number },
): Promise<Set<string>> {
  const cutoff = (o.now ?? Date.now()) - o.ttlMs;
  const out = new Set<string>();
  for (const l of await readAllLines(root)) {
    if (l.at >= cutoff && l.pre.startsWith("sha256:")) out.add(l.pre.slice("sha256:".length));
  }
  return out;
}

export async function pruneUndo(
  root: string,
  o: { ttlMs: number; now?: number; dryRun?: boolean },
): Promise<{ removedLines: number; removedFiles: number }> {
  const cutoff = (o.now ?? Date.now()) - o.ttlMs;
  let removedLines = 0;
  let removedFiles = 0;
  for (const n of await logNames(root)) {
    const file = path.join(undoDir(root), n);
    const { raw } = await readLog(file);
    const keep = raw.filter((r) => {
      const l = parseLine(r);
      return l !== undefined && l.at >= cutoff;
    });
    const dropped = raw.length - keep.length;
    if (dropped === 0) continue;
    removedLines += dropped;
    if (keep.length === 0) removedFiles++;
    if (o.dryRun === true) continue;
    if (keep.length === 0) {
      await rm(file, { force: true });
      continue;
    }
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, `${keep.join("\n")}\n`);
    await rename(tmp, file);
  }
  return { removedLines, removedFiles };
}
