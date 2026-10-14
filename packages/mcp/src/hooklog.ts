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
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export const HOOK_LOG_FILE = "GitHub Copilot Chat Hooks.log";
export const HOOK_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** A Running command that invokes the axiom gate (global bin, thin client or the repo script). */
export const AXIOM_GATE_RUN_RE = /\baxiom(-hook)?\b.*\bgate\b|axiom-gate/;

export interface HookRun {
  id: string;
  event: string;
  command: string;
  /** Seconds, as declared in the Running document. */
  timeoutSec?: number;
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
}

const LINE_RE = /\[#([^\]]+)\]\s+\[([^\]]+)\]\s+(Running|Output|Completed)(?::\s?|\s+)(.*)$/;
const COMPLETED_RE = /^\(([^)]+)\)\s+in\s+(\d+(?:\.\d+)?)ms/;

function parseRunning(rest: string): { command: string; timeoutSec?: number } {
  try {
    const doc = JSON.parse(rest) as { command?: unknown; timeout?: unknown };
    const command = typeof doc.command === "string" ? doc.command : rest;
    return typeof doc.timeout === "number" ? { command, timeoutSec: doc.timeout } : { command };
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
      const run: HookRun = { id, event, ...parseRunning(rest), denied: false };
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
  };
}

/** Axiom gate statistics for one log text (pure). */
export function parseHookLog(text: string): HookLogStats {
  return summarizeRuns(parseHookRuns(text));
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
export async function readHookLogStats(files: readonly string[]): Promise<HookLogStats> {
  const runs: HookRun[] = [];
  for (const f of files) {
    try {
      runs.push(...parseHookRuns(await readTail(f)));
    } catch {
      // unreadable (rotated / locked) — skip
    }
  }
  return summarizeRuns(runs);
}
