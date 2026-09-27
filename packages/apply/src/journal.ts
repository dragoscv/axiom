import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ArtifactOp,
  AxiomError,
  type DigestRef,
  DigestRefSchema,
  isErrorCode,
  type Journal,
  type JournalPhase,
  JournalSchema,
  type JournalStep,
} from "@codai/axiom-schema";
import { errnoCode, fsyncDir, nsPath } from "./fsx.js";

export function journalDir(root: string): string {
  return path.join(root, ".axiom", "journal");
}

export function journalPath(root: string, digest: DigestRef): string {
  return path.join(journalDir(root), `${digest.slice("sha256:".length)}.json`);
}

export function newJournal(manifestDigest: DigestRef, steps: JournalStep[]): Journal {
  return {
    manifestDigest,
    phase: "staged",
    steps,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
}

/** Write the journal atomically (tmp → fsync → rename) and fsync the directory. */
export async function writeJournal(root: string, journal: Journal): Promise<string> {
  const dir = journalDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = journalPath(root, journal.manifestDigest);
  const tmp = `${target}.tmp-${process.pid}`;
  const fh = await fs.open(nsPath(tmp), "w");
  try {
    await fh.writeFile(JSON.stringify(journal), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(nsPath(tmp), nsPath(target));
  await fsyncDir(dir);
  return target;
}

export async function readJournal(root: string, digest: DigestRef): Promise<Journal | undefined> {
  const p = journalPath(root, digest);
  let raw: string;
  try {
    raw = await fs.readFile(nsPath(p), "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return undefined;
    throw err;
  }
  return parseJournal(raw, p);
}

export function parseJournal(raw: string, p: string): Journal {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AxiomError("ERR_JOURNAL_CORRUPT", "journal is not valid JSON", {
      cause: err,
      details: { file: p },
    });
  }
  const r = JournalSchema.safeParse(json);
  if (!r.success) {
    throw new AxiomError("ERR_JOURNAL_CORRUPT", "journal does not match schema", {
      details: { file: p, issues: r.error.issues.map((i) => i.message) },
    });
  }
  return r.data;
}

/** All journals under `.axiom/journal/` (corrupt ones are reported, not thrown). */
export async function listJournals(
  root: string,
): Promise<{ journals: Journal[]; corrupt: string[] }> {
  const dir = journalDir(root);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return { journals: [], corrupt: [] };
    throw err;
  }
  const journals: Journal[] = [];
  const corrupt: string[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = path.join(dir, n);
    try {
      journals.push(parseJournal(await fs.readFile(p, "utf8"), p));
    } catch {
      corrupt.push(p);
    }
  }
  return { journals, corrupt };
}

export async function setPhase(
  root: string,
  journal: Journal,
  phase: JournalPhase,
): Promise<Journal> {
  const next: Journal = { ...journal, phase };
  await writeJournal(root, next);
  return next;
}

export async function removeJournal(root: string, digest: DigestRef): Promise<void> {
  await fs.rm(journalPath(root, digest), { force: true });
}

// ---------------------------------------------------------------------------
// S-706 — tamper-evident journal chain: `.axiom/journal/chain.jsonl`.
//
// One line per journal that reached a terminal state. Each line is
// `JSON.stringify` of an object whose keys are emitted in this fixed order:
//   seq, manifestDigest, state, at, prev, files, [code]
// (plain JSON, not JCS — the order is fixed by construction and every value is
// an ASCII string or a safe integer). `prev` is `sha256:<hex>` of the previous
// line's exact bytes (without its trailing `\n`); seq 1 uses 64 zeros.
//
// What the chain proves: any edit, deletion or reorder of a line that has a
// successor is detected. The LAST line (and truncation of the tail) can only be
// checked against an external anchor — `verifyChain` returns `head` (the digest
// of the last line) for callers that want to pin it. Journal files may be pruned
// legitimately, so a missing journal is reported in `missing`, never as a fault.
// ---------------------------------------------------------------------------

export const CHAIN_FILE = "chain.jsonl";
export const CHAIN_GENESIS: DigestRef = `sha256:${"0".repeat(64)}`;

export type ChainState = "committed" | "rolled-back" | "failed";
export type ChainFault = "prev-mismatch" | "seq-gap" | "parse";

export interface ChainEntry {
  seq: number;
  manifestDigest: DigestRef;
  state: ChainState;
  at: string;
  prev: DigestRef;
  files: number;
  /** `ERR_*` code, only for `failed` / `rolled-back` entries that carry one. */
  code?: string;
}

export interface ChainEntryInput {
  manifestDigest: DigestRef;
  state: ChainState;
  files: number;
  code?: string;
  /** Defaults to now. */
  at?: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  /** Number of entries verified good (all of them when `ok`). */
  entries: number;
  /** `sha256:` of the last good line's bytes; genesis when the chain is empty. */
  head: DigestRef;
  firstBad?: { seq: number; reason: ChainFault };
  /** manifestDigests of good entries whose journal file no longer exists (pruning is legal). */
  missing: DigestRef[];
}

export function chainPath(root: string): string {
  return path.join(journalDir(root), CHAIN_FILE);
}

const CHAIN_STATES: ReadonlySet<string> = new Set<ChainState>([
  "committed",
  "rolled-back",
  "failed",
]);

function digestOfLine(line: Uint8Array): DigestRef {
  return `sha256:${createHash("sha256").update(line).digest("hex")}`;
}

/** The canonical line for an entry (fixed key order, no trailing newline). */
export function serializeChainEntry(e: ChainEntry): string {
  const o: ChainEntry = {
    seq: e.seq,
    manifestDigest: e.manifestDigest,
    state: e.state,
    at: e.at,
    prev: e.prev,
    files: e.files,
  };
  if (e.code !== undefined) o.code = e.code;
  return JSON.stringify(o);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "seq",
  "manifestDigest",
  "state",
  "at",
  "prev",
  "files",
  "code",
]);

function parseChainLine(bytes: Uint8Array): ChainEntry | undefined {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(v)) return undefined;
  if (Object.keys(v).some((k) => !ENTRY_KEYS.has(k))) return undefined;
  const { seq, manifestDigest, state, at, prev, files, code } = v;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return undefined;
  if (!DigestRefSchema.safeParse(manifestDigest).success) return undefined;
  if (!DigestRefSchema.safeParse(prev).success) return undefined;
  if (typeof state !== "string" || !CHAIN_STATES.has(state)) return undefined;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  if (!Number.isSafeInteger(files) || (files as number) < 0) return undefined;
  if (code !== undefined && !isErrorCode(code)) return undefined;
  const out: ChainEntry = {
    seq: seq as number,
    manifestDigest: manifestDigest as DigestRef,
    state: state as ChainState,
    at,
    prev: prev as DigestRef,
    files: files as number,
  };
  if (code !== undefined) out.code = code;
  return out;
}

interface RawLine {
  bytes: Uint8Array;
  /** false for a final segment with no `\n` — a torn (crash mid-write) tail. */
  terminated: boolean;
}

async function readChainLines(root: string): Promise<RawLine[]> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(nsPath(chainPath(root)));
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
  const out: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push({ bytes: buf.subarray(start, i), terminated: true });
      start = i + 1;
    }
  }
  if (start < buf.length) out.push({ bytes: buf.subarray(start), terminated: false });
  return out;
}

interface ChainWalk {
  good: { entry: ChainEntry; digest: DigestRef }[];
  firstBad?: { seq: number; reason: ChainFault };
}

function walkChain(lines: readonly RawLine[]): ChainWalk {
  const good: ChainWalk["good"] = [];
  let prev = CHAIN_GENESIS;
  for (const [i, line] of lines.entries()) {
    const seq = i + 1;
    const entry = line.terminated ? parseChainLine(line.bytes) : undefined;
    if (entry === undefined) return { good, firstBad: { seq, reason: "parse" } };
    if (entry.seq !== seq) return { good, firstBad: { seq, reason: "seq-gap" } };
    if (entry.prev !== prev) return { good, firstBad: { seq, reason: "prev-mismatch" } };
    prev = digestOfLine(line.bytes);
    good.push({ entry, digest: prev });
  }
  return { good };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(nsPath(abs));
    return true;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw err;
  }
}

/**
 * Verify the chain's own integrity (seq contiguity, prev links, line shape).
 * A root without `chain.jsonl` verifies ok with 0 entries.
 */
export async function verifyChain(root: string): Promise<ChainVerifyResult> {
  const { good, firstBad } = walkChain(await readChainLines(root));
  const missing: DigestRef[] = [];
  for (const { entry } of good) {
    if (!(await exists(journalPath(root, entry.manifestDigest)))) {
      missing.push(entry.manifestDigest);
    }
  }
  const out: ChainVerifyResult = {
    ok: firstBad === undefined,
    entries: good.length,
    head: good.at(-1)?.digest ?? CHAIN_GENESIS,
    missing,
  };
  if (firstBad !== undefined) out.firstBad = firstBad;
  return out;
}

/** `verifyChain` that throws `ERR_JOURNAL_CHAIN` (details: seq, reason, file) when broken. */
export async function assertChain(root: string): Promise<ChainVerifyResult> {
  const r = await verifyChain(root);
  if (r.firstBad !== undefined) {
    throw new AxiomError("ERR_JOURNAL_CHAIN", "journal chain is broken", {
      details: { ...r.firstBad, entries: r.entries, file: chainPath(root) },
    });
  }
  return r;
}

/**
 * Append one entry. **The caller must hold the root lock** (`.axiom/lock`): the
 * chain has a single writer, so read-last-line → append is not raced. The line
 * plus `\n` is written in one `write` on an `a`-mode handle and fsync'd.
 * Refuses (`ERR_JOURNAL_CHAIN`) to extend a chain that does not verify —
 * including a torn tail left by a crash mid-write.
 */
export async function appendChainEntry(root: string, input: ChainEntryInput): Promise<ChainEntry> {
  const lines = await readChainLines(root);
  const { good, firstBad } = walkChain(lines);
  if (firstBad !== undefined) {
    throw new AxiomError("ERR_JOURNAL_CHAIN", "refusing to append to a broken journal chain", {
      details: { ...firstBad, file: chainPath(root) },
    });
  }
  const entry: ChainEntry = {
    seq: good.length + 1,
    manifestDigest: input.manifestDigest,
    state: input.state,
    at: input.at ?? new Date().toISOString(),
    prev: good.at(-1)?.digest ?? CHAIN_GENESIS,
    files: input.files,
  };
  if (input.code !== undefined) entry.code = input.code;
  const dir = journalDir(root);
  await fs.mkdir(dir, { recursive: true });
  const fh = await fs.open(nsPath(chainPath(root)), "a");
  try {
    await fh.write(`${serializeChainEntry(entry)}\n`, null, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (lines.length === 0) await fsyncDir(dir);
  return entry;
}

const TERMINAL: Partial<Record<JournalPhase, ChainState>> = {
  committed: "committed",
  "rolled-back": "rolled-back",
};

/**
 * Record a journal that reached a terminal phase. Non-terminal phases are a
 * no-op (returns `undefined`) unless `opts.state === "failed"` is forced.
 * Caller must hold the root lock.
 */
export async function recordTerminal(
  root: string,
  journal: Journal,
  opts: { state?: "failed"; code?: string } = {},
): Promise<ChainEntry | undefined> {
  const state = opts.state ?? TERMINAL[journal.phase];
  if (state === undefined) return undefined;
  const input: ChainEntryInput = {
    manifestDigest: journal.manifestDigest,
    state,
    files: journal.steps.length,
  };
  if (opts.code !== undefined) input.code = opts.code;
  return appendChainEntry(root, input);
}

export interface HistoryFile {
  path: string;
  op: ArtifactOp;
}

export interface HistoryEntry extends ChainEntry {
  /** Manifest name, from `.axiom/manifests/<hex>.json` when stored. */
  name?: string;
  /** Journal steps, when the journal file still exists. */
  fileList?: HistoryFile[];
  journalPresent: boolean;
}

async function readJsonOrUndefined(abs: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(nsPath(abs), "utf8"));
  } catch {
    return undefined;
  }
}

function hexOf(d: DigestRef): string {
  return d.slice("sha256:".length);
}

async function manifestName(root: string, digest: DigestRef): Promise<string | undefined> {
  const b = await readJsonOrUndefined(
    path.join(root, ".axiom", "manifests", `${hexOf(digest)}.json`),
  );
  if (!isRecord(b) || !isRecord(b.manifest)) return undefined;
  return typeof b.manifest.name === "string" ? b.manifest.name : undefined;
}

async function appliedErrorCode(root: string, digest: DigestRef): Promise<string | undefined> {
  const r = await readJsonOrUndefined(
    path.join(root, ".axiom", "applied", `${hexOf(digest)}.json`),
  );
  if (!isRecord(r) || !isRecord(r.error)) return undefined;
  return isErrorCode(r.error.code) ? r.error.code : undefined;
}

/**
 * Last `limit` chain entries, newest first, joined with journal/manifest details
 * when present. Best-effort: stops at the first bad line (use `verifyChain` for
 * integrity). Powers `axiom log`.
 */
export async function readHistory(
  root: string,
  opts: { limit?: number } = {},
): Promise<HistoryEntry[]> {
  const { good } = walkChain(await readChainLines(root));
  const limit = opts.limit ?? good.length;
  const picked = good.slice(Math.max(0, good.length - Math.max(0, limit))).reverse();
  const out: HistoryEntry[] = [];
  for (const { entry } of picked) {
    let journal: Journal | undefined;
    try {
      journal = await readJournal(root, entry.manifestDigest);
    } catch {
      journal = undefined;
    }
    const h: HistoryEntry = { ...entry, journalPresent: journal !== undefined };
    if (journal !== undefined) h.fileList = journal.steps.map((s) => ({ path: s.path, op: s.op }));
    const name = await manifestName(root, entry.manifestDigest);
    if (name !== undefined) h.name = name;
    if (h.code === undefined) {
      const code = await appliedErrorCode(root, entry.manifestDigest);
      if (code !== undefined) h.code = code;
    }
    out.push(h);
  }
  return out;
}

export interface JournalSummary {
  manifestDigest: DigestRef;
  phase: JournalPhase;
  startedAt: string;
  pid: number;
  files: number;
  done: number;
}

export interface JournalStatus {
  /** Journals left in `staged` / `committing` / `rolling-back` (need recovery). */
  interrupted: JournalSummary[];
  /** Journal files that failed to parse. */
  corrupt: string[];
  /** Newest `committed` chain entry, if the chain has one. */
  lastApplied?: ChainEntry;
}

const INTERRUPTED: ReadonlySet<JournalPhase> = new Set<JournalPhase>([
  "staged",
  "committing",
  "rolling-back",
]);

/** Snapshot for `axiom status`. Read-only; does not need the lock. */
export async function journalStatus(root: string): Promise<JournalStatus> {
  const { journals, corrupt } = await listJournals(root);
  const interrupted = journals
    .filter((j) => INTERRUPTED.has(j.phase))
    .map((j) => ({
      manifestDigest: j.manifestDigest,
      phase: j.phase,
      startedAt: j.startedAt,
      pid: j.pid,
      files: j.steps.length,
      done: j.steps.filter((s) => s.done).length,
    }))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const out: JournalStatus = { interrupted, corrupt };
  const { good } = walkChain(await readChainLines(root));
  for (let i = good.length - 1; i >= 0; i--) {
    const g = good[i];
    if (g?.entry.state === "committed") {
      out.lastApplied = g.entry;
      break;
    }
  }
  return out;
}
