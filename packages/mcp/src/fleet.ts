/**
 * `axiom setup doctor --fleet` (3.0, I-1, D-45): every repository with AXIOM wiring under the
 * given parent dirs, and every linked worktree (agent slot) of each, in one table. Read-only.
 *
 * Per slot: which gate profile the gate uses (own file / inherited from the main clone / none)
 * and whether a slot copy drifted from the main clone, which hook files run the gate (with
 * `--fail-open` / `--format`), gate commands VS Code ran in the last 24 h that no hook file
 * declares any more (the window holds an old config → reload it), and whether the global bin
 * understands the profile's keys. Plus the resident daemon's protocol, once.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { DAEMON_PROTOCOL, daemonStatePath } from "./daemon-proto.js";
import { isRecord, profileVersionNeeds, readJsonFile } from "./doctor.js";
import { gitCommonDir } from "./gate.js";
import { findHookLogs, type HookRun, readHookRuns, staleGateCommands } from "./hooklog.js";
import {
  type BinLocator,
  compareVersions,
  defaultBinLocator,
  GATE_COMMAND_RE,
  INIT_FILES,
} from "./init.js";

export type FleetStatus = "ok" | "warn" | "fail";

export interface FleetIssue {
  id: string;
  status: FleetStatus;
  message: string;
}

export interface FleetHookFile {
  file: string;
  commands: string[];
  failOpen: boolean;
  /** Every gate command names its `--format`. */
  format: boolean;
}

export interface FleetSlot {
  /** Main clone root (realpath). */
  repo: string;
  root: string;
  kind: "main" | "worktree";
  profile: {
    source: "own" | "inherited" | "none";
    file?: string;
    mtimeMs?: number;
    sha256?: string;
  };
  hooks: FleetHookFile[];
  /** Gate commands seen in the VS Code hook log (last 24 h) that no hook file declares now. */
  stale: string[];
  issues: FleetIssue[];
  status: FleetStatus;
}

export interface FleetResult {
  ok: boolean;
  scanned: string[];
  bin?: { path: string; version?: string };
  daemon: FleetIssue;
  slots: FleetSlot[];
}

export interface FleetOptions {
  /** Parent dirs to scan; each dir itself and its direct children are checked. */
  scan?: readonly string[];
  home?: string;
  appData?: string;
  platform?: NodeJS.Platform;
  /** Explicit VS Code hook logs (skips the locator). */
  hookLogs?: readonly string[];
  locateBin?: BinLocator;
  now?: number;
}

export const FLEET_STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

const HOOK_FILES = [
  INIT_FILES.copilotHook,
  INIT_FILES.claudeSettings,
  INIT_FILES.cursorHooks,
  INIT_FILES.devinHooks,
  INIT_FILES.windsurfHooks,
  INIT_FILES.codexHooks,
  INIT_FILES.geminiSettings,
] as const;

async function realOr(p: string): Promise<string> {
  try {
    return await realpath(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

function key(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** Raw `~/.axiom/daemon.json` (also protocol-1 / keyless files, which the client ignores). */
async function readDaemonRaw(home: string): Promise<Record<string, unknown> | undefined> {
  const r = await readJsonFile(daemonStatePath(home));
  return r !== undefined && isRecord(r.doc) ? r.doc : undefined;
}

/** Default scan list: the roots the resident daemon serves (they are parent dirs by design). */
export async function defaultScanDirs(home: string): Promise<string[]> {
  const d = await readDaemonRaw(home);
  const roots = d !== undefined && Array.isArray(d.roots) ? d.roots : [];
  return roots.filter((r): r is string => typeof r === "string");
}

function daemonIssue(d: Record<string, unknown> | undefined): FleetIssue {
  if (d === undefined) return { id: "daemon", status: "ok", message: "no resident daemon" };
  const protocol = typeof d.protocol === "number" ? d.protocol : 0;
  const keyed = typeof d.key === "string" && d.key.length > 0;
  if (protocol < DAEMON_PROTOCOL || !keyed) {
    return {
      id: "daemon",
      status: "warn",
      message: `daemon.json is protocol ${protocol}${keyed ? "" : " keyless"}: restart the daemon (protocol ${DAEMON_PROTOCOL})`,
    };
  }
  return {
    id: "daemon",
    status: "ok",
    message: `daemon protocol ${protocol}, pid ${String(d.pid)}, version ${String(d.version)}`,
  };
}

/** Linked worktrees of a main clone: `.git/worktrees/<name>/gitdir` → `<slot>/.git`. */
export async function linkedWorktrees(mainRoot: string): Promise<string[]> {
  const dir = path.join(mainRoot, ".git", "worktrees");
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const text = await readFile(path.join(dir, n, "gitdir"), "utf8").catch(() => undefined);
    if (text === undefined || text.trim() === "") continue;
    const slot = path.dirname(path.resolve(dir, n, text.trim()));
    if (await isDir(slot)) out.push(await realOr(slot));
  }
  return out;
}

/** Main clone root of `dir` (a main clone itself, or a worktree of one), else undefined. */
async function mainRootOf(dir: string): Promise<string | undefined> {
  const common = await gitCommonDir(dir);
  if (common === undefined || path.basename(common).toLowerCase() !== ".git") return undefined;
  return realOr(path.dirname(common));
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (isRecord(v)) for (const x of Object.values(v)) collectStrings(x, out);
}

/** Every gate command string (pre and post) a hook document declares, in document order. */
export function gateCommandsOf(doc: unknown): string[] {
  const all: string[] = [];
  collectStrings(doc, all);
  return [...new Set(all.filter((s) => GATE_COMMAND_RE.test(s)))];
}

async function hookFilesOf(root: string): Promise<FleetHookFile[]> {
  const out: FleetHookFile[] = [];
  for (const rel of HOOK_FILES) {
    const r = await readJsonFile(path.join(root, rel));
    if (r?.doc === undefined) continue;
    const commands = gateCommandsOf(r.doc);
    if (commands.length === 0) continue;
    out.push({
      file: rel,
      commands,
      failOpen: commands.some((c) => /(?:^|\s)--fail-open(?:\s|;|$)/.test(c)),
      format: commands.every((c) => /(?:^|\s)--format\s+\S/.test(c)),
    });
  }
  return out;
}

async function profileInfo(
  root: string,
): Promise<{ mtimeMs: number; sha256: string; doc?: unknown; file: string } | undefined> {
  const file = path.join(root, INIT_FILES.gateProfile);
  try {
    const [st, buf] = await Promise.all([stat(file), readFile(file)]);
    let doc: unknown;
    try {
      doc = JSON.parse(buf.toString("utf8")) as unknown;
    } catch {
      doc = undefined;
    }
    return {
      file,
      mtimeMs: st.mtimeMs,
      sha256: createHash("sha256").update(buf).digest("hex"),
      ...(doc === undefined ? {} : { doc }),
    };
  } catch {
    return undefined;
  }
}

function worst(issues: readonly FleetIssue[]): FleetStatus {
  if (issues.some((i) => i.status === "fail")) return "fail";
  if (issues.some((i) => i.status === "warn")) return "warn";
  return "ok";
}

async function judgeSlot(
  repo: string,
  root: string,
  kind: "main" | "worktree",
  main: Awaited<ReturnType<typeof profileInfo>>,
  runs: readonly HookRun[],
  bin: FleetResult["bin"],
  sinceMs: number,
): Promise<FleetSlot> {
  const issues: FleetIssue[] = [];
  const own = kind === "main" ? main : await profileInfo(root);
  let source: FleetSlot["profile"]["source"] = own === undefined ? "none" : "own";
  let effective = own;
  if (kind === "worktree" && main !== undefined) {
    if (own === undefined) {
      source = "inherited";
      effective = main;
      issues.push({
        id: "profile",
        status: "ok",
        message: "no own gate profile: the 3.0 gate inherits the main clone's",
      });
    } else if (own.sha256 !== main.sha256) {
      if (own.mtimeMs < main.mtimeMs) {
        source = "inherited";
        effective = main;
        issues.push({
          id: "profile.drift",
          status: "warn",
          message:
            "slot gate profile is older than the main clone's and differs: a 3.0 gate inherits the main one, an older bin still uses this stale copy (delete it or re-copy)",
        });
      } else {
        issues.push({
          id: "profile.drift",
          status: "warn",
          message:
            "slot gate profile is newer than the main clone's and differs (kept for this slot)",
        });
      }
    }
  }
  if (effective === undefined) {
    issues.push({ id: "profile", status: "ok", message: "no gate profile: builtin default" });
  }
  const hooks = await hookFilesOf(root);
  if (hooks.length === 0) {
    issues.push({ id: "hooks", status: "warn", message: "no hook file runs the axiom gate" });
  }
  for (const h of hooks) {
    if (h.failOpen) {
      issues.push({
        id: "hooks.failOpen",
        status: "warn",
        message: `${h.file} runs the gate with --fail-open (internal errors allow the call)`,
      });
    }
    if (!h.format) {
      issues.push({
        id: "hooks.format",
        status: "warn",
        message: `${h.file}: a gate command has no --format (axiom init --upgrade)`,
      });
    }
  }
  const stale = staleGateCommands(
    runs,
    root,
    hooks.flatMap((h) => h.commands),
    sinceMs,
  );
  if (stale.length > 0) {
    issues.push({
      id: "hooks.stale",
      status: "warn",
      message: `VS Code ran ${stale.length} gate command(s) in the last 24 h that no hook file declares now: reload the window (Developer: Reload Window)`,
    });
  }
  const needs = profileVersionNeeds(effective?.doc);
  if (needs.need !== undefined && bin?.version !== undefined) {
    if (compareVersions(bin.version, needs.need) < 0) {
      issues.push({
        id: "bin.profile",
        status: "fail",
        message: `profile uses ${needs.used.join(", ")} but the global axiom is ${bin.version} (< ${needs.need}): npm install -g @codai/axiom-mcp@latest`,
      });
    }
  }
  const profile: FleetSlot["profile"] = { source };
  if (source === "own" && own !== undefined) {
    profile.file = own.file;
    profile.mtimeMs = own.mtimeMs;
    profile.sha256 = own.sha256;
  } else if (source === "inherited" && main !== undefined) {
    profile.file = main.file;
    profile.mtimeMs = main.mtimeMs;
    profile.sha256 = main.sha256;
  }
  return { repo, root, kind, profile, hooks, stale, issues, status: worst(issues) };
}

async function isWired(root: string): Promise<boolean> {
  if ((await profileInfo(root)) !== undefined) return true;
  return (await hookFilesOf(root)).length > 0;
}

/** Main clones under the scan dirs (each dir itself and its direct children). */
async function discoverRepos(scan: readonly string[]): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const s of scan) {
    const dir = await realOr(s);
    if (!(await isDir(dir))) continue;
    const candidates = [dir];
    try {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        if (d.isDirectory()) candidates.push(path.join(dir, d.name));
      }
    } catch {
      // unreadable dir: only itself
    }
    for (const c of candidates) {
      const main = await mainRootOf(c);
      if (main !== undefined && !seen.has(key(main))) seen.set(key(main), main);
    }
  }
  return [...seen.values()].sort();
}

async function canonicalRuns(runs: readonly HookRun[]): Promise<HookRun[]> {
  const canon = new Map<string, string>();
  for (const r of runs) {
    if (r.cwd !== undefined && !canon.has(r.cwd)) canon.set(r.cwd, await realOr(r.cwd));
  }
  return runs.map((r) => (r.cwd === undefined ? r : { ...r, cwd: canon.get(r.cwd) ?? r.cwd }));
}

export async function collectFleet(opts: FleetOptions = {}): Promise<FleetResult> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const scan = [...(opts.scan ?? []), ...(await defaultScanDirs(home))];
  const daemon = daemonIssue(await readDaemonRaw(home));
  const located = await (opts.locateBin ?? defaultBinLocator())();
  const bin =
    located === undefined
      ? undefined
      : located.version === undefined
        ? { path: located.path }
        : { path: located.path, version: located.version };
  const files =
    opts.hookLogs ??
    (await findHookLogs({
      home,
      ...(opts.appData === undefined ? {} : { appData: opts.appData }),
      ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    }));
  const runs = await canonicalRuns(await readHookRuns(files));
  const sinceMs = now - FLEET_STALE_WINDOW_MS;
  const slots: FleetSlot[] = [];
  for (const repo of await discoverRepos(scan)) {
    const worktrees = await linkedWorktrees(repo);
    const wired = (await isWired(repo)) || (await anyWired(worktrees));
    if (!wired) continue;
    const main = await profileInfo(repo);
    slots.push(await judgeSlot(repo, repo, "main", main, runs, bin, sinceMs));
    for (const wt of worktrees) {
      slots.push(await judgeSlot(repo, wt, "worktree", main, runs, bin, sinceMs));
    }
  }
  return {
    ok: !slots.some((s) => s.status === "fail"),
    scanned: scan.map((s) => path.resolve(s)),
    ...(bin === undefined ? {} : { bin }),
    daemon,
    slots,
  };
}

async function anyWired(roots: readonly string[]): Promise<boolean> {
  for (const r of roots) if (await isWired(r)) return true;
  return false;
}

/** ASCII only: replaces any non-ASCII char (paths may carry them) with `?`. */
export function ascii(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderFleet(r: FleetResult): string[] {
  const lines: string[] = [];
  lines.push(
    ascii(
      `axiom fleet: ${r.slots.length} slot(s) in ${new Set(r.slots.map((s) => s.repo)).size} repo(s); bin ${r.bin?.version ?? "unknown"}${r.bin === undefined ? " (not on PATH)" : ` at ${r.bin.path}`}`,
    ),
  );
  lines.push(ascii(`${r.daemon.status.toUpperCase().padEnd(4)} daemon: ${r.daemon.message}`));
  if (r.slots.length === 0) {
    lines.push(
      ascii(
        `no AXIOM-wired repository found under: ${r.scanned.join(", ") || "(nothing to scan: pass --scan <dir>)"}`,
      ),
    );
    return lines;
  }
  const rows = r.slots.map((s) => [
    s.status.toUpperCase(),
    s.kind === "main" ? s.root : `  ${s.root}`,
    s.profile.source,
    s.hooks.map((h) => path.posix.basename(h.file.replace(/\\/g, "/"))).join(",") || "-",
    String(s.stale.length),
  ]);
  const head = ["STATUS", "SLOT", "PROFILE", "HOOKS", "STALE"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (row: readonly string[]) =>
    ascii(
      row
        .map((c, i) => pad(c, widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    );
  lines.push(fmt(head));
  for (const row of rows) lines.push(fmt(row));
  for (const s of r.slots) {
    const bad = s.issues.filter((i) => i.status !== "ok");
    if (bad.length === 0) continue;
    lines.push(ascii(s.root));
    for (const i of bad)
      lines.push(ascii(`  ${i.status.toUpperCase().padEnd(4)} ${i.id}: ${i.message}`));
    for (const c of s.stale) lines.push(ascii(`       stale: ${c}`));
  }
  return lines;
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  home?: string;
}

export const FLEET_USAGE =
  "usage: axiom setup doctor --fleet [--scan <dir>]... [--json]\n" +
  "  default scan list: the roots in ~/.axiom/daemon.json (each dir and its direct children)";

/** `axiom setup doctor --fleet`. Exit 0 = no failing slot, 2 = a slot failed or usage error. */
export async function fleetMain(argv: string[], io: CliIo): Promise<number> {
  let values: { scan?: string[]; json?: boolean; fleet?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        fleet: { type: "boolean" },
        scan: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.stderr(`ERR_USAGE ${err instanceof Error ? err.message : String(err)}\n${FLEET_USAGE}`);
    return 2;
  }
  const r = await collectFleet({
    ...(values.scan === undefined ? {} : { scan: values.scan }),
    ...(io.home === undefined ? {} : { home: io.home }),
  });
  if (values.json === true) io.stdout(JSON.stringify(r, null, 2));
  else for (const l of renderFleet(r)) io.stdout(l);
  return r.ok ? 0 : 2;
}
