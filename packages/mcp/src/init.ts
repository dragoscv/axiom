/**
 * `axiom init` (S-701): wire a repository for AXIOM in one idempotent step — MCP server entry,
 * PreToolUse hook(s) for the detected harness(es), a repo profile extending `default`, a gate
 * profile and the `.gitignore` lines that keep `.axiom/` state out of git while committing the
 * two policy files. Every write goes through `resolveContained` (no symlink/junction segment, no
 * escape) + `writeAtomic`; an existing file is never overwritten without `force`.
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { resolveContained, writeAtomic } from "@codai/axiom-apply";
import { AxiomError, ProfileNameSchema } from "@codai/axiom-schema";
import { CLAUDE_HOOK_PATH, DAEMON_DEFAULT_HOST, DAEMON_DEFAULT_PORT } from "./daemon-proto.js";
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

/** A hook command that runs the gate through the global bin or the native thin client. */
export const GATE_COMMAND_RE = /\baxiom(?:-hook)?\b.*\bgate\b/;

/** Global bin, never `npx` — `npx` resolution alone exceeds every harness hook timeout (hooks.md). */
export const COPILOT_HOOK = {
  version: 1,
  hooks: {
    preToolUse: [{ type: "command", exec: "axiom", args: ["gate", "--stdin"], timeoutSec: 5 }],
  },
};

/** `--daemon`: same document, the native thin client (falls back to in-process `axiom gate`). */
export const COPILOT_HOOK_DAEMON = {
  version: 1,
  hooks: {
    preToolUse: [{ type: "command", exec: "axiom-hook", args: ["gate", "--stdin"], timeoutSec: 5 }],
  },
};

export const CLAUDE_HOOK_ENTRY = {
  matcher: "Write|Edit|MultiEdit|NotebookEdit",
  hooks: [{ type: "command", command: "axiom gate --stdin", timeout: 5 }],
};

/** `--daemon`: Claude posts the payload to the resident daemon; `onFailure: block` = fail-closed. */
export const CLAUDE_HTTP_HOOK_ENTRY = {
  matcher: "Write|Edit|MultiEdit|NotebookEdit",
  hooks: [
    {
      type: "http",
      url: `http://${DAEMON_DEFAULT_HOST}:${DAEMON_DEFAULT_PORT}${CLAUDE_HOOK_PATH}`,
      timeout: 5,
      onFailure: "block",
    },
  ],
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

export type GateBin = "axiom" | "axiom-hook";

export function gateCommand(bin: GateBin, format: string): string {
  return `${bin} gate --stdin --format ${format}`;
}

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
  return {
    hooks: {
      pre_write_code: [{ command, powershell: command }],
      pre_run_command: [{ command, powershell: command }],
    },
  };
}

export function codexHookEntry(bin: GateBin = "axiom"): Record<string, unknown> {
  const command = gateCommand(bin, "codex");
  return {
    matcher: "^(Bash|apply_patch|Edit|Write)$",
    hooks: [
      {
        type: "command",
        command,
        commandWindows: command,
        timeout: 10,
        statusMessage: "AXIOM gate",
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
};

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

/** Claude-style hook hit `{hooks:[…]}`: a gate command (`axiom` / `axiom-hook`) or the daemon http hook. */
export function isAxiomGateHook(h: unknown): boolean {
  if (!isRecord(h)) return false;
  if (typeof h.command === "string" && GATE_COMMAND_RE.test(h.command)) return true;
  return h.type === "http" && typeof h.url === "string" && h.url.endsWith(CLAUDE_HOOK_PATH);
}

export function isAxiomGateEntry(v: unknown): boolean {
  return isRecord(v) && Array.isArray(v.hooks) && v.hooks.some(isAxiomGateHook);
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

function claudeEditor(entry: unknown): Editor {
  return (doc, force) => mergeHookList(doc, "PreToolUse", entry, isAxiomGateEntry, force);
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
  await w.mergeJson(
    INIT_FILES.codexHooks,
    () => ({ hooks: { PreToolUse: [entry] } }),
    (doc, force) => mergeHookList(doc, "PreToolUse", entry, isAxiomGateEntry, force),
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

export async function runInit(opts: InitOptions): Promise<InitResult> {
  // realpath first: resolveContained compares against realpaths (CI: /var → /private/var, RUNNER~1).
  const root = await realDir(path.resolve(opts.root), "ERR_ROOT_NOT_DIR");
  const harnesses = await detectHarnesses(root, opts.harness ?? "auto");
  const profile = opts.profileName ?? profileNameFor(root);
  if (!ProfileNameSchema.safeParse(profile).success || BUILTIN_PROFILE_NAMES.has(profile)) {
    throw new AxiomError(
      "ERR_INVALID_PROFILE",
      `profile name must match ^[a-z0-9][a-z0-9._-]{0,63}$ and not be a builtin: ${profile}`,
      { details: { profile } },
    );
  }
  const w = new Writer(root, opts.force === true);
  const notes: string[] = [];
  const daemon = opts.daemon === true;
  const wire: HarnessWiring = { bin: daemon ? "axiom-hook" : "axiom", daemon };
  const has = (h: HarnessName) => harnesses.includes(h);

  await w.mergeJson(INIT_FILES.mcp, () => ({ servers: { axiom: MCP_SERVER_ENTRY } }), mergeMcp);
  if (has("copilot") || has("vscode")) {
    await w.owned(INIT_FILES.copilotHook, json(daemon ? COPILOT_HOOK_DAEMON : COPILOT_HOOK));
  }
  if (has("claude")) {
    const entry = daemon ? CLAUDE_HTTP_HOOK_ENTRY : CLAUDE_HOOK_ENTRY;
    await w.mergeJson(
      INIT_FILES.claudeSettings,
      () => ({ hooks: { PreToolUse: [entry] } }),
      claudeEditor(entry),
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
