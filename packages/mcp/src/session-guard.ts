/**
 * S-1209 / S-1215 — cross-session overwrite detection, blind whole-file overwrite guard and the
 * stale-script guard. Advisory state under `<root>/.axiom/sessions/` and `<root>/.axiom/denied/`.
 *
 * The gate runs BEFORE the tool, so a write is recorded as *pending* (`preHash` = the bytes the
 * writer saw) and attributed on the next gate call that observes a different hash on disk.
 *
 * Every exported function is gate-facing: it never throws. Checks return `undefined` (no opinion)
 * on any internal error; record functions swallow errors.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { z } from "zod";
import type { RuleVerdict } from "./gate-verdict.js";

export const SessionsConfigSchema = z.strictObject({
  foreignWrite: z.enum(["off", "ask", "deny"]).default("off"),
  windowMin: z.number().int().min(1).max(1440).default(15),
  blindOverwrite: z.enum(["off", "ask", "deny"]).default("off"),
  trackReads: z.boolean().default(false),
  staleScript: z.boolean().default(true),
});
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

export interface SessionTarget {
  relPath: string;
  op: "write" | "delete";
  /** Whole-file create/write tool (create_file, Write, write_file). */
  whole: boolean;
}

export interface SessionCtx {
  root: string;
  sessionId?: string;
  agentId: string;
  tool: string;
  targets: readonly SessionTarget[];
  now?: number;
}

/** Hash of a file that does not exist. */
export const ABSENT = "absent";
/** Files larger than this are not hashed (no opinion). */
export const HASH_BYTES_MAX = 8 * 1024 * 1024;
/** A denied create makes re-running that script suspicious for this long. */
export const STALE_SCRIPT_WINDOW_MS = 10 * 60_000;
/** A pending write never observed on disk is dropped after this long. */
const PENDING_TTL_MS = 24 * 3_600_000;
/** Upper bound on tracked paths in `writers.json` (oldest dropped first). */
const WRITERS_MAX = 5000;
const DENIED_MAX = 50;
const SCRIPT_EXT = /\.(ps1|mjs|js|ts|cmd|sh|py)$/i;

interface Pending {
  agentId: string;
  at: number;
  preHash: string;
}
interface WriterEntry {
  agentId?: string;
  at?: number;
  hash?: string;
  pending?: Pending;
}
type WritersMap = Record<string, WriterEntry>;
interface SessionState {
  seen: Record<string, string>;
  wrote: Record<string, number>;
}
interface DeniedEntry {
  abs: string;
  at: number;
}

// ------------------------------------------------------------------ state io --

function sessionsDir(root: string): string {
  return path.join(root, ".axiom", "sessions");
}
function writersFile(root: string): string {
  return path.join(sessionsDir(root), "writers.json");
}
function sessionFile(root: string, sessionId: string): string {
  return path.join(sessionsDir(root), `${sha256Hex(sessionId).slice(0, 16)}.json`);
}
function deniedFile(root: string): string {
  return path.join(root, ".axiom", "denied", "recent.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** tmp + rename; state files only (never user files). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function loadWriters(root: string): Promise<WritersMap> {
  const raw = await readJson(writersFile(root));
  const out: WritersMap = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isRecord(v)) out[k] = v as WriterEntry;
  return out;
}

async function loadSession(root: string, sessionId: string): Promise<SessionState> {
  const raw = await readJson(sessionFile(root, sessionId));
  const seen: Record<string, string> = {};
  const wrote: Record<string, number> = {};
  if (isRecord(raw)) {
    if (isRecord(raw.seen)) {
      for (const [k, v] of Object.entries(raw.seen)) if (typeof v === "string") seen[k] = v;
    }
    if (isRecord(raw.wrote)) {
      for (const [k, v] of Object.entries(raw.wrote)) if (typeof v === "number") wrote[k] = v;
    }
  }
  return { seen, wrote };
}

/** Root-relative POSIX path that cannot escape the root; `undefined` otherwise. */
function safeRel(relPath: string): string | undefined {
  const rel = relPath.replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return undefined;
  if (rel.split("/").some((s) => s === ".." || s === "")) return undefined;
  return rel;
}

/** sha256 hex of the file, `ABSENT` when missing, `undefined` when unknown (too large / error). */
export async function hashFile(root: string, relPath: string): Promise<string | undefined> {
  const rel = safeRel(relPath);
  if (rel === undefined) return undefined;
  const abs = path.join(root, ...rel.split("/"));
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > HASH_BYTES_MAX) return undefined;
    return sha256Hex(new Uint8Array(await readFile(abs)));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? ABSENT : undefined;
  }
}

/**
 * Attribute a pending write once the disk shows a different hash than the writer saw.
 * Returns true when `entry` changed.
 */
function settle(entry: WriterEntry, current: string | undefined, now: number): boolean {
  const p = entry.pending;
  if (p === undefined) return false;
  if (current !== undefined && current !== p.preHash) {
    entry.agentId = p.agentId;
    entry.at = p.at;
    entry.hash = current;
    delete entry.pending;
    return true;
  }
  if (now - p.at > PENDING_TTL_MS) {
    delete entry.pending;
    return true;
  }
  return false;
}

function capWriters(map: WritersMap): WritersMap {
  const keys = Object.keys(map);
  if (keys.length <= WRITERS_MAX) return map;
  const time = (e: WriterEntry): number => Math.max(e.at ?? 0, e.pending?.at ?? 0);
  keys.sort((a, b) => time(map[b] ?? {}) - time(map[a] ?? {}));
  const out: WritersMap = {};
  for (const k of keys.slice(0, WRITERS_MAX)) {
    const e = map[k];
    if (e !== undefined) out[k] = e;
  }
  return out;
}

function decisionOf(mode: "ask" | "deny"): "ask" | "deny" {
  return mode === "ask" ? "ask" : "deny";
}

// -------------------------------------------------------------------- checks --

export async function checkSessionWrite(
  ctx: SessionCtx,
  cfg: SessionsConfig,
): Promise<RuleVerdict | undefined> {
  try {
    if (ctx.sessionId === undefined) return undefined;
    if (cfg.foreignWrite === "off" && cfg.blindOverwrite === "off") return undefined;
    const now = ctx.now ?? Date.now();
    const writers = await loadWriters(ctx.root);
    const session = await loadSession(ctx.root, ctx.sessionId);
    const windowMs = cfg.windowMin * 60_000;
    let blind: RuleVerdict | undefined;
    for (const t of ctx.targets) {
      const rel = safeRel(t.relPath);
      if (rel === undefined) continue;
      const current = await hashFile(ctx.root, rel);
      if (current === undefined) continue;
      const entry = writers[rel];
      if (entry !== undefined) settle(entry, current, now);
      if (
        cfg.foreignWrite !== "off" &&
        entry?.agentId !== undefined &&
        entry.at !== undefined &&
        entry.agentId !== ctx.agentId &&
        now - entry.at <= windowMs &&
        current !== session.seen[rel]
      ) {
        return {
          id: "session.foreignWrite",
          reason: `${rel} was changed by another session (${entry.agentId}) ${Math.round((now - entry.at) / 60_000)} min ago and this session has not seen that version.`,
          path: rel,
          fix: "re-read the file, then re-apply your change on top of the current content",
          decision: decisionOf(cfg.foreignWrite),
        };
      }
      if (
        blind === undefined &&
        cfg.blindOverwrite !== "off" &&
        t.whole &&
        t.op === "write" &&
        current !== ABSENT &&
        session.wrote[rel] === undefined
      ) {
        const isBlind = cfg.trackReads
          ? session.seen[rel] === undefined
          : entry?.agentId !== undefined && entry.agentId !== ctx.agentId;
        if (isBlind) {
          blind = {
            id: "blind.overwrite",
            reason: `whole-file write would replace ${rel}, which this session has never read or written.`,
            path: rel,
            fix: "read the file first and use a targeted edit, or write to a new filename",
            decision: decisionOf(cfg.blindOverwrite),
          };
        }
      }
    }
    return blind;
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------- record --

export async function recordSessionWrite(ctx: SessionCtx): Promise<void> {
  try {
    const now = ctx.now ?? Date.now();
    const writers = await loadWriters(ctx.root);
    const targetRels = new Set<string>();
    for (const t of ctx.targets) {
      const rel = safeRel(t.relPath);
      if (rel !== undefined) targetRels.add(rel);
    }
    // Settle every pending write (normally a handful) against the disk.
    const hashes = new Map<string, string | undefined>();
    for (const [rel, entry] of Object.entries(writers)) {
      if (entry.pending === undefined && !targetRels.has(rel)) continue;
      const h = await hashFile(ctx.root, rel);
      hashes.set(rel, h);
      settle(entry, h, now);
      if (entry.agentId === undefined && entry.pending === undefined) delete writers[rel];
    }
    const session =
      ctx.sessionId === undefined ? undefined : await loadSession(ctx.root, ctx.sessionId);
    for (const rel of targetRels) {
      const preHash = hashes.has(rel) ? hashes.get(rel) : await hashFile(ctx.root, rel);
      if (preHash === undefined) continue;
      const entry = writers[rel] ?? {};
      entry.pending = { agentId: ctx.agentId, at: now, preHash };
      writers[rel] = entry;
      if (session !== undefined) {
        session.seen[rel] = preHash;
        session.wrote[rel] = now;
      }
    }
    await writeJsonAtomic(writersFile(ctx.root), capWriters(writers));
    if (session !== undefined && ctx.sessionId !== undefined) {
      await writeJsonAtomic(sessionFile(ctx.root, ctx.sessionId), session);
    }
  } catch {
    // advisory state — never fail the gate
  }
}

export async function recordSessionRead(
  root: string,
  sessionId: string,
  _agentId: string,
  relPaths: readonly string[],
): Promise<void> {
  try {
    const session = await loadSession(root, sessionId);
    let changed = false;
    for (const p of relPaths) {
      const rel = safeRel(p);
      if (rel === undefined) continue;
      const h = await hashFile(root, rel);
      if (h === undefined) continue;
      session.seen[rel] = h;
      changed = true;
    }
    if (changed) await writeJsonAtomic(sessionFile(root, sessionId), session);
  } catch {
    // advisory state
  }
}

// --------------------------------------------------------------- stale script --

async function loadDenied(root: string): Promise<DeniedEntry[]> {
  const raw = await readJson(deniedFile(root));
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is DeniedEntry => isRecord(e) && typeof e.abs === "string" && typeof e.at === "number",
  );
}

export async function recordDeniedCreate(root: string, absPath: string): Promise<void> {
  try {
    const now = Date.now();
    const abs = path.resolve(absPath);
    const list = (await loadDenied(root)).filter(
      (e) => now - e.at < STALE_SCRIPT_WINDOW_MS && e.abs !== abs,
    );
    list.push({ abs, at: now });
    await writeJsonAtomic(deniedFile(root), list.slice(-DENIED_MAX));
  } catch {
    // advisory state
  }
}

function norm(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `needle` appears in `hay` delimited by start/end, whitespace, quotes, `/`, `(`, `)`, `;`, `&`, `|`. */
function mentions(hay: string, needle: string): boolean {
  if (needle === "") return false;
  return new RegExp(`(^|[\\s"'\`/(;&|=])${escapeRe(needle)}($|[\\s"'\`);&|])`).test(hay);
}

export async function checkStaleScript(
  root: string,
  command: string,
  now?: number,
): Promise<RuleVerdict | undefined> {
  try {
    const t = now ?? Date.now();
    const cmd = norm(command);
    const rootN = norm(path.resolve(root));
    for (const e of await loadDenied(root)) {
      const age = t - e.at;
      if (age < 0 || age >= STALE_SCRIPT_WINDOW_MS) continue;
      const abs = norm(e.abs);
      const inside = abs.startsWith(`${rootN}/`);
      const rel = inside ? abs.slice(rootN.length + 1) : undefined;
      const leaf = abs.slice(abs.lastIndexOf("/") + 1);
      const hit =
        cmd.includes(abs) ||
        (rel?.includes("/") === true && mentions(cmd, rel)) ||
        (SCRIPT_EXT.test(leaf) && mentions(cmd, leaf));
      if (!hit) continue;
      const shown = inside
        ? path.relative(path.resolve(root), e.abs).replace(/\\/g, "/")
        : e.abs.replace(/\\/g, "/");
      return {
        id: "blind.staleScript",
        reason: `the create of ${shown} was denied ${Math.round(age / 1000)} s ago, so this command would run an older version (or nothing).`,
        path: shown,
        fix: "write it under a NEW filename, check the create succeeded, then run it",
        decision: "deny",
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
