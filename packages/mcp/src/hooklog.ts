/**
 * VS Code "GitHub Copilot Chat Hooks.log" reader for `axiom doctor`: how did the axiom gate
 * actually behave inside the editor? Pure parser (`parseHookLog`) + a read-only locator
 * (`findHookLogs`) that only looks at the newest VS Code log session. Reads at most the last
 * 8 MiB of each file.
 *
 * Line shapes (VS Code Insiders, 2026-10-14):
 *   `<date> <time> [info] [#2879] [PreToolUse] Running: {"command":"…","cwd":{…},"timeout":10}`
 *   `<date> <time> [info] [#2879] [PreToolUse] Completed (Success) in 1092ms`
 *   `<date> <time> [info] [#3056] [PreToolUse] Completed (NonBlockingError) in 12692ms, no output`
 *   `<date> <time> [info] [#2879] [PreToolUse] Output: {"hookSpecificOutput":{…"permissionDecision":"deny"…}}`
 * Several hooks run sequentially under one `[#id]`: a Completed/Output line belongs to the most
 * recent Running line of that id.
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export const HOOK_LOG_FILE = "GitHub Copilot Chat Hooks.log";
export const HOOK_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Hooks fire for a workspace this many times (PreToolUse) with zero axiom gate runs among them →
 * the gate is not wired. Shared by `axiom stats`; doctor keeps its own equal constant.
 */
export const GATE_SILENT_MIN_RUNS = 20;

/** A Running command that invokes the axiom gate (global bin, thin client or the repo script). */
export const AXIOM_GATE_RUN_RE = /\baxiom(-hook)?\b.*\bgate\b|axiom-gate/;

export interface HookRun {
  id: string;
  event: string;
  command: string;
  /** Workspace folder of the hook (`cwd.fsPath` in the Running document), when present. */
  cwd?: string;
  /** Seconds, as declared in the Running document. */
  timeoutSec?: number;
  /** Epoch ms of the Running line (the log's local-time prefix), when it carries one. */
  atMs?: number;
  outcome?: string;
  ms?: number;
  denied: boolean;
}

export interface HookLogStats {
  runs: number;
  p50: number;
  p95: number;
  nonBlockingErrors: number;
  denies: number;
  timeouts: number;
  /** Every PreToolUse hook run (any command): proves hooks fire at all. */
  preToolUseRuns: number;
}

const LINE_RE = /\[#([^\]]+)\]\s+\[([^\]]+)\]\s+(Running|Output|Completed)(?::\s?|\s+)(.*)$/;
const COMPLETED_RE = /^\(([^)]+)\)\s+in\s+(\d+(?:\.\d+)?)ms/;
/** `2026-10-14 01:43:28.080` at the start of a line — VS Code writes local time. */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/;

/** Epoch ms of a log line's local-time prefix, `undefined` without one. */
export function lineTimeMs(line: string): number | undefined {
  const m = STAMP_RE.exec(line);
  if (m === null) return undefined;
  const t = new Date(`${m[1]}T${m[2]}`).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function parseRunning(rest: string): { command: string; timeoutSec?: number; cwd?: string } {
  try {
    const doc = JSON.parse(rest) as { command?: unknown; timeout?: unknown; cwd?: unknown };
    const command = typeof doc.command === "string" ? doc.command : rest;
    const cwdRaw = doc.cwd;
    const cwd =
      typeof cwdRaw === "string"
        ? cwdRaw
        : typeof cwdRaw === "object" &&
            cwdRaw !== null &&
            typeof (cwdRaw as { fsPath?: unknown }).fsPath === "string"
          ? (cwdRaw as { fsPath: string }).fsPath
          : undefined;
    return {
      command,
      ...(typeof doc.timeout === "number" ? { timeoutSec: doc.timeout } : {}),
      ...(cwd === undefined ? {} : { cwd }),
    };
  } catch {
    return { command: rest };
  }
}

/** Every hook run in the log text, in order of their Running lines. */
export function parseHookRuns(text: string): HookRun[] {
  const runs: HookRun[] = [];
  const current = new Map<string, HookRun>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m === null) continue;
    const [, id = "", event = "", kind, rest = ""] = m;
    if (kind === "Running") {
      const atMs = lineTimeMs(line);
      const run: HookRun = {
        id,
        event,
        ...parseRunning(rest),
        ...(atMs === undefined ? {} : { atMs }),
        denied: false,
      };
      runs.push(run);
      current.set(id, run);
      continue;
    }
    const run = current.get(id);
    if (run === undefined) continue;
    if (kind === "Completed") {
      const c = COMPLETED_RE.exec(rest);
      if (c?.[1] !== undefined) {
        run.outcome = c[1];
        run.ms = Number(c[2]);
      }
    } else if (/"permissionDecision"\s*:\s*"deny"/.test(rest)) {
      run.denied = true;
    }
  }
  return runs;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
}

export function summarizeRuns(runs: readonly HookRun[]): HookLogStats {
  const gate = runs.filter((r) => AXIOM_GATE_RUN_RE.test(r.command));
  const ms = gate
    .map((r) => r.ms)
    .filter((x): x is number => x !== undefined)
    .sort((a, b) => a - b);
  return {
    runs: gate.length,
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    nonBlockingErrors: gate.filter((r) => r.outcome === "NonBlockingError").length,
    denies: gate.filter((r) => r.denied).length,
    timeouts: gate.filter(
      (r) => r.ms !== undefined && r.timeoutSec !== undefined && r.ms >= r.timeoutSec * 1000,
    ).length,
    preToolUseRuns: runs.filter((r) => r.event === "PreToolUse").length,
  };
}

/**
 * Loose path equality for `cwd` filtering: resolved, trailing separators dropped, compared
 * case-insensitively (`e:\gh\x` vs `E:/gh/x/`).
 */
export function samePathLoose(a: string, b: string): boolean {
  const n = (p: string) => {
    const s = path.resolve(p);
    let end = s.length;
    while (end > 1 && (s[end - 1] === "/" || s[end - 1] === "\\")) end--;
    return s.slice(0, end).toLowerCase();
  };
  return n(a) === n(b);
}

/** Only the runs whose workspace is `root` (runs without a cwd are kept: they may be ours). */
export function runsForRoot(runs: readonly HookRun[], root: string): HookRun[] {
  return runs.filter((r) => r.cwd === undefined || samePathLoose(r.cwd, root));
}

/** Axiom gate statistics for one log text (pure). */
export function parseHookLog(text: string): HookLogStats {
  return summarizeRuns(parseHookRuns(text));
}

/** Whitespace-normalised command text for comparisons. */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * Axiom gate commands VS Code actually ran for `root` since `sinceMs` that match none of the
 * commands the hook files declare NOW — the window still holds an old hook config and needs a
 * reload. Distinct commands, in first-seen order (pure).
 */
export function staleGateCommands(
  runs: readonly HookRun[],
  root: string,
  current: readonly string[],
  sinceMs: number,
): string[] {
  const now = new Set(current.map(normalizeCommand));
  const out: string[] = [];
  for (const r of runs) {
    if (r.cwd === undefined || !samePathLoose(r.cwd, root)) continue;
    if (r.atMs === undefined || r.atMs < sinceMs) continue;
    if (!AXIOM_GATE_RUN_RE.test(r.command)) continue;
    const c = normalizeCommand(r.command);
    if (!now.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Every hook run of the given files (tail-capped, unreadable files skipped). */
export async function readHookRuns(files: readonly string[]): Promise<HookRun[]> {
  const runs: HookRun[] = [];
  for (const f of files) {
    try {
      runs.push(...parseHookRuns(await readTail(f)));
    } catch {
      // unreadable (rotated / locked) — skip
    }
  }
  return runs;
}

export interface FindHookLogsOptions {
  home?: string;
  /** `%APPDATA%` on win32 (defaults to `<home>/AppData/Roaming`). */
  appData?: string;
  platform?: NodeJS.Platform;
}

/** VS Code `logs` directories (stable + Insiders) for the platform. */
export function hookLogRoots(opts: FindHookLogsOptions = {}): string[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const editions = ["Code", "Code - Insiders"];
  if (platform === "win32") {
    const appData = opts.appData ?? path.join(home, "AppData", "Roaming");
    return editions.map((e) => path.join(appData, e, "logs"));
  }
  if (platform === "darwin") {
    return editions.map((e) => path.join(home, "Library", "Application Support", e, "logs"));
  }
  return editions.map((e) => path.join(home, ".config", e, "logs"));
}

async function dirs(abs: string): Promise<string[]> {
  try {
    return (await readdir(abs, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Hook log files of the NEWEST session dir under each logs root:
 * `<session>/window*\/exthost/GitHub.copilot-chat/GitHub Copilot Chat Hooks.log`.
 */
export async function findHookLogs(opts: FindHookLogsOptions = {}): Promise<string[]> {
  const found: string[] = [];
  for (const logs of hookLogRoots(opts)) {
    // Session dirs are named `YYYYMMDDTHHMMSS`; lexical order = chronological.
    const sessions = (await dirs(logs)).sort();
    const newest = sessions[sessions.length - 1];
    if (newest === undefined) continue;
    const session = path.join(logs, newest);
    for (const w of (await dirs(session)).filter((d) => d.startsWith("window")).sort()) {
      const f = path.join(session, w, "exthost", "GitHub.copilot-chat", HOOK_LOG_FILE);
      if (
        await stat(f).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        found.push(f);
    }
  }
  return found;
}

/** The last `maxBytes` of a file as UTF-8 (the first, possibly partial, line is dropped). */
export async function readTail(abs: string, maxBytes = HOOK_LOG_MAX_BYTES): Promise<string> {
  const fh = await open(abs, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, start + off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const text = buf.subarray(0, off).toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl < 0 ? "" : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

/** Parse every file (tail-capped) and merge the runs into one summary. */
export async function readHookLogStats(
  files: readonly string[],
  root?: string,
): Promise<HookLogStats> {
  const runs: HookRun[] = [];
  for (const f of files) {
    try {
      runs.push(...parseHookRuns(await readTail(f)));
    } catch {
      // unreadable (rotated / locked) — skip
    }
  }
  if (root === undefined) return summarizeRuns(runs);
  // The log's cwd may be an alias of the (realpath'd) root: macOS /var → /private/var, Windows
  // 8.3 short names (RUNNER~1), junctions. Canonicalise each distinct cwd once.
  const rootReal = await realOrSelf(root);
  const canon = new Map<string, string>();
  for (const r of runs) {
    if (r.cwd !== undefined && !canon.has(r.cwd)) canon.set(r.cwd, await realOrSelf(r.cwd));
  }
  return summarizeRuns(
    runs.filter(
      (r) =>
        r.cwd === undefined ||
        samePathLoose(r.cwd, root) ||
        samePathLoose(canon.get(r.cwd) ?? r.cwd, rootReal),
    ),
  );
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(path.resolve(p));
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------------------------------------
// Copilot CLI: `~/.copilot/session-state/<sessionId>/events.jsonl` (copilotVersion 1.0.92-4,
// 2026-10). One JSON event per line; hook invocations are a `hook.start`/`hook.end` pair joined
// by `data.hookInvocationId`:
//   {"type":"hook.start","data":{"hookInvocationId":"…","hookType":"preToolUse","input":{"sessionId":"…","cwd":"E:/gh/codai","toolCalls":[…]}},"timestamp":"2026-07-29T21:29:27.999Z"}
//   {"type":"hook.end","data":{"hookInvocationId":"…","hookType":"preToolUse","success":false,"output":{…},"error":{"message":"Error: spawn axiom ENOENT","source":"E:\\gh\\codai\\.github\\hooks\\axiom-gate.json"}},"timestamp":"…"}
// One invocation covers EVERY configured hook of that event, and a successful end names no hook
// file — so the axiom gate is attributable only when it errors (`error.source`/output text).
// ---------------------------------------------------------------------------------------------

export const COPILOT_CLI_EVENTS_FILE = "events.jsonl";
/** Newest session files read per call (by mtime). */
export const COPILOT_CLI_MAX_SESSIONS = 100;

export interface CliHookRun {
  id: string;
  /** `preToolUse`, `postToolUse`, `sessionStart`, … */
  hookType: string;
  cwd?: string;
  /** ISO timestamp of the start event (or the end event when the start is missing). */
  at?: string;
  success?: boolean;
  /** Wall time of the whole invocation (all hooks of the event), end − start. */
  ms?: number;
  /** `error.source` of a failed invocation (the hook config file). */
  source?: string;
  /** The invocation is attributable to the axiom gate (it errored and names it). */
  gate: boolean;
}

interface CliEvent {
  type?: unknown;
  timestamp?: unknown;
  data?: {
    hookInvocationId?: unknown;
    hookType?: unknown;
    success?: unknown;
    input?: { cwd?: unknown };
    output?: unknown;
    error?: { source?: unknown; message?: unknown };
  };
}

/** Every hook invocation of one `events.jsonl` text, in order of first appearance. */
export function parseCopilotCliHookRuns(text: string): CliHookRun[] {
  const runs = new Map<string, CliHookRun>();
  const startMs = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"hook.')) continue;
    let ev: CliEvent;
    try {
      ev = JSON.parse(line) as CliEvent;
    } catch {
      continue;
    }
    if (ev.type !== "hook.start" && ev.type !== "hook.end") continue;
    const d = ev.data;
    if (typeof d?.hookInvocationId !== "string" || typeof d.hookType !== "string") continue;
    const at = typeof ev.timestamp === "string" ? ev.timestamp : undefined;
    let run = runs.get(d.hookInvocationId);
    if (run === undefined) {
      run = { id: d.hookInvocationId, hookType: d.hookType, gate: false };
      if (at !== undefined) run.at = at;
      runs.set(d.hookInvocationId, run);
    }
    const t = at === undefined ? Number.NaN : Date.parse(at);
    if (ev.type === "hook.start") {
      if (typeof d.input?.cwd === "string") run.cwd = d.input.cwd;
      if (at !== undefined) run.at = at;
      if (!Number.isNaN(t)) startMs.set(run.id, t);
      continue;
    }
    if (typeof d.success === "boolean") run.success = d.success;
    const t0 = startMs.get(run.id);
    if (t0 !== undefined && !Number.isNaN(t)) run.ms = t - t0;
    if (typeof d.error?.source === "string") run.source = d.error.source;
    const blame = `${run.source ?? ""} ${d.output === undefined ? "" : JSON.stringify(d.output)}`;
    if (run.success === false && AXIOM_GATE_RUN_RE.test(blame)) run.gate = true;
  }
  return [...runs.values()];
}

/** `<home>/.copilot/session-state`. */
export function copilotCliSessionDir(home: string = homedir()): string {
  return path.join(home, ".copilot", "session-state");
}

/**
 * The newest `events.jsonl` files (at most `max`, by mtime) under a session-state dir; files not
 * modified since `sinceMs` are skipped. A missing dir is an empty list.
 */
export async function findCopilotCliEventLogs(
  dir: string,
  opts: { sinceMs?: number; max?: number } = {},
): Promise<string[]> {
  const found: { f: string; m: number }[] = [];
  for (const d of await dirs(dir)) {
    const f = path.join(dir, d, COPILOT_CLI_EVENTS_FILE);
    const m = await stat(f).then(
      (s) => (s.isFile() ? s.mtimeMs : undefined),
      () => undefined,
    );
    if (m === undefined) continue;
    if (opts.sinceMs !== undefined && m < opts.sinceMs) continue;
    found.push({ f, m });
  }
  return found
    .sort((a, b) => b.m - a.m)
    .slice(0, opts.max ?? COPILOT_CLI_MAX_SESSIONS)
    .map((x) => x.f);
}
