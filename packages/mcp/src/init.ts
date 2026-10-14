/**
 * `axiom init` (S-701): wire a repository for AXIOM in one idempotent step — MCP server entry,
 * PreToolUse hook(s) for the detected harness(es), a repo profile extending `default`, a gate
 * profile and the `.gitignore` lines that keep `.axiom/` state out of git while committing the
 * two policy files. Every write goes through `resolveContained` (no symlink/junction segment, no
 * escape) + `writeAtomic`; an existing file is never overwritten without `force`.
 *
 * v2.6: `--upgrade` (S-1204) edits an existing wiring in place, `--managed --out` (S-1207) writes
 * the enterprise policy layers into a directory, and every harness that has a PostToolUse event
 * AXIOM can act on (Claude Code, Codex, VS Code/Copilot) also gets the post-write check (S-1205).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import * as path from "node:path";
import { resolveContained, writeAtomic } from "@codai/axiom-apply";
import { AxiomError, ProfileNameSchema } from "@codai/axiom-schema";
import {
  CLAUDE_HOOK_PATH,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_PROTOCOL,
  type DaemonState,
  H_PROTOCOL,
  HEALTH_PATH,
  isLoopbackHost,
  readDaemonState,
} from "./daemon-proto.js";
import { realDir } from "./roots.js";

export const HARNESSES = [
  "copilot",
  "claude",
  "codex",
  "vscode",
  "cursor",
  "windsurf",
  "gemini",
  "junie",
  "cline",
] as const;
export type HarnessName = (typeof HARNESSES)[number];
export type HarnessArg = HarnessName | "auto";

export function isHarnessArg(v: string): v is HarnessArg {
  return v === "auto" || (HARNESSES as readonly string[]).includes(v);
}

export type InitAction = "created" | "merged" | "updated" | "skipped";

export interface InitFileResult {
  /** Root-relative POSIX path. */
  path: string;
  action: InitAction;
  /** Why a file was skipped (exists / already configured / unparseable). */
  reason?: string;
}

export interface InitResult {
  root: string;
  harnesses: HarnessName[];
  profile: string;
  files: InitFileResult[];
  notes: string[];
}

/** Resolves the global `axiom` bin; `undefined` = not on PATH. */
export type BinLocator = () => Promise<{ path: string; version?: string } | undefined>;

/** `GET /v1/health` of a resident daemon; rejects when unreachable. */
export type HealthFetcher = (state: DaemonState) => Promise<{ status: number; body: unknown }>;

export interface InitOptions {
  /** realpath'd root (the only directory init writes under). */
  root: string;
  harness?: HarnessArg;
  profileName?: string;
  force?: boolean;
  /**
   * Wire hooks for the resident gate daemon (`axiom serve --hook`): Claude gets an HTTP hook,
   * every command hook calls the native thin client `axiom-hook` instead of `axiom`.
   */
  daemon?: boolean;
  /**
   * S-1204: upgrade the EXISTING wiring in place (no `--force`): gate profile keys, daemon
   * clients, npx → global bin MCP entries, legacy exec hook, missing PostToolUse entries.
   * Never creates a file that is not there; never removes a user key.
   */
  upgrade?: boolean;
  /** S-1207: write the managed/enterprise policy layers into `out` (never system paths). */
  managed?: { out: string };
  /** Test seam (upgrade): the global bin. Default `defaultBinLocator()`. */
  locateBin?: BinLocator;
  /** Test seam (upgrade): is a resident daemon answering health? Default reads ~/.axiom/daemon.json. */
  daemonRunning?: () => Promise<boolean>;
}

/** Root-relative files `init` owns (doctor reads the same list). */
export const INIT_FILES = {
  mcp: ".vscode/mcp.json",
  copilotHook: ".github/hooks/axiom-gate.json",
  claudeSettings: ".claude/settings.json",
  cursorHooks: ".cursor/hooks.json",
  cursorMcp: ".cursor/mcp.json",
  devinHooks: ".devin/hooks.json",
  windsurfHooks: ".windsurf/hooks.json",
  codexHooks: ".codex/hooks.json",
  codexConfig: ".codex/config.toml",
  geminiSettings: ".gemini/settings.json",
  junieMcp: ".junie/mcp/mcp.json",
  junieGuidelines: ".junie/guidelines.md",
  clineHook: ".clinerules/hooks/PreToolUse",
  clineHookPs1: ".clinerules/hooks/PreToolUse.ps1",
  gateProfile: ".axiom/gate-profile.json",
  gitignore: ".gitignore",
} as const;

export const GITIGNORE_LINES = [".axiom/*", "!.axiom/profiles/", "!.axiom/gate-profile.json"];

/** Lines that ignore the `.axiom` directory itself — negations below it can never apply. */
const AXIOM_DIR_IGNORES = new Set([".axiom", ".axiom/", "/.axiom", "/.axiom/"]);

/** True when `.gitignore` ignores the whole `.axiom/` directory (the policy files cannot be committed). */
export async function gitignoreHidesPolicy(root: string): Promise<boolean> {
  const text = await readOrUndefined(path.join(root, ".gitignore"));
  if (text === undefined) return false;
  return text.split(/\r?\n/).some((l) => AXIOM_DIR_IGNORES.has(l.trim()));
}

/** A hook command that runs the gate through the global bin or the native thin client. */
export const GATE_COMMAND_RE = /\baxiom(?:-hook)?\b.*\bgate\b/;

/**
 * Seconds a hook may take. Every harness that documents a timeout lets the tool run when it
 * fires (fail-open), and a cold Windows PowerShell start alone can exceed 5 s under load.
 */
export const HOOK_TIMEOUT_SEC = 15;

export type GateBin = "axiom" | "axiom-hook";

export function gateCommand(bin: GateBin, format: string): string {
  return `${bin} gate --stdin --format ${format}`;
}

/**
 * The same command for a harness that runs it through `powershell -Command` on Windows
 * (VS Code Local, Windsurf/Devin, Codex): call the `.cmd` shim/exe explicitly — a bare name
 * resolves to npm's `axiom.ps1`, which may be blocked by execution policy — and propagate the
 * exit code, because `-Command` turns any code other than 0/1 into 1 and exit 2 IS the deny.
 */
export function gateCommandPowerShell(bin: GateBin, format: string): string {
  const exe = bin === "axiom" ? "axiom.cmd" : "axiom-hook.exe";
  return `${exe} gate --stdin --format ${format}; exit $LASTEXITCODE`;
}

/**
 * PostToolUse check (S-1205): always the global `axiom` bin — the thin client and the daemon
 * answer PreToolUse only, and a post check is never on the deny-latency path.
 */
export function gatePostCommand(format: string): string {
  return `axiom gate --stdin --post --format ${format}`;
}

export function gatePostCommandPowerShell(format: string): string {
  return `axiom.cmd gate --stdin --post --format ${format}; exit $LASTEXITCODE`;
}

/** First global bin that understands `axiom gate --post` (older gates reject the flag). */
export const POST_MIN_VERSION = "2.6.0";

/** A gate command (pre or post) that carries `--post`. */
export function isPostGateCommand(cmd: string): boolean {
  return GATE_COMMAND_RE.test(cmd) && /(?:^|\s)--post(?:\s|;|$)/.test(cmd);
}

/**
 * `.github/hooks/axiom-gate.json` — read by VS Code (Local harness and Agent Host), Copilot CLI
 * and the Copilot cloud agent. VS Code only understands `command` / `bash` / `powershell`
 * (`exec`/`args` is Copilot-CLI-only and made VS Code skip the hook silently — 0 gate runs in
 * ~11k tool calls, 2026-10-14). `bash` serves POSIX and the Linux cloud agent; `--format auto`
 * answers each harness in its own shape. `postToolUse` (S-1205): VS Code maps the Copilot event
 * name to its PostToolUse (which honours `decision: "block"`); Copilot CLI reads only
 * `additionalContext` there.
 */
export function copilotHook(bin: GateBin = "axiom"): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      preToolUse: [
        {
          type: "command",
          command: gateCommand(bin, "auto"),
          bash: gateCommand(bin, "auto"),
          powershell: gateCommandPowerShell(bin, "auto"),
          timeoutSec: HOOK_TIMEOUT_SEC,
        },
      ],
      postToolUse: [COPILOT_POST_ENTRY],
    },
  };
}

export const COPILOT_POST_ENTRY = {
  type: "command",
  command: gatePostCommand("auto"),
  bash: gatePostCommand("auto"),
  powershell: gatePostCommandPowerShell("auto"),
  timeoutSec: HOOK_TIMEOUT_SEC,
};

/** Global bin, never `npx` — `npx` resolution alone exceeds every harness hook timeout (hooks.md). */
export const COPILOT_HOOK = copilotHook("axiom");

/** `--daemon`: same document, the native thin client (falls back to in-process `axiom gate`). */
export const COPILOT_HOOK_DAEMON = copilotHook("axiom-hook");

/** File tools + shell (Claude names it `PowerShell` on Windows without Git Bash). */
export const CLAUDE_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell";

/** `onFailure: "block"` (Claude Code ≥ 2.1.295): a crashed or timed-out gate refuses the tool. */
export const CLAUDE_HOOK_ENTRY = {
  matcher: CLAUDE_MATCHER,
  hooks: [
    {
      type: "command",
      command: gateCommand("axiom", "claude"),
      timeout: HOOK_TIMEOUT_SEC,
      onFailure: "block",
    },
  ],
};

/** `--daemon`: Claude posts the payload to the resident daemon; `onFailure: block` = fail-closed. */
export const CLAUDE_HTTP_HOOK_ENTRY = {
  matcher: CLAUDE_MATCHER,
  hooks: [
    {
      type: "http",
      url: `http://${DAEMON_DEFAULT_HOST}:${DAEMON_DEFAULT_PORT}${CLAUDE_HOOK_PATH}`,
      timeout: 5,
      onFailure: "block",
    },
  ],
};

/** Tools whose PostToolUse payload tells us what changed (Bash: `tool_response.bashEditDiff`). */
export const CLAUDE_POST_MATCHER = "Bash|PowerShell|Write|Edit|MultiEdit";

/**
 * S-1205: after the tool ran, check what it ACTUALLY changed. A post hook cannot undo — on a
 * protected path it returns `{"decision":"block","reason":…}` so Claude is told to revert. No
 * `onFailure`: there is nothing left to block once the tool has run.
 */
export const CLAUDE_POST_HOOK_ENTRY = {
  matcher: CLAUDE_POST_MATCHER,
  hooks: [{ type: "command", command: gatePostCommand("claude"), timeout: HOOK_TIMEOUT_SEC }],
};

export const MCP_SERVER_ENTRY = {
  type: "stdio",
  command: "npx",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code substitutes ${workspaceFolder} itself.
  args: ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "${workspaceFolder}"],
};

/** Cursor interpolates `${workspaceFolder}` in mcp.json command/args/env. */
export const CURSOR_MCP_ENTRY = {
  command: "npx",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor substitutes ${workspaceFolder} itself.
  args: ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "${workspaceFolder}"],
};

/** Harnesses without a documented workspace variable: the server starts in the project dir. */
export const PROJECT_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "."],
};

export const CODEX_MCP_TOML = [
  "[mcp_servers.axiom]",
  'command = "npx"',
  'args = ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "."]',
];

export function cursorHooks(bin: GateBin = "axiom"): Record<string, unknown> {
  const command = gateCommand(bin, "cursor");
  return {
    version: 1,
    hooks: {
      preToolUse: [{ command, matcher: "Write|Delete|Shell", timeout: 10, failClosed: true }],
      beforeShellExecution: [{ command, timeout: 10, failClosed: true }],
    },
  };
}

export function windsurfHooks(bin: GateBin = "axiom"): Record<string, unknown> {
  const command = gateCommand(bin, "windsurf");
  // Only exit 2 blocks in Windsurf/Devin; on Windows the command runs via `powershell -Command`.
  const powershell = gateCommandPowerShell(bin, "windsurf");
  return {
    hooks: {
      pre_write_code: [{ command, powershell }],
      pre_run_command: [{ command, powershell }],
    },
  };
}

/**
 * Codex matches shell commands AND unified exec (`exec_command`) as `Bash`, and `apply_patch`
 * also as `Edit`/`Write` (developers.openai.com/codex/hooks) — no separate PowerShell tool name
 * is documented, so `Bash` covers Windows shells too.
 */
export const CODEX_MATCHER = "^(Bash|apply_patch|Edit|Write)$";

export function codexHookEntry(bin: GateBin = "axiom"): Record<string, unknown> {
  const command = gateCommand(bin, "codex");
  return {
    matcher: CODEX_MATCHER,
    hooks: [
      {
        type: "command",
        command,
        commandWindows: gateCommandPowerShell(bin, "codex"),
        timeout: 10,
        statusMessage: "AXIOM gate",
      },
    ],
  };
}

/** Codex PostToolUse: `decision: "block"` replaces the tool result with the reason. */
export function codexPostHookEntry(): Record<string, unknown> {
  return {
    matcher: CODEX_MATCHER,
    hooks: [
      {
        type: "command",
        command: gatePostCommand("codex"),
        commandWindows: gatePostCommandPowerShell("codex"),
        timeout: 10,
        statusMessage: "AXIOM post-write check",
      },
    ],
  };
}

export function geminiHookEntry(bin: GateBin = "axiom"): Record<string, unknown> {
  return {
    matcher: "write_file|replace|run_shell_command",
    hooks: [
      {
        name: "axiom-gate",
        type: "command",
        command: gateCommand(bin, "gemini"),
        timeout: 10000,
      },
    ],
  };
}

/** User-level only (`~/.junie/config.json`): project hooks are ignored by default. */
export function junieUserHooks(bin: GateBin = "axiom"): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit|Bash",
          hooks: [{ type: "command", command: gateCommand(bin, "junie"), timeout: 10 }],
        },
      ],
    },
  };
}

export const JUNIE_GUIDELINES_MARKER = "<!-- axiom -->";

export const JUNIE_GUIDELINES_BLOCK = [
  JUNIE_GUIDELINES_MARKER,
  "## AXIOM write gate",
  "",
  "This repository is guarded by AXIOM. For multi-file or sensitive changes use the `axiom_write`",
  "MCP tool (call it once for a preview, then again with `confirmDigest`); never edit `.axiom/`,",
  "`.git/`, lockfiles or `.env*` files.",
];

const CLINE_CANCEL_NOT_FOUND =
  '{"cancel":true,"errorMessage":"AXIOM gate unavailable: axiom not on PATH"}';
const CLINE_CANCEL_FAILED =
  '{"cancel":true,"errorMessage":"AXIOM gate unavailable: axiom failed to run"}';

/** POSIX hook (mode 0755). Cline ignores exit codes, so every failure prints a cancel document. */
export function clineHookSh(bin: GateBin = "axiom"): string {
  return [
    "#!/usr/bin/env sh",
    "# AXIOM gate (axiom init). Cline ignores exit codes: a gate that cannot run prints a cancel.",
    `command -v ${bin} >/dev/null 2>&1 || { printf '%s\\n' '${CLINE_CANCEL_NOT_FOUND}'; exit 0; }`,
    `out=$(${gateCommand(bin, "cline")})`,
    "rc=$?",
    'if [ -n "$out" ]; then',
    "  printf '%s\\n' \"$out\"",
    'elif [ "$rc" -ne 0 ]; then',
    `  printf '%s\\n' '${CLINE_CANCEL_FAILED}'`,
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** Windows hook, run as `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`. */
export function clineHookPs1(bin: GateBin = "axiom"): string {
  return [
    "# AXIOM gate (axiom init). Cline ignores exit codes: a gate that cannot run prints a cancel.",
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `if (-not (Get-Command ${bin} -ErrorAction SilentlyContinue)) {`,
    `  [Console]::Out.WriteLine('${CLINE_CANCEL_NOT_FOUND}')`,
    "  exit 0",
    "}",
    "try {",
    "  $payload = [Console]::In.ReadToEnd()",
    `  $out = ($payload | & ${gateCommand(bin, "cline")}) -join "\`n"`,
    "  if ($out.Trim() -ne '') {",
    "    [Console]::Out.WriteLine($out)",
    "  } elseif ($LASTEXITCODE -ne 0) {",
    `    [Console]::Out.WriteLine('${CLINE_CANCEL_FAILED}')`,
    "  }",
    "} catch {",
    `  [Console]::Out.WriteLine('${CLINE_CANCEL_FAILED}')`,
    "}",
    "exit 0",
    "",
  ].join("\n");
}

const BUILTIN_PROFILE_NAMES = new Set(["default", "strict", "permissive"]);

/** Repo directory name → a valid, non-builtin profile name (`^[a-z0-9][a-z0-9._-]{0,63}$`). */
export function profileNameFor(dir: string): string {
  let n = path
    .basename(dir)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  if (n === "") n = "repo";
  // A repo profile named like a builtin would `extends` itself (cycle).
  if (BUILTIN_PROFILE_NAMES.has(n)) n = `${n}-repo`;
  return n;
}

export function repoProfile(name: string): Record<string, unknown> {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Profile",
    name,
    extends: "default",
    facts: { allowRepo: true, allowGuards: false },
    checks: [
      {
        id: "repo.noOverwriteOf",
        predicate: "repo.noOverwriteOf",
        params: {
          globs: [
            ".git/**",
            ".axiom/**",
            ".github/**",
            "pnpm-lock.yaml",
            "**/*.lock",
            ".env*",
            "**/.env*",
          ],
        },
      },
      { id: "content.noSecrets", predicate: "content.noSecrets", params: {} },
      {
        id: "path.deny",
        predicate: "path.deny",
        params: { globs: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/.turbo/**"] },
      },
    ],
  };
}

export const GATE_PROFILE = {
  deny: [
    ".git/**",
    ".axiom/**",
    ".github/**",
    "pnpm-lock.yaml",
    "**/*.lock",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
  ],
  noSecrets: true,
  pii: false,
  maxBytes: 262144,
  steer: "hint",
  record: true,
};

// ------------------------------------------------- shared with doctor (S-1204) --

/** First version whose strict gate profile schema knows `steer` / `steerGlobs` / `record`. */
export const STEER_MIN_VERSION = "2.5.0";
export const DAEMON_HEALTH_TIMEOUT_MS = 1000;

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    (/(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? ["0", "0", "0"]).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when the located bin reports a version ≥ `min` (unknown version → false). */
export function binAtLeast(
  bin: { version?: string | undefined } | undefined,
  min: string,
): boolean {
  return bin?.version !== undefined && compareVersions(bin.version, min) >= 0;
}

function execFileText(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
      err === null ? resolve(String(stdout)) : reject(err),
    );
  });
}

/** `where axiom` / `which axiom` (no shell), then the version from the bin or its package. */
export function defaultBinLocator(): BinLocator {
  return async () => {
    const win = process.platform === "win32";
    let found: string | undefined;
    try {
      const out = await execFileText(win ? "where" : "which", ["axiom"], 5000);
      const lines = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "");
      // `where` also lists npm's extensionless sh shim; the .exe/.cmd is what a hook runs.
      found = (win ? lines.find((l) => /\.(exe|cmd)$/i.test(l)) : undefined) ?? lines[0];
    } catch {
      return undefined;
    }
    if (found === undefined) return undefined;
    // Windows shims (.cmd/.ps1/sh) cannot be execFile'd without a shell: read the package instead.
    if (win && !/\.exe$/i.test(found)) {
      const dir = path.dirname(found);
      for (const pkg of [
        path.join(dir, "node_modules", "@codai", "axiom-mcp", "package.json"),
        path.join(dir, "global", "5", "node_modules", "@codai", "axiom-mcp", "package.json"),
      ]) {
        try {
          const v = (JSON.parse(await readFile(pkg, "utf8")) as { version?: unknown }).version;
          if (typeof v === "string") return { path: found, version: v };
        } catch {
          // try the next layout
        }
      }
      return { path: found };
    }
    try {
      const v = (await execFileText(found, ["--version"], 5000)).trim();
      return v === "" ? { path: found } : { path: found, version: v };
    } catch {
      return { path: found };
    }
  };
}

/** node:http GET of the daemon health endpoint, 1 s budget, loopback only. */
export function defaultHealthFetch(timeoutMs = DAEMON_HEALTH_TIMEOUT_MS): HealthFetcher {
  return (state) =>
    new Promise((resolve, reject) => {
      // daemon.json is user-writable: a tampered host must not receive the bearer token.
      if (!isLoopbackHost(state.host)) {
        reject(new Error(`daemon host ${state.host} is not loopback`));
        return;
      }
      const headers: Record<string, string> = { [H_PROTOCOL]: String(DAEMON_PROTOCOL) };
      if (state.token !== undefined) headers.authorization = `Bearer ${state.token}`;
      const req = request(
        { host: state.host, port: state.port, path: HEALTH_PATH, method: "GET", headers },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            if (body.length < 65_536) body += c;
          });
          res.on("end", () => {
            let doc: unknown;
            try {
              doc = JSON.parse(body);
            } catch {
              doc = undefined;
            }
            resolve({ status: res.statusCode ?? 0, body: doc });
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
}

/** `~/.axiom/daemon.json` exists and its daemon answers 200 on `/v1/health`. */
export function defaultDaemonRunning(
  home?: string,
  fetchHealth: HealthFetcher = defaultHealthFetch(),
): () => Promise<boolean> {
  return async () => {
    const state = await readDaemonState(home);
    if (state === undefined) return false;
    try {
      return (await fetchHealth(state)).status === 200;
    } catch {
      return false;
    }
  };
}

async function readOrUndefined(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function exists(root: string, rel: string): Promise<boolean> {
  return stat(path.join(root, rel)).then(
    () => true,
    () => false,
  );
}

/** Marker dir → harness, in detection order. */
const HARNESS_MARKERS: readonly [string, HarnessName][] = [
  [".github", "copilot"],
  [".claude", "claude"],
  [".codex", "codex"],
  [".vscode", "vscode"],
  [".cursor", "cursor"],
  [".windsurf", "windsurf"],
  [".devin", "windsurf"],
  [".gemini", "gemini"],
  [".junie", "junie"],
  [".clinerules", "cline"],
];

async function isDir(root: string, rel: string): Promise<boolean> {
  return stat(path.join(root, rel)).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** `auto`: one harness per marker dir present; none → copilot + vscode. */
export async function detectHarnesses(
  root: string,
  arg: HarnessArg = "auto",
): Promise<HarnessName[]> {
  if (arg !== "auto") return [arg];
  const found: HarnessName[] = [];
  for (const [dir, h] of HARNESS_MARKERS) {
    if (!found.includes(h) && (await isDir(root, dir))) found.push(h);
  }
  return found.length === 0 ? ["copilot", "vscode"] : found;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

class Writer {
  readonly files: InitFileResult[] = [];
  private readonly root: string;
  private readonly force: boolean;
  constructor(root: string, force: boolean) {
    this.root = root;
    this.force = force;
  }

  private async write(rel: string, text: string, mode?: "0644" | "0755"): Promise<void> {
    // Contained: rejects a symlink/junction segment (ERR_SYMLINK_IN_PATH) or an escape.
    const { abs } = await resolveContained(this.root, rel);
    await writeAtomic(abs, new TextEncoder().encode(text), mode);
  }

  private record(rel: string, action: InitAction, reason?: string): void {
    this.files.push(reason === undefined ? { path: rel, action } : { path: rel, action, reason });
  }

  /** Whole-file ownership: create, or `updated` with `force`, else `skipped (exists)`. */
  async owned(rel: string, text: string, mode?: "0644" | "0755"): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current === undefined) {
      await this.write(rel, text, mode);
      this.record(rel, "created");
    } else if (current === text) {
      this.record(rel, "skipped", "up to date");
    } else if (this.force) {
      await this.write(rel, text, mode);
      this.record(rel, "updated");
    } else {
      this.record(rel, "skipped", "exists");
    }
  }

  /**
   * Append-only text file (TOML, Markdown): when `marker` is absent, append `block`; never
   * rewrite existing content (we cannot round-trip TOML/Markdown edits safely).
   */
  /** Overwrite a file we own and know to be broken (no `--force` needed). */
  async replaceOwned(rel: string, text: string, reason: string): Promise<void> {
    await this.write(rel, text);
    this.record(rel, "updated", reason);
  }

  async appendBlock(rel: string, marker: RegExp, block: readonly string[]): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current !== undefined && marker.test(current)) {
      this.record(rel, "skipped", "already configured");
      return;
    }
    const eol = current?.includes("\r\n") ? "\r\n" : "\n";
    const body = block.join(eol) + eol;
    if (current === undefined || current === "") {
      await this.write(rel, body);
      this.record(rel, current === undefined ? "created" : "updated");
      return;
    }
    const sep = current.endsWith("\n") ? eol : eol + eol;
    await this.write(rel, `${current}${sep}${body}`);
    this.record(rel, "merged");
  }

  /**
   * Shared JSON file: `edit(doc)` returns "present" (our entry is already there), or mutates
   * `doc` and returns "added" / "replaced". Replacement only happens with `force`.
   */
  async mergeJson(
    rel: string,
    fresh: () => Record<string, unknown>,
    edit: (doc: Record<string, unknown>, force: boolean) => "present" | "added" | "replaced",
  ): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current === undefined) {
      await this.write(rel, json(fresh()));
      this.record(rel, "created");
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(current);
    } catch {
      // JSONC (comments) or broken JSON: never rewrite a file we cannot round-trip.
      this.record(rel, "skipped", "not plain JSON; add the entry by hand");
      return;
    }
    if (!isRecord(doc)) {
      this.record(rel, "skipped", "top level is not an object");
      return;
    }
    const r = edit(doc, this.force);
    if (r === "present") {
      this.record(rel, "skipped", "already configured");
      return;
    }
    await this.write(rel, json(doc));
    this.record(rel, r === "added" ? "merged" : "updated");
  }

  /**
   * `--upgrade`: edit an EXISTING plain-JSON file in place. `edit(doc)` mutates and returns the
   * reasons of what it changed; none → `skipped (up to date)`. A missing file is not created,
   * a JSONC file is never rewritten.
   */
  async upgradeJson(rel: string, edit: (doc: Record<string, unknown>) => string[]): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current === undefined) return;
    let doc: unknown;
    try {
      doc = JSON.parse(current);
    } catch {
      this.record(rel, "skipped", "not plain JSON; upgrade by hand");
      return;
    }
    if (!isRecord(doc)) {
      this.record(rel, "skipped", "top level is not an object");
      return;
    }
    const reasons = edit(doc);
    if (reasons.length === 0) {
      this.record(rel, "skipped", "up to date");
      return;
    }
    await this.write(rel, json(doc));
    this.record(rel, "updated", reasons.join("; "));
  }

  /** `--upgrade` for a text file: `edit(text)` → new text + reasons; missing file untouched. */
  async upgradeText(
    rel: string,
    edit: (text: string) => { text: string; reasons: string[] },
  ): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current === undefined) return;
    const r = edit(current);
    if (r.reasons.length === 0 || r.text === current) {
      this.record(rel, "skipped", "up to date");
      return;
    }
    await this.write(rel, r.text);
    this.record(rel, "updated", r.reasons.join("; "));
  }

  async appendLines(rel: string, lines: readonly string[]): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    const have = new Set((current ?? "").split(/\r?\n/).map((l) => l.trim()));
    const missing = lines.filter((l) => !have.has(l));
    if (missing.length === 0) {
      this.record(rel, "skipped", "already present");
      return;
    }
    const eol = current?.includes("\r\n") ? "\r\n" : "\n";
    const prefix =
      current === undefined || current === ""
        ? ""
        : current.endsWith("\n")
          ? current
          : current + eol;
    await this.write(rel, `${prefix}${missing.join(eol)}${eol}`);
    this.record(rel, current === undefined ? "created" : "updated");
  }
}

type Merge = "present" | "added" | "replaced";

function combine(results: readonly Merge[]): Merge {
  if (results.every((r) => r === "present")) return "present";
  return results.includes("replaced") ? "replaced" : "added";
}

function child(doc: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = doc[key];
  if (isRecord(v)) return v;
  const fresh: Record<string, unknown> = {};
  doc[key] = fresh;
  return fresh;
}

function mergeServer(
  doc: Record<string, unknown>,
  key: "servers" | "mcpServers",
  entry: Record<string, unknown>,
  force: boolean,
): Merge {
  const servers = child(doc, key);
  const had = servers.axiom !== undefined;
  if (had && !force) return "present";
  servers.axiom = entry;
  return had ? "replaced" : "added";
}

function mergeMcp(doc: Record<string, unknown>, force: boolean): Merge {
  return mergeServer(doc, "servers", MCP_SERVER_ENTRY, force);
}

/** Flat hook entry (`{command, …}`: Cursor, Windsurf) that runs the gate. */
export function isFlatGateEntry(v: unknown): boolean {
  return isRecord(v) && typeof v.command === "string" && GATE_COMMAND_RE.test(v.command);
}

/** A Copilot-format entry that ONLY uses `exec`/`args` (Copilot CLI) — invisible to VS Code. */
export function isExecOnlyGateEntry(v: unknown): boolean {
  if (!isRecord(v) || typeof v.exec !== "string") return false;
  if (v.command !== undefined || v.bash !== undefined || v.powershell !== undefined) return false;
  const args = Array.isArray(v.args)
    ? v.args.filter((a): a is string => typeof a === "string")
    : [];
  return GATE_COMMAND_RE.test([v.exec, ...args].join(" "));
}

/** `.github/hooks/axiom-gate.json` written by axiom < 2.5.2: every preToolUse entry is exec-only. */
export async function isLegacyExecHook(abs: string): Promise<boolean> {
  const text = await readOrUndefined(abs);
  if (text === undefined) return false;
  try {
    const doc = JSON.parse(text) as unknown;
    const list = isRecord(doc) && isRecord(doc.hooks) ? doc.hooks.preToolUse : undefined;
    return Array.isArray(list) && list.length > 0 && list.every(isExecOnlyGateEntry);
  } catch {
    return false;
  }
}

/** Claude-style hook hit `{hooks:[…]}`: a gate command (`axiom` / `axiom-hook`) or the daemon http hook. */
export function isAxiomGateHook(h: unknown): boolean {
  if (!isRecord(h)) return false;
  if (typeof h.command === "string" && GATE_COMMAND_RE.test(h.command)) return true;
  return h.type === "http" && typeof h.url === "string" && h.url.endsWith(CLAUDE_HOOK_PATH);
}

export function isAxiomGateEntry(v: unknown): boolean {
  return isRecord(v) && Array.isArray(v.hooks) && v.hooks.some(isAxiomGateHook);
}

/** Claude/Codex-style entry whose hooks run `axiom gate … --post`. */
export function isAxiomPostEntry(v: unknown): boolean {
  return (
    isRecord(v) &&
    Array.isArray(v.hooks) &&
    v.hooks.some(
      (h) => isRecord(h) && typeof h.command === "string" && isPostGateCommand(h.command),
    )
  );
}

/** Copilot-format entry (`command`/`bash`/`powershell`) that runs `axiom gate … --post`. */
export function isCopilotPostEntry(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return [v.command, v.bash, v.powershell].some(
    (c) => typeof c === "string" && isPostGateCommand(c),
  );
}

/** Add/replace our entry in `doc.hooks[event]`, keeping every other entry. */
function mergeHookList(
  doc: Record<string, unknown>,
  event: string,
  entry: unknown,
  mine: (v: unknown) => boolean,
  force: boolean,
): Merge {
  const hooks = child(doc, "hooks");
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  hooks[event] = list;
  const i = list.findIndex(mine);
  if (i >= 0 && !force) return "present";
  if (i >= 0) {
    list[i] = entry;
    return "replaced";
  }
  list.push(entry);
  return "added";
}

type Editor = (doc: Record<string, unknown>, force: boolean) => Merge;

/** A PreToolUse entry that is ours and not the post check (a pre list never holds `--post`). */
function isPreGateEntry(v: unknown): boolean {
  return isAxiomGateEntry(v) && !isAxiomPostEntry(v);
}

function claudeEditor(entry: unknown, post: boolean): Editor {
  return (doc, force) =>
    combine([
      mergeHookList(doc, "PreToolUse", entry, isPreGateEntry, force),
      ...(post
        ? [mergeHookList(doc, "PostToolUse", CLAUDE_POST_HOOK_ENTRY, isAxiomPostEntry, force)]
        : []),
    ]);
}

/** Merge the first entry of each `fresh.hooks[event]` into the target doc (flat hook shape). */
function flatEditor(fresh: Record<string, unknown>, events: readonly string[]): Editor {
  const freshHooks = fresh.hooks as Record<string, unknown[]>;
  return (doc, force) =>
    combine(events.map((e) => mergeHookList(doc, e, freshHooks[e]?.[0], isFlatGateEntry, force)));
}

export interface HarnessWiring {
  bin: GateBin;
  daemon: boolean;
  /** Write PostToolUse entries (S-1205) — false when the global bin predates `gate --post`. */
  post: boolean;
}

async function wireCursor(w: Writer, wire: HarnessWiring): Promise<void> {
  const fresh = cursorHooks(wire.bin);
  const events = ["preToolUse", "beforeShellExecution"];
  await w.mergeJson(
    INIT_FILES.cursorHooks,
    () => fresh,
    (doc, force) => {
      const r = flatEditor(fresh, events)(doc, force);
      if (doc.version === undefined) doc.version = 1;
      return r;
    },
  );
  await w.mergeJson(
    INIT_FILES.cursorMcp,
    () => ({ mcpServers: { axiom: CURSOR_MCP_ENTRY } }),
    (doc, force) => mergeServer(doc, "mcpServers", CURSOR_MCP_ENTRY, force),
  );
}

async function wireWindsurf(w: Writer, root: string, wire: HarnessWiring): Promise<string> {
  const rel = (await isDir(root, ".devin")) ? INIT_FILES.devinHooks : INIT_FILES.windsurfHooks;
  const fresh = windsurfHooks(wire.bin);
  await w.mergeJson(rel, () => fresh, flatEditor(fresh, ["pre_write_code", "pre_run_command"]));
  return rel;
}

async function wireCodex(w: Writer, wire: HarnessWiring): Promise<void> {
  const entry = codexHookEntry(wire.bin);
  const post = codexPostHookEntry();
  await w.mergeJson(
    INIT_FILES.codexHooks,
    () => ({
      hooks: wire.post ? { PreToolUse: [entry], PostToolUse: [post] } : { PreToolUse: [entry] },
    }),
    (doc, force) =>
      combine([
        mergeHookList(doc, "PreToolUse", entry, isPreGateEntry, force),
        ...(wire.post ? [mergeHookList(doc, "PostToolUse", post, isAxiomPostEntry, force)] : []),
      ]),
  );
  await w.appendBlock(INIT_FILES.codexConfig, /^\s*\[mcp_servers\.axiom\]\s*$/m, CODEX_MCP_TOML);
}

async function wireGemini(w: Writer, wire: HarnessWiring): Promise<void> {
  const entry = geminiHookEntry(wire.bin);
  await w.mergeJson(
    INIT_FILES.geminiSettings,
    () => ({ hooks: { BeforeTool: [entry] }, mcpServers: { axiom: PROJECT_MCP_ENTRY } }),
    (doc, force) =>
      combine([
        mergeHookList(doc, "BeforeTool", entry, isAxiomGateEntry, force),
        mergeServer(doc, "mcpServers", PROJECT_MCP_ENTRY, force),
      ]),
  );
}

async function wireJunie(w: Writer): Promise<void> {
  await w.mergeJson(
    INIT_FILES.junieMcp,
    () => ({ mcpServers: { axiom: PROJECT_MCP_ENTRY } }),
    (doc, force) => mergeServer(doc, "mcpServers", PROJECT_MCP_ENTRY, force),
  );
  await w.appendBlock(INIT_FILES.junieGuidelines, /^<!-- axiom -->\s*$/m, JUNIE_GUIDELINES_BLOCK);
}

async function wireCline(w: Writer, wire: HarnessWiring): Promise<void> {
  await w.owned(INIT_FILES.clineHook, clineHookSh(wire.bin), "0755");
  await w.owned(INIT_FILES.clineHookPs1, clineHookPs1(wire.bin));
}

function checkProfileName(profile: string): void {
  if (!ProfileNameSchema.safeParse(profile).success || BUILTIN_PROFILE_NAMES.has(profile)) {
    throw new AxiomError(
      "ERR_INVALID_PROFILE",
      `profile name must match ^[a-z0-9][a-z0-9._-]{0,63}$ and not be a builtin: ${profile}`,
      { details: { profile } },
    );
  }
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  if (opts.managed !== undefined) return runManaged(opts, opts.managed.out);
  // realpath first: resolveContained compares against realpaths (CI: /var → /private/var, RUNNER~1).
  const root = await realDir(path.resolve(opts.root), "ERR_ROOT_NOT_DIR");
  const harnesses = await detectHarnesses(root, opts.harness ?? "auto");
  const profile = opts.profileName ?? profileNameFor(root);
  checkProfileName(profile);
  if (opts.upgrade === true) return runUpgrade(opts, root, harnesses, profile);
  const w = new Writer(root, opts.force === true);
  const notes: string[] = [];
  const daemon = opts.daemon === true;
  const wire: HarnessWiring = { bin: daemon ? "axiom-hook" : "axiom", daemon, post: true };
  const has = (h: HarnessName) => harnesses.includes(h);

  await w.mergeJson(INIT_FILES.mcp, () => ({ servers: { axiom: MCP_SERVER_ENTRY } }), mergeMcp);
  if (has("copilot") || has("vscode")) {
    const text = json(daemon ? COPILOT_HOOK_DAEMON : COPILOT_HOOK);
    if (await isLegacyExecHook(path.join(root, INIT_FILES.copilotHook))) {
      await w.replaceOwned(
        INIT_FILES.copilotHook,
        text,
        "migrated exec-only hook (VS Code ignored it)",
      );
    } else {
      await w.owned(INIT_FILES.copilotHook, text);
    }
  }
  if (has("claude")) {
    const entry = daemon ? CLAUDE_HTTP_HOOK_ENTRY : CLAUDE_HOOK_ENTRY;
    await w.mergeJson(
      INIT_FILES.claudeSettings,
      () => ({ hooks: { PreToolUse: [entry], PostToolUse: [CLAUDE_POST_HOOK_ENTRY] } }),
      claudeEditor(entry, wire.post),
    );
  }
  if (has("codex")) {
    await wireCodex(w, wire);
    notes.push(
      "codex: project hooks in .codex/hooks.json run only after you trust the project and review them via /hooks",
    );
  }
  if (has("cursor")) {
    await wireCursor(w, wire);
    if (has("claude")) {
      notes.push(
        "cursor: Cursor also runs Claude hooks from .claude/settings.json — the gate runs twice per write (harmless, slower)",
      );
    }
  }
  if (has("windsurf")) {
    const rel = await wireWindsurf(w, root, wire);
    notes.push(
      `windsurf: hooks in ${rel} do not load in Restricted Mode; MCP is user-level only — add "axiom" to %APPDATA%\\devin\\mcp_config.json (Windows) or ~/.config/devin/mcp_config.json`,
    );
  }
  if (has("gemini")) await wireGemini(w, wire);
  if (has("junie")) {
    await wireJunie(w);
    notes.push(
      `junie: hooks run only in Junie CLI and only from the USER config ~/.junie/config.json (the IDE plugin runs none) — merge ${JSON.stringify(junieUserHooks(wire.bin))}`,
    );
  }
  if (has("cline")) {
    await wireCline(w, wire);
    notes.push(
      'cline: tick "Enable Hooks" in Cline settings; Cline has no project MCP file — add "axiom" in the Cline MCP settings',
    );
  }
  await w.owned(`.axiom/profiles/${profile}.json`, json(repoProfile(profile)));
  await w.owned(INIT_FILES.gateProfile, json(GATE_PROFILE));
  await w.appendLines(INIT_FILES.gitignore, GITIGNORE_LINES);
  if (await gitignoreHidesPolicy(root)) {
    notes.push(
      ".gitignore also ignores the whole .axiom/ directory (`.axiom/` or `/.axiom`): git cannot re-include files under an ignored directory, so .axiom/profiles/ and .axiom/gate-profile.json stay untracked — remove that line (`.axiom/*` keeps the state ignored)",
    );
  }
  if (!(await exists(root, ".git")))
    notes.push("no .git here: root discovery in the gate uses cwd");
  if (daemon) {
    notes.push(
      `daemon: start it with \`axiom serve --hook --root ${path.dirname(root)}\`; axiom-hook falls back to an in-process \`axiom gate\` when the daemon is down`,
    );
    if (has("claude")) {
      notes.push(
        "daemon: the Claude http hook has onFailure: block — every Claude write is denied while the daemon is down",
      );
    }
  } else {
    notes.push("hooks call the global bin: npm install -g @codai/axiom-mcp (never npx in a hook)");
  }
  return { root, harnesses, profile, files: w.files, notes };
}

// ------------------------------------------------------------- upgrade (S-1204) --

/** `axiom gate` / `axiom.cmd gate` (pre-tool only) → the daemon thin client. */
export function toDaemonCommand(cmd: string): string {
  if (!GATE_COMMAND_RE.test(cmd) || isPostGateCommand(cmd)) return cmd;
  return cmd
    .replace(/(^|[\s"'&(])axiom\.cmd(?=\s+gate\b)/g, "$1axiom-hook.exe")
    .replace(/(^|[\s"'&(])axiom(?=\s+gate\b)/g, "$1axiom-hook");
}

const AXIOM_PKG_RE = /^@codai\/axiom-mcp(?:@[^\s]*)?$/;

/** `npx -y @codai/axiom-mcp@2 mcp --root X` args → `["mcp", "--root", X]`; undefined = not ours. */
export function npxMcpArgs(command: unknown, args: unknown): string[] | undefined {
  if (command !== "npx" || !Array.isArray(args)) return undefined;
  if (!args.every((a): a is string => typeof a === "string")) return undefined;
  const i = args.findIndex((a) => AXIOM_PKG_RE.test(a));
  if (i < 0) return undefined;
  const rest = args.slice(i + 1);
  return rest[0] === "mcp" ? rest : undefined;
}

function upgradeMcpEntry(
  doc: Record<string, unknown>,
  key: "servers" | "mcpServers",
  binPresent: boolean,
  skipped: { npx: boolean },
): string[] {
  const servers = doc[key];
  if (!isRecord(servers)) return [];
  const entry = servers.axiom;
  if (!isRecord(entry)) return [];
  const rest = npxMcpArgs(entry.command, entry.args);
  if (rest === undefined) return [];
  if (!binPresent) {
    skipped.npx = true;
    return [];
  }
  entry.command = "axiom";
  entry.args = rest;
  return [`${key}.axiom: npx → global axiom bin`];
}

/** `[mcp_servers.axiom]` in TOML: `command = "npx"` + `args = [... @codai/axiom-mcp ...]` → global bin. */
export function upgradeCodexToml(text: string): { text: string; reasons: string[] } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.axiom\]\s*$/.test(l));
  if (start < 0) return { text, reasons: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const cmdAt = lines.findIndex(
    (l, i) => i > start && i < end && /^\s*command\s*=\s*"npx"\s*$/.test(l),
  );
  const argsAt = lines.findIndex(
    (l, i) => i > start && i < end && /^\s*args\s*=\s*\[.*\]\s*$/.test(l),
  );
  if (cmdAt < 0 || argsAt < 0) return { text, reasons: [] };
  const strs = [...(lines[argsAt] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
  const rest = npxMcpArgs("npx", strs);
  if (rest === undefined) return { text, reasons: [] };
  lines[cmdAt] = 'command = "axiom"';
  lines[argsAt] = `args = [${rest.map((a) => JSON.stringify(a)).join(", ")}]`;
  return { text: lines.join(eol), reasons: ["[mcp_servers.axiom]: npx → global axiom bin"] };
}

/** Rewrite every pre-tool gate command of a flat/Copilot entry (`command`, `bash`, `powershell`). */
function daemonizeFields(entry: Record<string, unknown>, fields: readonly string[]): boolean {
  let changed = false;
  for (const f of fields) {
    const v = entry[f];
    if (typeof v !== "string") continue;
    const next = toDaemonCommand(v);
    if (next !== v) {
      entry[f] = next;
      changed = true;
    }
  }
  return changed;
}

function hookArray(doc: Record<string, unknown>, event: string): unknown[] {
  const hooks = doc.hooks;
  if (!isRecord(hooks)) return [];
  const list = hooks[event];
  return Array.isArray(list) ? list : [];
}

/** Nested entries (`{matcher, hooks:[{command…}]}`): switch the gate commands to axiom-hook. */
function daemonizeNested(doc: Record<string, unknown>, event: string): boolean {
  let changed = false;
  for (const e of hookArray(doc, event)) {
    if (!isPreGateEntry(e) || !isRecord(e) || !Array.isArray(e.hooks)) continue;
    for (const h of e.hooks) {
      if (isRecord(h) && daemonizeFields(h, ["command", "commandWindows", "command_windows"])) {
        changed = true;
      }
    }
  }
  return changed;
}

/** Claude: a command-hook gate entry → the daemon HTTP hook entry (same position). */
function daemonizeClaude(doc: Record<string, unknown>): boolean {
  const list = hookArray(doc, "PreToolUse");
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isPreGateEntry(e) || !isRecord(e) || !Array.isArray(e.hooks)) continue;
    const hasCommand = e.hooks.some((h) => isRecord(h) && typeof h.command === "string");
    if (!hasCommand) continue;
    list[i] = CLAUDE_HTTP_HOOK_ENTRY;
    changed = true;
  }
  return changed;
}

function hasPreGate(doc: Record<string, unknown>, event: string): boolean {
  return hookArray(doc, event).some(isPreGateEntry);
}

/** Push `entry` to `doc.hooks[event]` when no entry there is `mine`; true when added. */
function addIfMissing(
  doc: Record<string, unknown>,
  event: string,
  entry: unknown,
  mine: (v: unknown) => boolean,
): boolean {
  return mergeHookList(doc, event, entry, mine, false) === "added";
}

interface UpgradeContext {
  binPresent: boolean;
  steerOk: boolean;
  postOk: boolean;
  daemonUp: boolean;
  skipped: { npx: boolean };
}

function upgradeCopilotDoc(doc: Record<string, unknown>, ctx: UpgradeContext): string[] {
  const reasons: string[] = [];
  if (ctx.daemonUp) {
    let changed = false;
    for (const e of hookArray(doc, "preToolUse")) {
      if (isRecord(e) && !isCopilotPostEntry(e)) {
        if (daemonizeFields(e, ["command", "bash", "powershell"])) changed = true;
      }
    }
    if (changed) reasons.push("preToolUse: axiom → axiom-hook (daemon running)");
  }
  const pre = hookArray(doc, "preToolUse").some(
    (e) =>
      isRecord(e) &&
      [e.command, e.bash, e.powershell].some(
        (c) => typeof c === "string" && GATE_COMMAND_RE.test(c),
      ),
  );
  if (
    ctx.postOk &&
    pre &&
    addIfMissing(doc, "postToolUse", COPILOT_POST_ENTRY, isCopilotPostEntry)
  ) {
    reasons.push("added postToolUse post-write check");
  }
  return reasons;
}

function upgradeNestedDoc(
  doc: Record<string, unknown>,
  ctx: UpgradeContext,
  opts: { pre: string; post?: { event: string; entry: unknown }; claude?: boolean },
): string[] {
  const reasons: string[] = [];
  if (ctx.daemonUp) {
    const changed = opts.claude === true ? daemonizeClaude(doc) : daemonizeNested(doc, opts.pre);
    if (changed) {
      reasons.push(
        opts.claude === true
          ? `${opts.pre}: gate command → daemon http hook`
          : `${opts.pre}: axiom → axiom-hook (daemon running)`,
      );
    }
  }
  if (
    opts.post !== undefined &&
    ctx.postOk &&
    hasPreGate(doc, opts.pre) &&
    addIfMissing(doc, opts.post.event, opts.post.entry, isAxiomPostEntry)
  ) {
    reasons.push(`added ${opts.post.event} post-write check`);
  }
  return reasons;
}

function upgradeFlatDoc(
  doc: Record<string, unknown>,
  ctx: UpgradeContext,
  events: readonly string[],
): string[] {
  if (!ctx.daemonUp) return [];
  let changed = false;
  for (const ev of events) {
    for (const e of hookArray(doc, ev)) {
      if (isFlatGateEntry(e) && isRecord(e) && daemonizeFields(e, ["command", "powershell"])) {
        changed = true;
      }
    }
  }
  return changed ? [`${events.join(", ")}: axiom → axiom-hook (daemon running)`] : [];
}

function upgradeGateProfile(doc: Record<string, unknown>, ctx: UpgradeContext): string[] {
  if (!ctx.steerOk) return [];
  const reasons: string[] = [];
  if (doc.record === undefined) {
    doc.record = true;
    reasons.push("record: true");
  }
  if (doc.steer === undefined) {
    doc.steer = "hint";
    reasons.push('steer: "hint"');
  }
  return reasons;
}

async function runUpgrade(
  opts: InitOptions,
  root: string,
  harnesses: HarnessName[],
  profile: string,
): Promise<InitResult> {
  const bin = await (opts.locateBin ?? defaultBinLocator())();
  const daemonUp = await (opts.daemonRunning ?? defaultDaemonRunning())();
  const ctx: UpgradeContext = {
    binPresent: bin !== undefined,
    steerOk: binAtLeast(bin, STEER_MIN_VERSION),
    postOk: binAtLeast(bin, POST_MIN_VERSION),
    daemonUp,
    skipped: { npx: false },
  };
  const w = new Writer(root, false);
  const notes: string[] = [];

  await w.upgradeJson(INIT_FILES.mcp, (doc) =>
    upgradeMcpEntry(doc, "servers", ctx.binPresent, ctx.skipped),
  );
  const copilotAbs = path.join(root, INIT_FILES.copilotHook);
  if (await isLegacyExecHook(copilotAbs)) {
    const doc = copilotHook(daemonUp ? "axiom-hook" : "axiom");
    if (!ctx.postOk) delete (doc.hooks as Record<string, unknown>).postToolUse;
    await w.replaceOwned(
      INIT_FILES.copilotHook,
      json(doc),
      "migrated exec-only hook (VS Code ignored it)",
    );
  } else {
    await w.upgradeJson(INIT_FILES.copilotHook, (doc) => upgradeCopilotDoc(doc, ctx));
  }
  await w.upgradeJson(INIT_FILES.claudeSettings, (doc) =>
    upgradeNestedDoc(doc, ctx, {
      pre: "PreToolUse",
      post: { event: "PostToolUse", entry: CLAUDE_POST_HOOK_ENTRY },
      claude: true,
    }),
  );
  await w.upgradeJson(INIT_FILES.codexHooks, (doc) =>
    upgradeNestedDoc(doc, ctx, {
      pre: "PreToolUse",
      post: { event: "PostToolUse", entry: codexPostHookEntry() },
    }),
  );
  if (ctx.binPresent) {
    await w.upgradeText(INIT_FILES.codexConfig, upgradeCodexToml);
  } else if (
    (await readOrUndefined(path.join(root, INIT_FILES.codexConfig)))?.includes("axiom-mcp")
  ) {
    ctx.skipped.npx = true;
  }
  await w.upgradeJson(INIT_FILES.cursorHooks, (doc) =>
    upgradeFlatDoc(doc, ctx, ["preToolUse", "beforeShellExecution"]),
  );
  await w.upgradeJson(INIT_FILES.cursorMcp, (doc) =>
    upgradeMcpEntry(doc, "mcpServers", ctx.binPresent, ctx.skipped),
  );
  for (const rel of [INIT_FILES.devinHooks, INIT_FILES.windsurfHooks]) {
    await w.upgradeJson(rel, (doc) =>
      upgradeFlatDoc(doc, ctx, ["pre_write_code", "pre_run_command"]),
    );
  }
  await w.upgradeJson(INIT_FILES.geminiSettings, (doc) => [
    ...upgradeNestedDoc(doc, ctx, { pre: "BeforeTool" }),
    ...upgradeMcpEntry(doc, "mcpServers", ctx.binPresent, ctx.skipped),
  ]);
  await w.upgradeJson(INIT_FILES.junieMcp, (doc) =>
    upgradeMcpEntry(doc, "mcpServers", ctx.binPresent, ctx.skipped),
  );
  if (daemonUp) {
    const swap = (from: string, to: string) => (text: string) =>
      text === from
        ? { text: to, reasons: ["axiom → axiom-hook (daemon running)"] }
        : { text, reasons: [] };
    await w.upgradeText(
      INIT_FILES.clineHook,
      swap(clineHookSh("axiom"), clineHookSh("axiom-hook")),
    );
    await w.upgradeText(
      INIT_FILES.clineHookPs1,
      swap(clineHookPs1("axiom"), clineHookPs1("axiom-hook")),
    );
  }
  await w.upgradeJson(INIT_FILES.gateProfile, (doc) => upgradeGateProfile(doc, ctx));

  if (bin === undefined) {
    notes.push(
      "upgrade: global axiom not on PATH — gate profile keys, PostToolUse wiring and npx → bin MCP entries were left alone (npm install -g @codai/axiom-mcp)",
    );
  } else {
    if (!ctx.steerOk) {
      notes.push(
        `upgrade: global axiom ${bin.version ?? "(version unknown)"} < ${STEER_MIN_VERSION} — gate profile keys left alone (an older gate rejects them)`,
      );
    }
    if (!ctx.postOk) {
      notes.push(
        `upgrade: global axiom ${bin.version ?? "(version unknown)"} < ${POST_MIN_VERSION} — PostToolUse wiring not added (an older gate rejects --post)`,
      );
    }
  }
  if (ctx.skipped.npx) {
    notes.push("upgrade: MCP entries kept on npx (no global axiom bin to switch to)");
  }
  if (!daemonUp) {
    notes.push("upgrade: no resident daemon answering — hook commands keep the axiom bin");
  }
  return { root, harnesses, profile, files: w.files, notes };
}

// ------------------------------------------------------------- managed (S-1207) --

/** Files `--managed` writes under `--out`, relative POSIX paths. */
export const MANAGED_FILES = {
  claude: "claude-code/managed-settings.json",
  codex: "codex/requirements.toml",
  cursor: "cursor/hooks.json",
  copilot: "github-copilot/policy.d/axiom-gate.json",
  vscode: "vscode/POLICY.md",
} as const;

/**
 * Claude Code managed settings: the gate hooks with `onFailure: "block"`, and
 * `allowManagedHooksOnly` so user/project hooks cannot shadow or replace them. `disableAllHooks`
 * is deliberately absent (it would switch the gate off too).
 */
export function claudeManagedSettings(): Record<string, unknown> {
  return {
    allowManagedHooksOnly: true,
    hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY], PostToolUse: [CLAUDE_POST_HOOK_ENTRY] },
  };
}

/** Codex `requirements.toml`: pinned hooks feature, managed-only hooks, the gate, no `never` approvals. */
export function codexRequirementsToml(): string {
  const tomlStr = (s: string) => `'${s}'`;
  const hook = (event: string, command: string, windows: string, status: string) => [
    "",
    `[[hooks.${event}]]`,
    `matcher = ${JSON.stringify(CODEX_MATCHER)}`,
    "",
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    `command_windows = ${tomlStr(windows)}`,
    "timeout = 10",
    `statusMessage = ${JSON.stringify(status)}`,
  ];
  return [
    "# AXIOM managed Codex requirements (axiom init --managed).",
    "# Install: /etc/codex/requirements.toml (Linux, macOS) or %ProgramData%\\OpenAI\\Codex\\requirements.toml (Windows).",
    "# The hooks call the global `axiom` bin on PATH (npm install -g @codai/axiom-mcp).",
    'allowed_approval_policies = ["untrusted", "on-request"]',
    "allow_managed_hooks_only = true",
    "",
    "[features]",
    "hooks = true",
    "",
    "[hooks]",
    "# Directory your endpoint tooling installs hook scripts into (Codex requires one); AXIOM itself needs none.",
    'managed_dir = "/etc/codex/hooks"',
    "windows_managed_dir = 'C:\\ProgramData\\OpenAI\\Codex\\hooks'",
    ...hook(
      "PreToolUse",
      gateCommand("axiom", "codex"),
      gateCommandPowerShell("axiom", "codex"),
      "AXIOM gate",
    ),
    ...hook(
      "PostToolUse",
      gatePostCommand("codex"),
      gatePostCommandPowerShell("codex"),
      "AXIOM post-write check",
    ),
    "",
  ].join("\n");
}

export const VSCODE_POLICY_MD = [
  "# AXIOM — VS Code organisation policy (axiom init --managed)",
  "",
  "VS Code reads these through its enterprise policy channel (Group Policy / ADMX on Windows,",
  "configuration profiles on macOS, JSON policy on Linux) — see",
  "https://code.visualstudio.com/docs/enterprise/manage-ai-settings.",
  "",
  "| Policy | Value | Why |",
  "|---|---|---|",
  "| `ChatHooks` (`chat.useHooks`) | `true` | agent hooks must stay on — the AXIOM gate is a PreToolUse hook |",
  "| `ChatToolsAutoApprove` (`chat.tools.global.autoApprove`) | `false` | no global auto-approval of tool calls |",
  "| `ChatToolsTerminalEnableAutoApprove` | `false` | terminal commands keep their confirmation |",
  "| `ChatAllowManagedHooksOnly` | `true` only together with a managed AXIOM hook | otherwise it also disables the repo's `.github/hooks/axiom-gate.json` |",
  "",
  "VS Code Local hooks have no fail-closed switch: a timeout, a crash or an exit code other than",
  "0/2 is a non-blocking warning. Keep the gate fast (`axiom init --daemon`) and run `axiom doctor`.",
  "",
  "`github-copilot/policy.d/axiom-gate.json` (written next to this file) is the same hook document",
  "for Copilot policy hooks: `/etc/github-copilot/policy.d/` (POSIX, root-owned, not group/world",
  "writable) or `C:\\ProgramData\\GitHub\\Copilot\\policy.d\\` (Windows). Copilot applies policy",
  "hooks to the CLI / SDK harness, not to VS Code Local sessions; timeouts still fail open.",
  "",
].join("\n");

async function runManaged(opts: InitOptions, out: string): Promise<InitResult> {
  const abs = path.resolve(out);
  await mkdir(abs, { recursive: true });
  const root = await realDir(abs, "ERR_ROOT_NOT_DIR");
  const w = new Writer(root, opts.force === true);
  const copilot = copilotHook("axiom");
  await w.owned(MANAGED_FILES.claude, json(claudeManagedSettings()));
  await w.owned(MANAGED_FILES.codex, codexRequirementsToml());
  await w.owned(MANAGED_FILES.cursor, json(cursorHooks("axiom")));
  await w.owned(MANAGED_FILES.copilot, json(copilot));
  await w.owned(MANAGED_FILES.vscode, VSCODE_POLICY_MD);
  const notes = [
    `claude: install ${MANAGED_FILES.claude} as managed-settings.json in /Library/Application Support/ClaudeCode/ (macOS), /etc/claude-code/ (Linux/WSL) or C:\\Program Files\\ClaudeCode\\ (Windows — C:\\ProgramData\\ClaudeCode is no longer read)`,
    `codex: install ${MANAGED_FILES.codex} as /etc/codex/requirements.toml (Linux/macOS) or %ProgramData%\\OpenAI\\Codex\\requirements.toml (Windows)`,
    `cursor: install ${MANAGED_FILES.cursor} as /Library/Application Support/Cursor/hooks.json (macOS), /etc/cursor/hooks.json (Linux/WSL) or C:\\ProgramData\\Cursor\\hooks.json (Windows)`,
    `copilot: install ${MANAGED_FILES.copilot} into /etc/github-copilot/policy.d/ (POSIX, root-owned) or C:\\ProgramData\\GitHub\\Copilot\\policy.d\\ (Windows)`,
    `vscode: ${MANAGED_FILES.vscode} lists the organisation policies to set (ChatHooks, ChatToolsAutoApprove, …)`,
    "every managed hook calls the global bin: npm install -g @codai/axiom-mcp on each machine",
  ];
  return {
    root,
    harnesses: ["claude", "codex", "cursor", "copilot", "vscode"],
    profile: "",
    files: w.files,
    notes,
  };
}
