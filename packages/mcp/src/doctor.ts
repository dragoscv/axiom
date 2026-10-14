/**
 * `axiom doctor` (S-702): is this machine + root wired correctly? Each check is `ok | warn | fail`
 * with a message and a fix hint. Read-only apart from spawning the gate (which never writes).
 * Exit contract (cli-main): 0 when no check failed, 2 when any did — warnings never fail.
 */
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { journalStatus, lockStatus, verifyChain } from "@codai/axiom-apply";
import { loadProfile } from "@codai/axiom-checks";
import { HEALTH_PATH, readDaemonState } from "./daemon-proto.js";
import { GateProfileSchema } from "./gate.js";
import { findHookLogs, type HookLogStats, readHookLogStats } from "./hooklog.js";
import {
  type BinLocator,
  binAtLeast,
  CLAUDE_HOOK_ENTRY,
  compareVersions,
  DAEMON_HEALTH_TIMEOUT_MS,
  defaultBinLocator,
  defaultHealthFetch,
  GATE_COMMAND_RE,
  GITIGNORE_LINES,
  type HealthFetcher,
  INIT_FILES,
  isAxiomGateHook,
  isAxiomPostEntry,
  isCopilotPostEntry,
  isExecOnlyGateEntry,
  POST_MIN_VERSION,
  STEER_MIN_VERSION,
} from "./init.js";
import { realDir } from "./roots.js";

export {
  type BinLocator,
  compareVersions,
  DAEMON_HEALTH_TIMEOUT_MS,
  defaultBinLocator,
  defaultHealthFetch,
  type HealthFetcher,
  STEER_MIN_VERSION,
};

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DoctorResult {
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
}

/** 80 % of the 5 s hook timeout every harness applies (and then fails OPEN). */
export const GATE_P95_FAIL_MS = 4000;
export const GATE_HOOK_TIMEOUT_MS = 5000;
export const GATE_PROBE_RUNS = 5;

/**
 * Measures one `gate --stdin` round trip; returns wall ms, the exit code and whether stdout
 * carried a deny document (since 2.4.1 a deny exits 0 — D-35).
 */
export type GateProbe = (
  root: string,
  payload: string,
) => Promise<{ ms: number; exit: number; denied?: boolean }>;

export const HOOK_LOG_P95_WARN_MS = 4000;

export interface DoctorOptions {
  root: string;
  /** This CLI's version (compared against the global bin). */
  version: string;
  /** Command that runs this CLI's gate: `[execPath, ...args]`. Absent → latency check warns. */
  gateCommand?: readonly string[];
  /** Test seams. */
  probe?: GateProbe;
  locateBin?: BinLocator;
  /** Home dir: daemon state (`<home>/.axiom/daemon.json`), `~/.junie/config.json`, VS Code logs. */
  home?: string;
  /** `%APPDATA%` for the VS Code log locator on win32. */
  appData?: string;
  platform?: NodeJS.Platform;
  healthFetch?: HealthFetcher;
  /** Explicit VS Code hook log files (skips the locator). */
  hookLogs?: readonly string[] | undefined;
}

function check(id: string, status: CheckStatus, message: string, hint?: string): DoctorCheck {
  return hint === undefined ? { id, status, message } : { id, status, message, hint };
}

export function spawnGateProbe(command: readonly string[]): GateProbe {
  const [file, ...args] = command;
  return (root, payload) =>
    new Promise((resolve, reject) => {
      if (file === undefined) {
        reject(new Error("empty gate command"));
        return;
      }
      const t0 = performance.now();
      const child = spawn(file, [...args, "gate", "--stdin"], {
        cwd: root,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (out.length < 65_536) out += c;
      });
      const timer = setTimeout(() => child.kill(), GATE_HOOK_TIMEOUT_MS * 2);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          ms: performance.now() - t0,
          exit: code ?? -1,
          denied: /"permissionDecision"\s*:\s*"deny"/.test(out),
        });
      });
      child.stdin.end(payload);
    });
}

function p95(samples: readonly number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0;
}

/**
 * JSONC → JSON: drop `//` and `/* *\/` comments and trailing commas, leaving string contents
 * intact. VS Code's `.vscode/mcp.json` and `.claude/settings.json` are JSONC; reading them as
 * strict JSON reported a well-formed brivio `mcp.json` as "not valid JSON" (2026-09-27).
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readJsonFile(abs: string): Promise<{ doc?: unknown; error?: string } | undefined> {
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { error: (err as Error).message };
  }
  try {
    return { doc: JSON.parse(stripJsonc(text)) as unknown };
  } catch (err) {
    return { error: `not valid JSON(C): ${(err as Error).message}` };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const NPX_RE = /\bnpx\b/;

function copilotHookWired(doc: unknown): boolean {
  if (!isRecord(doc) || !isRecord(doc.hooks) || !Array.isArray(doc.hooks.preToolUse)) return false;
  return doc.hooks.preToolUse.some((h) => {
    if (!isRecord(h)) return false;
    const cmd = [h.exec, ...(Array.isArray(h.args) ? h.args : []), h.bash, h.powershell, h.command]
      .filter((x): x is string => typeof x === "string")
      .join(" ");
    return /\baxiom\b/.test(cmd) && /\bgate\b/.test(cmd) && !NPX_RE.test(cmd);
  });
}

/** Every gate entry is exec-only: VS Code (command/bash/powershell only) never runs it. */
function copilotHookExecOnly(doc: unknown): boolean {
  if (!isRecord(doc) || !isRecord(doc.hooks) || !Array.isArray(doc.hooks.preToolUse)) return false;
  const gate = doc.hooks.preToolUse.filter((h) => copilotHookWired({ hooks: { preToolUse: [h] } }));
  return gate.length > 0 && gate.every(isExecOnlyGateEntry);
}

function hookList(doc: unknown, event: string): unknown[] {
  if (!isRecord(doc) || !isRecord(doc.hooks)) return [];
  const list = doc.hooks[event];
  return Array.isArray(list) ? list : [];
}

function gateHookNoNpx(h: unknown): boolean {
  return (
    isAxiomGateHook(h) && !(isRecord(h) && typeof h.command === "string" && NPX_RE.test(h.command))
  );
}

/** Claude / Codex / Gemini / Junie shape: `hooks[event][].hooks[]`. */
function nestedWired(event: string): (doc: unknown) => boolean {
  return (doc) =>
    hookList(doc, event).some(
      (e) => isRecord(e) && Array.isArray(e.hooks) && e.hooks.some(gateHookNoNpx),
    );
}

function flatGateEntries(doc: unknown, event: string): Record<string, unknown>[] {
  return hookList(doc, event).filter(
    (e): e is Record<string, unknown> =>
      isRecord(e) &&
      typeof e.command === "string" &&
      GATE_COMMAND_RE.test(e.command) &&
      !NPX_RE.test(e.command),
  );
}

/** Cursor / Windsurf shape: `hooks[event][]` with a `command`. */
function flatWired(events: readonly string[]): (doc: unknown) => boolean {
  return (doc) => events.some((e) => flatGateEntries(doc, e).length > 0);
}

type Bin = Awaited<ReturnType<BinLocator>>;

function checkBin(opts: DoctorOptions, bin: Bin): DoctorCheck {
  if (bin === undefined) {
    return check(
      "bin",
      "warn",
      "global `axiom` is not on PATH — hooks calling `axiom gate` will fail (and harnesses fail open)",
      "npm install -g @codai/axiom-mcp",
    );
  }
  if (bin.version === undefined) {
    return check("bin", "warn", `axiom at ${bin.path}; version unknown`);
  }
  if (bin.version !== opts.version) {
    return check(
      "bin",
      "warn",
      `global axiom ${bin.version} (${bin.path}) differs from this CLI ${opts.version}`,
      "npm install -g @codai/axiom-mcp@latest",
    );
  }
  return check("bin", "ok", `axiom ${bin.version} at ${bin.path}`);
}

interface HookFile {
  id: string;
  /** Display path (root-relative, or `~/…` for user-level files). */
  rel: string;
  abs: string;
  wired: (doc: unknown) => boolean;
  /** Extra warning for a wired file (e.g. Cursor without failClosed). */
  extra?: (doc: unknown) => DoctorCheck | undefined;
  /**
   * S-1203: what fails OPEN for this wired harness (timeout / crash / odd exit); undefined when
   * the entry already carries the harness's fail-closed knob or the harness has none to miss.
   */
  failOpen?: (doc: unknown) => DoctorCheck | undefined;
  /** S-1205: PostToolUse wiring for harnesses that have one AXIOM uses. */
  post?: (doc: unknown, bin: Bin) => DoctorCheck;
}

const DAEMON_MITIGATION =
  "keep the gate far below the timeout: `axiom init --daemon` (resident gate) and `axiom doctor` gate.latency";

function failOpenCheck(harness: string, what: string, hint: string): DoctorCheck {
  return check(`failopen.${harness}`, "warn", what, hint);
}

/** Every gate hook object of a nested-shape event (`hooks[event][].hooks[]`). */
function nestedGateHooks(doc: unknown, event: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of hookList(doc, event)) {
    if (!isRecord(e) || !Array.isArray(e.hooks) || isAxiomPostEntry(e)) continue;
    for (const h of e.hooks) if (isRecord(h) && gateHookNoNpx(h)) out.push(h);
  }
  return out;
}

function claudeFailOpen(doc: unknown): DoctorCheck | undefined {
  const hooks = nestedGateHooks(doc, "PreToolUse");
  if (hooks.length === 0 || hooks.every((h) => h.onFailure === "block")) return undefined;
  return failOpenCheck(
    "claude",
    `${INIT_FILES.claudeSettings}: an axiom gate hook has no "onFailure": "block" — Claude Code lets the tool run when the gate times out, cannot start, exits other than 0/2 or prints invalid JSON`,
    'add "onFailure": "block" (Claude Code ≥ 2.1.295) to the axiom hook — axiom init --force',
  );
}

function copilotFailOpen(doc: unknown): DoctorCheck | undefined {
  const entries = hookList(doc, "preToolUse").filter(
    (h) =>
      isRecord(h) && !isCopilotPostEntry(h) && copilotHookWired({ hooks: { preToolUse: [h] } }),
  ) as Record<string, unknown>[];
  if (entries.length === 0) return undefined;
  const noTimeout = entries.some((e) => e.timeoutSec === undefined && e.timeout === undefined);
  return failOpenCheck(
    "copilot",
    `${INIT_FILES.copilotHook}: VS Code Local treats a gate timeout, crash or exit other than 0/2 as a non-blocking warning; Copilot CLI and the cloud agent deny on crash but always fail open on timeout — no harness knob makes this fail-closed`,
    noTimeout
      ? `set "timeoutSec" explicitly (default 30 s); ${DAEMON_MITIGATION}`
      : DAEMON_MITIGATION,
  );
}

function nestedFailOpen(harness: string, rel: string, event: string, what: string) {
  return (doc: unknown): DoctorCheck | undefined => {
    const hooks = nestedGateHooks(doc, event);
    if (hooks.length === 0) return undefined;
    const noTimeout = hooks.some((h) => h.timeout === undefined);
    return failOpenCheck(
      harness,
      `${rel}: ${what}`,
      noTimeout ? `set "timeout" on the axiom hook; ${DAEMON_MITIGATION}` : DAEMON_MITIGATION,
    );
  };
}

function windsurfFailOpen(rel: string) {
  return (doc: unknown): DoctorCheck | undefined =>
    flatGateEntries(doc, "pre_write_code").length +
      flatGateEntries(doc, "pre_run_command").length ===
    0
      ? undefined
      : failOpenCheck(
          "windsurf",
          `${rel}: Windsurf/Devin blocks only on exit 2 — a gate that crashes or exits otherwise lets the action proceed, and there is no fail-closed option`,
          DAEMON_MITIGATION,
        );
}

function postCheck(
  harness: string,
  rel: string,
  event: string,
  isPost: (v: unknown) => boolean,
  preWired: (doc: unknown) => boolean,
) {
  return (doc: unknown, bin: Bin): DoctorCheck => {
    const id = `hook.post.${harness}`;
    const wired = hookList(doc, event).some(isPost);
    if (!wired) {
      return check(
        id,
        "warn",
        preWired(doc)
          ? `${rel} has no ${event} post-write check — shell writes the PreToolUse scan cannot see go unreported`
          : `${rel} has no ${event} post-write check`,
        "axiom init --upgrade",
      );
    }
    if (bin?.version !== undefined && !binAtLeast(bin, POST_MIN_VERSION)) {
      return check(
        id,
        "warn",
        `${rel} runs \`axiom gate --post\` but the global axiom is ${bin.version} (< ${POST_MIN_VERSION}) and rejects the flag`,
        "npm install -g @codai/axiom-mcp@latest",
      );
    }
    return check(id, "ok", `${rel} runs the ${event} post-write check`);
  };
}

function cursorFailClosed(doc: unknown): DoctorCheck | undefined {
  const entries = [
    ...flatGateEntries(doc, "preToolUse"),
    ...flatGateEntries(doc, "beforeShellExecution"),
  ];
  if (entries.every((e) => e.failClosed === true)) return undefined;
  return check(
    "hook.cursor",
    "warn",
    `${INIT_FILES.cursorHooks}: an axiom gate entry lacks "failClosed": true — Cursor lets the tool run when the gate crashes or times out`,
    'add "failClosed": true to every axiom entry (axiom init --force)',
  );
}

async function nonEmptyJson(abs: string): Promise<boolean> {
  const r = await readJsonFile(abs);
  return (
    r !== undefined && (r.error !== undefined || (isRecord(r.doc) && Object.keys(r.doc).length > 0))
  );
}

async function hookFiles(root: string, home: string): Promise<HookFile[]> {
  const at = (rel: string) => path.join(root, rel);
  // Devin Desktop reads the legacy .windsurf/hooks.json only when .devin/hooks.json is missing/empty.
  const windsurfRel = (await nonEmptyJson(at(INIT_FILES.devinHooks)))
    ? INIT_FILES.devinHooks
    : INIT_FILES.windsurfHooks;
  return [
    {
      id: "hook.copilot",
      rel: INIT_FILES.copilotHook,
      abs: at(INIT_FILES.copilotHook),
      wired: copilotHookWired,
      failOpen: copilotFailOpen,
      post: postCheck(
        "copilot",
        INIT_FILES.copilotHook,
        "postToolUse",
        isCopilotPostEntry,
        copilotHookWired,
      ),
    },
    {
      id: "hook.claude",
      rel: INIT_FILES.claudeSettings,
      abs: at(INIT_FILES.claudeSettings),
      wired: nestedWired("PreToolUse"),
      failOpen: claudeFailOpen,
      post: postCheck(
        "claude",
        INIT_FILES.claudeSettings,
        "PostToolUse",
        isAxiomPostEntry,
        nestedWired("PreToolUse"),
      ),
    },
    {
      id: "hook.cursor",
      rel: INIT_FILES.cursorHooks,
      abs: at(INIT_FILES.cursorHooks),
      wired: flatWired(["preToolUse", "beforeShellExecution"]),
      extra: cursorFailClosed,
    },
    {
      id: "hook.windsurf",
      rel: windsurfRel,
      abs: at(windsurfRel),
      wired: flatWired(["pre_write_code", "pre_run_command"]),
      failOpen: windsurfFailOpen(windsurfRel),
    },
    {
      id: "hook.codex",
      rel: INIT_FILES.codexHooks,
      abs: at(INIT_FILES.codexHooks),
      wired: nestedWired("PreToolUse"),
      failOpen: nestedFailOpen(
        "codex",
        INIT_FILES.codexHooks,
        "PreToolUse",
        "Codex documents no fail-closed option — only exit 2 or a deny document blocks; a gate that times out (default 600 s) or crashes is reported as a hook failure and the tool call continues",
      ),
      post: postCheck(
        "codex",
        INIT_FILES.codexHooks,
        "PostToolUse",
        isAxiomPostEntry,
        nestedWired("PreToolUse"),
      ),
    },
    {
      id: "hook.gemini",
      rel: INIT_FILES.geminiSettings,
      abs: at(INIT_FILES.geminiSettings),
      wired: nestedWired("BeforeTool"),
      failOpen: nestedFailOpen(
        "gemini",
        INIT_FILES.geminiSettings,
        "BeforeTool",
        "Gemini CLI treats a non-zero exit other than 2 as a warning and non-JSON stdout as allow; there is no fail-closed option (timeout default 60000 ms)",
      ),
    },
    {
      id: "hook.junie",
      rel: "~/.junie/config.json",
      abs: path.join(home, ".junie", "config.json"),
      wired: nestedWired("PreToolUse"),
      failOpen: nestedFailOpen(
        "junie",
        "~/.junie/config.json",
        "PreToolUse",
        "Junie force-kills a timed-out hook and continues, logs other non-zero exits as warnings and proceeds; blockOnError exists for Stop hooks only",
      ),
    },
  ];
}

async function checkClineHooks(root: string, platform: NodeJS.Platform): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const rel of [INIT_FILES.clineHook, INIT_FILES.clineHookPs1]) {
    const abs = path.join(root, rel);
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (!GATE_COMMAND_RE.test(text) || NPX_RE.test(text)) {
      out.push(
        check(
          "hook.cline",
          "warn",
          `${rel} does not run \`axiom gate --stdin --format cline\` (npx does not count)`,
          "axiom init --harness cline --force",
        ),
      );
      continue;
    }
    if (!text.includes('"cancel":true')) {
      out.push(
        check(
          "hook.cline",
          "warn",
          `${rel} prints no cancel document when the gate cannot run — Cline ignores exit codes and lets the tool run`,
          "axiom init --harness cline --force",
        ),
      );
      continue;
    }
    if (rel === INIT_FILES.clineHook && platform !== "win32") {
      const mode = (await stat(abs)).mode;
      if ((mode & 0o111) === 0) {
        out.push(check("hook.cline", "warn", `${rel} is not executable`, `chmod 0755 ${rel}`));
        continue;
      }
    }
    out.push(check("hook.cline", "ok", `${rel} runs the axiom gate`));
  }
  return out;
}

async function checkHooks(
  root: string,
  home: string,
  platform: NodeJS.Platform,
  bin: Bin,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const f of await hookFiles(root, home)) {
    const r = await readJsonFile(f.abs);
    if (r === undefined) continue;
    if (r.error !== undefined) {
      out.push(
        check(f.id, "fail", `${f.rel}: ${r.error}`, "fix the JSON or re-run `axiom init --force`"),
      );
    } else if (f.wired(r.doc)) {
      if (f.id === "hook.copilot" && copilotHookExecOnly(r.doc)) {
        out.push(
          check(
            f.id,
            "fail",
            `${f.rel} runs the gate only via exec/args — Copilot CLI honours that, VS Code ignores the entry and never runs the gate`,
            "axiom init (2.5.2+ migrates it) or add command/bash/powershell fields",
          ),
        );
        continue;
      }
      out.push(check(f.id, "ok", `${f.rel} runs the axiom gate`));
      const extra = f.extra?.(r.doc);
      if (extra !== undefined) out.push(extra);
      const fo = f.failOpen?.(r.doc);
      if (fo !== undefined) out.push(fo);
      if (f.post !== undefined) out.push(f.post(r.doc, bin));
    } else if (f.id !== "hook.junie" || (await isDirectory(path.join(root, ".junie")))) {
      out.push(
        check(
          f.id,
          "warn",
          `${f.rel} has no axiom gate entry (npx entries do not count: they time out)`,
          f.id === "hook.claude"
            ? `add ${JSON.stringify(CLAUDE_HOOK_ENTRY)} to hooks.PreToolUse`
            : "axiom init --force",
        ),
      );
    }
  }
  out.push(...(await checkClineHooks(root, platform)));
  if (out.length === 0) {
    out.push(
      check("hook", "warn", "no PreToolUse hook config found for any harness", "axiom init"),
    );
  }
  const mcp = await readJsonFile(path.join(root, INIT_FILES.mcp));
  if (mcp !== undefined) {
    if (mcp.error !== undefined) {
      out.push(check("mcp.vscode", "warn", `${INIT_FILES.mcp}: ${mcp.error}`));
    } else {
      const has =
        isRecord(mcp.doc) && isRecord(mcp.doc.servers) && mcp.doc.servers.axiom !== undefined;
      out.push(
        has
          ? check("mcp.vscode", "ok", `${INIT_FILES.mcp} declares servers.axiom`)
          : check("mcp.vscode", "warn", `${INIT_FILES.mcp} has no servers.axiom`, "axiom init"),
      );
    }
  }
  return out;
}

async function isDirectory(abs: string): Promise<boolean> {
  return stat(abs).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

function isInside(root: string, served: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return platform === "win32" ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(served), norm(root));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function checkDaemon(
  root: string,
  home: string,
  platform: NodeJS.Platform,
  fetchHealth: HealthFetcher,
): Promise<DoctorCheck> {
  const state = await readDaemonState(home);
  if (state === undefined) {
    return check("daemon", "ok", "no resident daemon (hooks run in-process)");
  }
  const where = `${state.host}:${state.port}`;
  let res: { status: number; body: unknown };
  try {
    res = await fetchHealth(state);
  } catch (err) {
    return check(
      "daemon",
      "warn",
      `stale daemon.json: pid ${state.pid} at ${where} is unreachable (${(err as Error).message})`,
      "restart with `axiom serve --hook --root <dir>` or delete ~/.axiom/daemon.json",
    );
  }
  if (res.status !== 200) {
    return check(
      "daemon",
      "warn",
      `daemon at ${where} answered ${res.status} to ${HEALTH_PATH}`,
      res.status === 401 ? "the token in daemon.json does not match the running daemon" : undefined,
    );
  }
  const body = isRecord(res.body) ? res.body : {};
  const roots = Array.isArray(body.roots)
    ? body.roots.filter((r): r is string => typeof r === "string")
    : state.roots;
  const pid = typeof body.pid === "number" ? body.pid : state.pid;
  // `root` is a realpath (/var → /private/var, RUNNER~1 expanded); compare like with like.
  const servedReal = await Promise.all(
    roots.map((r) => realDir(path.resolve(r), "ERR_ROOT_NOT_DIR").catch(() => r)),
  );
  if (!servedReal.some((r) => isInside(root, r, platform))) {
    return check(
      "daemon",
      "warn",
      `daemon pid ${pid} at ${where} does not serve this root (roots: ${roots.join(", ") || "none"}) — hooks here fall back to in-process`,
      `restart with \`axiom serve --hook --root ${path.dirname(root)}\``,
    );
  }
  return check("daemon", "ok", `daemon pid ${pid} at ${where} serves ${roots.join(", ")}`);
}

const STEER_KEYS = ["steer", "steerGlobs", "record"] as const;

async function checkSteerCompat(root: string, bin: Bin): Promise<DoctorCheck | undefined> {
  const gp = await readJsonFile(path.join(root, INIT_FILES.gateProfile));
  if (gp === undefined || !isRecord(gp.doc)) return undefined;
  const doc = gp.doc;
  const used = STEER_KEYS.filter((k) => doc[k] !== undefined);
  if (used.length === 0) return undefined;
  if (bin?.version === undefined) return undefined;
  if (compareVersions(bin.version, STEER_MIN_VERSION) >= 0) {
    return check(
      "bin.profile",
      "ok",
      `global axiom ${bin.version} understands ${used.join(", ")} in ${INIT_FILES.gateProfile}`,
    );
  }
  return check(
    "bin.profile",
    "fail",
    `${INIT_FILES.gateProfile} uses ${used.join(", ")} but the global axiom is ${bin.version} (< ${STEER_MIN_VERSION}): its strict profile schema rejects unknown keys and the gate denies EVERY write`,
    "npm install -g @codai/axiom-mcp@latest",
  );
}

function hookLogCheck(s: HookLogStats): DoctorCheck {
  const base = `${s.runs} axiom gate runs in the VS Code hook log: p50 ${s.p50} ms, p95 ${s.p95} ms, ${s.denies} denies, ${s.timeouts} timeouts`;
  if (s.nonBlockingErrors > 0) {
    return check(
      "hook.log.vscode",
      "warn",
      `${s.nonBlockingErrors} axiom gate runs ended NonBlockingError — VS Code treated them as non-blocking (exit ≠ 0/2 or invalid JSON); a deny there did not block (${base})`,
      "axiom ≥ 2.4.1; hook must call the global bin directly",
    );
  }
  if (s.p95 > HOOK_LOG_P95_WARN_MS) {
    return check(
      "hook.log.vscode",
      "warn",
      `${base} — p95 above ${HOOK_LOG_P95_WARN_MS} ms risks the hook timeout`,
      "consider `axiom init --daemon` (resident gate) or check machine load",
    );
  }
  return check("hook.log.vscode", "ok", base);
}

/** Hooks fire for this workspace, yet the axiom gate is not among them → it is not wired. */
const GATE_SILENT_MIN_RUNS = 20;

async function checkHookLog(
  opts: DoctorOptions,
  root: string,
  copilotWired: boolean,
): Promise<DoctorCheck | undefined> {
  const files =
    opts.hookLogs ??
    (await findHookLogs({
      ...(opts.home === undefined ? {} : { home: opts.home }),
      ...(opts.appData === undefined ? {} : { appData: opts.appData }),
      ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    }));
  if (files.length === 0) return undefined;
  const stats = await readHookLogStats(files, root);
  if (stats.runs > 0) return hookLogCheck(stats);
  if (copilotWired && stats.preToolUseRuns >= GATE_SILENT_MIN_RUNS) {
    return check(
      "hook.log.vscode",
      "fail",
      `${stats.preToolUseRuns} PreToolUse hook runs for this workspace in the newest VS Code log session, 0 of them the axiom gate — VS Code is not running ${INIT_FILES.copilotHook}`,
      "axiom init (2.5.2+ writes command/bash/powershell), trust the workspace, then Developer: Reload Window",
    );
  }
  return undefined;
}

async function checkLatency(opts: DoctorOptions): Promise<DoctorCheck> {
  const probe =
    opts.probe ?? (opts.gateCommand === undefined ? undefined : spawnGateProbe(opts.gateCommand));
  if (probe === undefined) {
    return check("gate.latency", "warn", "cannot locate this CLI's entry; latency not measured");
  }
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "axiom-doctor-probe.txt", content: "probe\n" },
    cwd: opts.root,
  });
  const samples: number[] = [];
  const exits = new Set<number>();
  let denied = false;
  try {
    for (let i = 0; i < GATE_PROBE_RUNS; i++) {
      const r = await probe(opts.root, payload);
      samples.push(r.ms);
      exits.add(r.exit);
      if (r.denied === true) denied = true;
    }
  } catch (err) {
    return check("gate.latency", "fail", `gate probe did not run: ${(err as Error).message}`);
  }
  const p = Math.round(p95(samples));
  const msg = `gate --stdin p95 ${p} ms over ${GATE_PROBE_RUNS} runs (hook timeout ${GATE_HOOK_TIMEOUT_MS} ms)`;
  if (p > GATE_P95_FAIL_MS) {
    return check(
      "gate.latency",
      "fail",
      msg,
      "the harness will kill the hook and fail OPEN; check machine load / antivirus on node",
    );
  }
  if (denied || !exits.has(0)) {
    return check(
      "gate.latency",
      "warn",
      `${msg}; a benign Write was denied (exit ${[...exits].join(",")}${denied ? ", deny JSON" : ""})`,
      "check .axiom/gate-profile.json deny/allow globs",
    );
  }
  return check("gate.latency", "ok", msg);
}

async function checkProfiles(root: string): Promise<DoctorCheck[]> {
  const dir = path.join(root, ".axiom", "profiles");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    names = [];
  }
  const out: DoctorCheck[] = [];
  if (names.length === 0) {
    out.push(
      check(
        "profile",
        "warn",
        "no .axiom/profiles/*.json — builtin `default` applies",
        "axiom init",
      ),
    );
  }
  for (const f of names.sort()) {
    const name = f.slice(0, -".json".length);
    try {
      const p = await loadProfile(name, { searchDirs: [dir] });
      out.push(check(`profile.${name}`, "ok", `${name}: ${p.checks.length} checks`));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "ERR_INTERNAL";
      out.push(
        check(
          `profile.${name}`,
          "fail",
          `${f}: ${code} ${(err as Error).message}`,
          "fix the profile",
        ),
      );
    }
  }
  const gp = await readJsonFile(path.join(root, INIT_FILES.gateProfile));
  if (gp !== undefined) {
    const parsed = gp.error === undefined ? GateProfileSchema.safeParse(gp.doc) : undefined;
    if (parsed?.success === true) {
      out.push(check("gate.profile", "ok", `${INIT_FILES.gateProfile} valid`));
    } else {
      out.push(
        check(
          "gate.profile",
          "fail",
          `${INIT_FILES.gateProfile} invalid — the gate denies every write (fail-closed)`,
          "fix the file or re-run `axiom init --force`",
        ),
      );
    }
  }
  return out;
}

async function checkGitignore(root: string): Promise<DoctorCheck> {
  let text = "";
  try {
    text = await readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    // absent → not covered
  }
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const covered = [".axiom", ".axiom/", ".axiom/*", ".axiom/**", "/.axiom", "/.axiom/"].some((l) =>
    lines.has(l),
  );
  return covered
    ? check("gitignore", "ok", ".gitignore covers .axiom/")
    : check(
        "gitignore",
        "warn",
        ".gitignore does not ignore .axiom/ (journal, CAS, backups would be committed)",
        `append: ${GITIGNORE_LINES.join(" ")}`,
      );
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const st = await stat(opts.root).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    checks.push(check("root", "fail", `${opts.root} is not a directory`, "pass --root <dir>"));
    return { root: opts.root, ok: false, checks };
  }
  // Canonical root, same as init/apply (CI: /var → /private/var, Windows 8.3 short names).
  const root = await realDir(path.resolve(opts.root), "ERR_ROOT_NOT_DIR");
  checks.push(check("root", "ok", root));
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const bin = await (opts.locateBin ?? defaultBinLocator())();
  checks.push(checkBin(opts, bin));
  const steer = await checkSteerCompat(root, bin);
  if (steer !== undefined) checks.push(steer);
  const hookChecks = await checkHooks(root, home, platform, bin);
  checks.push(...hookChecks);
  const copilotWired = hookChecks.some((c) => c.id === "hook.copilot");
  const hookLog = await checkHookLog(opts, root, copilotWired);
  if (hookLog !== undefined) checks.push(hookLog);
  checks.push(await checkDaemon(root, home, platform, opts.healthFetch ?? defaultHealthFetch()));

  const lock = await lockStatus(root);
  if (!lock.held) checks.push(check("lock", "ok", "lock free"));
  else if (lock.holder?.stale === true) {
    checks.push(
      check(
        "lock",
        "warn",
        `stale lock held by pid ${lock.holder.pid}${lock.holder.host === undefined ? "" : `@${lock.holder.host}`}`,
        "the next apply reclaims a stale lock; `axiom status` shows the holder",
      ),
    );
  } else {
    checks.push(
      check("lock", "ok", `lock held by live pid ${lock.holder?.pid ?? "?"} (apply in progress)`),
    );
  }

  const js = await journalStatus(root);
  if (js.interrupted.length > 0) {
    checks.push(
      check(
        "journal",
        "fail",
        `${js.interrupted.length} interrupted journal(s): ${js.interrupted.map((j) => `${j.manifestDigest} (${j.phase})`).join(", ")}`,
        `axiom rollback ${js.interrupted[0]?.manifestDigest ?? "<digest>"} --root ${root} (the next apply also recovers automatically)`,
      ),
    );
  } else if (js.corrupt.length > 0) {
    checks.push(
      check(
        "journal",
        "fail",
        `corrupt journal file(s): ${js.corrupt.join(", ")}`,
        "inspect .axiom/journal/ (skill debug-apply-journal)",
      ),
    );
  } else {
    checks.push(check("journal", "ok", "no interrupted journals"));
  }

  const chain = await verifyChain(root);
  checks.push(
    chain.ok
      ? check("chain", "ok", `journal chain ok (${chain.entries} entries)`)
      : check(
          "chain",
          "fail",
          `ERR_JOURNAL_CHAIN at #${chain.firstBad?.seq} (${chain.firstBad?.reason})`,
          `axiom verify --journal --root ${root}`,
        ),
  );

  checks.push(...(await checkProfiles(root)));
  checks.push(await checkGitignore(root));
  // S-1206: hooks that auto-answer MCP elicitation defeat the human-only confirm step.
  // Dynamic: elicit-audit imports stripJsonc from this module.
  const { auditElicitationHooks } = await import("./elicit-audit.js");
  checks.push(...(await auditElicitationHooks(root, home)));
  checks.push(await checkLatency(opts));
  return { root, ok: !checks.some((c) => c.status === "fail"), checks };
}
