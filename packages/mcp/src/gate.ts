/**
 * `axiom gate --stdin` — PreToolUse hook mode (v2-architecture §5.6, S-203).
 *
 * Reads ONE harness payload from stdin, extracts the write target(s) of the tool call and
 * runs only the fast path/content predicates from `@codai/axiom-checks` against a small
 * gate profile. No repo index, no guards, no git — budget < 120 ms in-process.
 *
 * Contract (verified against Claude Code + Copilot CLI docs, see docs/getting-started/hooks.md) — Gate v2 (S-404, D-18):
 *   allow → exit 0, nothing on stdout.
 *   deny  → exit 0 (D-35; `--deny-exit 2` for harnesses that only read the exit code), one
 *           stderr line `AXIOM GATE DENY <code>: <reason> (<relpath>)` and ONE JSON
 *           object on stdout carrying both the Claude `hookSpecificOutput` shape and the flat
 *           Copilot `{permissionDecision, permissionDecisionReason}` shape, plus an OWASP Agent
 *           Control Standard `verdict` (`allow|deny|modify|ask|defer`; the gate only emits
 *           `allow`/`deny`).
 *           Why exit 0: the npm `axiom.ps1` shim rewrites every non-zero exit to 1, and VS Code
 *           treats exit 1 as a non-blocking warning — 129 of 134 production denies (codai,
 *           2026-10-07..14) let the tool run. Every harness that has a JSON contract honours
 *           the JSON deny on exit 0.
 *   FAIL-CLOSED by default: an internal error, malformed payload, stdin timeout, or a
 *           write-class tool whose target cannot be determined → deny with a reason.
 *           `--fail-open` restores the 2.1 behaviour (exit 0 + stderr warn) for those cases.
 *   Shell tools (`Bash`, `run_in_terminal`, …) are scanned for write primitives
 *           (`>`, `>>`, `tee`, `rm`, `mv`, `cp`, `sed -i`, `git checkout|reset|clean`, …); a
 *           protected path among their operands → deny (an `ask`-glob operand → ask; deny
 *           wins). Heuristic, documented as such.
 *   Root: payload `cwd` → walk up to the nearest ancestor holding `.axiom/` or `.git/`
 *           (so a sub-directory cwd still sees `.git/**` in the profile) → `--root` → cwd.
 *           A target outside the root but inside another worktree of the SAME repository
 *           (same git common dir) is judged against that worktree's root and profile (D-35).
 *
 * This module never writes to stdout/stderr itself: it returns a `GateResult` and the CLI
 * entries (`cli.ts`, `cli-main.ts`) do the writing (`check-no-stdout`).
 */
import { realpath as realpathCb } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs, promisify } from "node:util";
import { resolveContained } from "@codai/axiom-apply";
import { sha256Hex } from "@codai/axiom-canon";
import {
  contentMaxBytes,
  contentNoSecrets,
  type FactContext,
  globMatcher,
  pathAllow,
  pathDeny,
} from "@codai/axiom-checks";
import { type ErrorCode, isAxiomError, relPathIssues } from "@codai/axiom-schema";
import { z } from "zod";
import { CommandsConfigSchema, evaluateCommandRules } from "./command-rules.js";
import { CoordinationSchema, evaluateCoordination } from "./coord.js";
import { appendDecision, hashArgs, principalSubject } from "./decisions.js";
import {
  allowStdout,
  classifyTool,
  formatFromArgv,
  GATE_FORMATS,
  GATE_STDIN_MAX_BYTES,
  GATE_STDIN_TIMEOUT_MS,
  type GateFormat,
  isGateFormat,
  isShellTool,
  isWriteTool,
  readStdin,
  type StdinRead,
  TOOL_NAME_KEYS,
  type ToolClass,
} from "./gate-fast.js";
import type { RuleVerdict } from "./gate-verdict.js";
import { evaluateGit, type GitRules, GitRulesSchema } from "./gitfacts.js";
import { postMain } from "./post-write.js";
import { loadAxiomConfig } from "./profile-v3.js";
import {
  checkSessionWrite,
  checkStaleScript,
  recordDeniedCreate,
  recordSessionRead,
  recordSessionWrite,
  SessionsConfigSchema,
  type SessionTarget,
} from "./session-guard.js";
import {
  expandNested,
  findTrailingOverride,
  normalizeGit,
  programName,
  shellWords,
  splitSegments,
  stripTrailingOverride,
} from "./shell-lex.js";
import { captureOutsideUndo, captureUndo } from "./undo.js";

export {
  allowStdout,
  classifyTool,
  formatFromArgv,
  GATE_FORMATS,
  GATE_STDIN_MAX_BYTES,
  GATE_STDIN_TIMEOUT_MS,
  type GateFormat,
  isShellTool,
  isWriteTool,
  readStdin,
  type StdinRead,
  type ToolClass,
};

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
const IS_WIN32 = process.platform === "win32";

export const GATE_EXIT_ALLOW = 0;
/** Hard-deny exit: usage errors, and every deny under `--deny-exit 2`. */
export const GATE_EXIT_DENY = 2;
/** Default exit for a deny (D-35): the JSON document on stdout carries the decision. */
export const GATE_DENY_EXIT_DEFAULT = 0;

// ---------------------------------------------------------------- profile --

export const GateProfileSchema = z
  .object({
    /**
     * Profile format major (3.0, D-42). Absent = written for 2.x. A profile declaring a major
     * newer than this binary is refused (`ERR_PROFILE_VERSION`) instead of half-understood.
     */
    version: z.int().positive().optional(),
    /** picomatch globs (dot: true) — any match denies. */
    deny: z.array(z.string().min(1)).default([]),
    /**
     * picomatch globs (dot: true), same semantics as `deny`, but a match hands the decision to
     * the human (`path.ask` → `permissionDecision: "ask"` on auto/claude/copilot/vscode; a plain
     * deny on formats without an ask prompt — fail-closed). Applies to write tools and to shell
     * operands alike. Every deny wins: `deny`, `allow`, content checks (`noSecrets`, `maxBytes`),
     * `steer: "require"` and session rules are judged first.
     */
    ask: z.array(z.string().min(1)).default([]),
    /** When present, every target must match at least one glob. */
    allow: z.array(z.string().min(1)).optional(),
    /** Run `content.noSecrets` on the new content when the payload carries it. */
    noSecrets: z.boolean().default(true),
    /** Also scan for PII (`cnp`, `email`, `phoneRo`, `card`) — `content.noSecrets { pii }`. */
    pii: z.boolean().default(false),
    /**
     * Globs where the PII-class `content.noSecrets` findings (email, phone, CNP, card,
     * credentialAssignment) are ignored — test fixtures and scratch dirs (3.0, S-1313).
     * Real keys (privateKey, awsKey, tokens) are still reported everywhere.
     */
    noSecretsExclude: z.array(z.string().min(1)).optional(),
    /** Run `content.maxBytes` on the new content when the payload carries it. */
    maxBytes: z.int().positive().optional(),
    /**
     * Steer agents towards `axiom_write` (Phase 8): `hint` adds a once-per-session context hint
     * to allowed writes; `require` also denies direct writes matching `steerGlobs`.
     */
    steer: z.enum(["off", "hint", "require"]).default("off"),
    /** picomatch globs (dot: true) a direct write must not touch under `steer: "require"`. */
    steerGlobs: z.array(z.string().min(1)).default([]),
    /** Append every judged write/shell decision to `.axiom/decisions.jsonl`. */
    record: z.boolean().default(false),
    /** Command rules for shell tools (S-1208): own `deny` list + optional built-in `house` pack. */
    commands: CommandsConfigSchema.optional(),
    /** Cross-session overwrite / blind overwrite / stale-script rules (S-1209, S-1215). */
    sessions: SessionsConfigSchema.optional(),
    /** Capture the pre-image of every allowed write into CAS for `axiom undo --session` (S-1210). */
    undo: z.boolean().default(false),
    /** File-protocol coordination: marks, leases, queue-required commands (S-1212). */
    coordination: CoordinationSchema.optional(),
    /** Git-state rules read from `.git` without spawning git (S-1213). */
    git: GitRulesSchema.optional(),
    /**
     * Shadow mode (S-1216): never deny; record what the gate WOULD have decided (and the shell
     * command text) into `.axiom/decisions.jsonl` for a parity replay before a cutover.
     */
    shadow: z.boolean().default(false),
    /**
     * `warn` (2.7): a deny becomes an allow carrying the reason as a warning to the agent (and a
     * journal line with `relaxed: "warn"`). Codes in `hard` keep denying; profile `ask` globs
     * keep asking. Default `enforce`.
     */
    mode: z.enum(["enforce", "warn"]).default("enforce"),
    /** Codes that always deny, in every mode, and cannot be overridden: exact or `prefix.*`. */
    hard: z.array(z.string().min(1)).default([]),
    /**
     * Let the agent pass a non-hard deny by stating why: `axiom-override: <reason>` (≥ 8 chars)
     * in the tool's explanation / goal / description / reason / command text. Journaled as
     * `relaxed: "override"` with the reason. Default off.
     */
    override: z.boolean().default(false),
    /**
     * Targets outside the root (and outside every worktree of the same repository): `deny`
     * (ERR_CONTAINMENT, default), `warn` (allow + warning), `allow` (allow; a warning only for
     * operating-system directories).
     */
    outside: z.enum(["deny", "warn", "allow"]).default("deny"),
  })
  // Unknown keys are ignored with a warning (3.0, D-42): a newer profile read by an older bin
  // must neither deny every write nor (with --fail-open) switch the gate off.
  .strip();

/** Highest profile `version` this binary understands. */
export const GATE_PROFILE_VERSION = 3;

/** A gate profile that cannot be used: never covered by `--fail-open` (S-1307). */
export class GateProfileError extends Error {
  readonly code: "ERR_INVALID_PROFILE" | "ERR_PROFILE_VERSION";
  constructor(code: "ERR_INVALID_PROFILE" | "ERR_PROFILE_VERSION", message: string) {
    super(message);
    this.name = "GateProfileError";
    this.code = code;
  }
}

const GATE_PROFILE_KEYS: ReadonlySet<string> = new Set(Object.keys(GateProfileSchema.shape));

/** Top-level keys of a raw profile this binary does not know (reported, then ignored). */
export function unknownGateProfileKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw).filter((k) => !GATE_PROFILE_KEYS.has(k) && k !== "$schema");
}

export type GateProfile = z.infer<typeof GateProfileSchema>;
export type GateProfileInput = z.input<typeof GateProfileSchema>;

export const DEFAULT_GATE_PROFILE: GateProfile = {
  deny: [
    ".git/**",
    ".axiom/**",
    "**/*.lock",
    "pnpm-lock.yaml",
    ".env",
    ".env.*",
    "**/node_modules/**",
  ],
  ask: [],
  noSecrets: true,
  pii: false,
  // Phase 8 decision: the builtin profile hints; an explicit profile file defaults to "off".
  steer: "hint",
  steerGlobs: [],
  record: false,
  undo: false,
  shadow: false,
  mode: "enforce",
  hard: [],
  override: false,
  outside: "deny",
};

/** `--profile`, then `<root>/.axiom/gate-profile.json`, then `~/.axiom/gate-profile.json`, then default. */
export async function loadGateProfile(opts: {
  root: string;
  profilePath?: string;
  home?: string;
}): Promise<{ profile: GateProfile; source: string; unknownKeys?: string[] }> {
  const candidates: string[] = [];
  if (opts.profilePath !== undefined) candidates.push(path.resolve(opts.profilePath));
  candidates.push(path.join(opts.root, ".axiom", "gate-profile.json"));
  candidates.push(path.join(opts.home ?? homedir(), ".axiom", "gate-profile.json"));
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") {
        // An explicit --profile that does not exist is a configuration error, not a fallback.
        if (file === candidates[0] && opts.profilePath !== undefined)
          throw new GateProfileError("ERR_INVALID_PROFILE", `gate profile not found: ${file}`);
        continue;
      }
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new GateProfileError(
        "ERR_INVALID_PROFILE",
        `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it or run 'axiom init --force'`,
      );
    }
    const declared =
      raw !== null && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
    if (typeof declared === "number" && declared > GATE_PROFILE_VERSION) {
      throw new GateProfileError(
        "ERR_PROFILE_VERSION",
        `${file}: profile version ${declared} is newer than this axiom (understands ≤ ${GATE_PROFILE_VERSION}); upgrade the axiom bin`,
      );
    }
    const parsed = GateProfileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GateProfileError(
        "ERR_INVALID_PROFILE",
        `invalid gate profile ${file}: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const unknownKeys = unknownGateProfileKeys(raw);
    return {
      profile: parsed.data,
      source: file,
      ...(unknownKeys.length === 0 ? {} : { unknownKeys }),
    };
  }
  return { profile: DEFAULT_GATE_PROFILE, source: "builtin" };
}

function errno(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- payload --

export interface NormalizedPayload {
  toolName: string;
  cwd: string | undefined;
  input: Record<string, unknown>;
  /** Agent session id when the harness sends one (hint once-per-session, decision journal). */
  sessionId?: string;
  /** Harness recognised from the payload shape alone (`cursor`, `windsurf`, `cline`). */
  harness?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

const SESSION_KEYS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "trajectory_id",
  "taskId",
  "generation_id",
] as const;
const CWD_KEYS = ["cwd", "workingDirectory", "working_directory"] as const;

/** An object, or a JSON string that parses to one. */
function parseRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string") return asRecord(v);
  try {
    return asRecord(JSON.parse(v));
  } catch {
    return undefined;
  }
}

function firstArrayString(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  const f: unknown = v[0];
  return typeof f === "string" && f.length > 0 ? f : undefined;
}

function withMeta(
  p: NormalizedPayload,
  obj: Record<string, unknown>,
  harness: string | undefined,
): NormalizedPayload {
  const sessionId = firstString(obj, SESSION_KEYS);
  return {
    ...p,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(harness === undefined ? {} : { harness }),
  };
}

/** Cline: every parameter value may arrive JSON-stringified; keep the raw string otherwise. */
function clineParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      out[k] = v;
      continue;
    }
    out[k] =
      typeof parsed === "string" || (typeof parsed === "object" && parsed !== null) ? parsed : v;
  }
  return out;
}

/**
 * Payload shapes without a top-level tool name: Windsurf/Devin Cascade
 * (`{agent_action_name, tool_info}`), Cline (`{hookName, preToolUse:{toolName, parameters}}`)
 * and Cursor `beforeShellExecution` (`{command, cwd}`).
 */
function normalizeNamelessPayload(obj: Record<string, unknown>): NormalizedPayload | undefined {
  const action = obj.agent_action_name;
  if (typeof action === "string" && action.length > 0) {
    const info = asRecord(obj.tool_info) ?? {};
    const cwd = firstString(info, CWD_KEYS);
    let toolName = action;
    let input: Record<string, unknown> = info;
    if (action === "pre_write_code") toolName = "write_code";
    else if (action === "pre_read_code") toolName = "read_code";
    else if (action === "pre_run_command") {
      toolName = "run_command";
      const command = firstString(info, ["command_line", "commandLine", "command"]);
      input = command === undefined ? {} : { command };
    } else if (action === "pre_mcp_tool_use") {
      toolName = firstString(info, ["mcp_tool_name"]) ?? action;
      input = parseRecord(info.mcp_tool_arguments) ?? {};
    }
    return withMeta({ toolName, cwd, input }, obj, "windsurf");
  }
  const cline = asRecord(obj.preToolUse);
  if (cline !== undefined) {
    const toolName = firstString(cline, ["toolName", "tool_name", "tool"]);
    if (toolName === undefined) return undefined;
    const input = clineParams(asRecord(cline.parameters) ?? {});
    const cwd = firstArrayString(obj.workspaceRoots) ?? firstString(obj, CWD_KEYS);
    return withMeta({ toolName, cwd, input }, obj, "cline");
  }
  if (obj.hook_event_name === "beforeShellExecution" && typeof obj.command === "string") {
    const cwd = firstString(obj, CWD_KEYS) ?? firstArrayString(obj.workspace_roots);
    return withMeta({ toolName: "Shell", cwd, input: { command: obj.command } }, obj, "cursor");
  }
  return undefined;
}

/**
 * Accept Claude Code / Codex / Junie / Gemini CLI (`{session_id, tool_name, tool_input, cwd}`),
 * Copilot CLI camelCase (`{sessionId, toolName, toolArgs, cwd}` — `toolArgs` arrives as a JSON
 * *string*), the VS Code shape (`tool_input` object), Cursor (`workspace_roots` cwd fallback),
 * Windsurf, Cline and Cursor shell payloads. Returns undefined when no tool name is present.
 */
export function normalizePayload(raw: unknown): NormalizedPayload | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;
  // The top-level tool name wins (same keys as the fast path, so `fastAllow` stays exact).
  const toolName = firstString(obj, TOOL_NAME_KEYS);
  if (toolName === undefined) return normalizeNamelessPayload(obj);
  let input: Record<string, unknown> = {};
  for (const k of ["tool_input", "toolInput", "toolArgs", "tool_args", "args", "input"]) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      try {
        const parsed = asRecord(JSON.parse(v));
        if (parsed !== undefined) {
          input = parsed;
          break;
        }
      } catch {
        // a bare string argument (e.g. a shell command) carries no write target
      }
      continue;
    }
    const rec = asRecord(v);
    if (rec !== undefined) {
      input = rec;
      break;
    }
  }
  const cwd = firstString(obj, CWD_KEYS) ?? firstArrayString(obj.workspace_roots);
  const cursor = obj.hook_event_name === "preToolUse" || Array.isArray(obj.workspace_roots);
  return withMeta({ toolName, cwd, input }, obj, cursor ? "cursor" : undefined);
}

// ---------------------------------------------------------------- targets --

export interface GateTarget {
  /** Path as the agent supplied it (absolute or relative to cwd). */
  rawPath: string;
  /** New content when the payload carries it (full file, replacement string or `+` lines). */
  content: string | undefined;
  op: "write" | "delete";
}

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
  "file",
  "uri",
  "newPath",
  "new_path",
  "destination",
  "target",
  "dirPath",
  "dir_path",
] as const;
const CONTENT_KEYS = [
  "content",
  "new_string",
  "newString",
  "new_str",
  "newStr",
  "code",
  "newCode",
  "new_source",
  "newSource",
  "file_text",
  "fileText",
  "text",
  // Cline replace_in_file: SEARCH/REPLACE blocks — scanned as content.
  "diff",
] as const;

/** Tools that write files, matched case-insensitively by substring. */
const SHELL_COMMAND_KEYS = ["command", "cmd", "script", "commandLine", "command_line"] as const;

/** Shell command as a string; Codex sends `command` as an argv array (joined with spaces). */
function commandString(input: Record<string, unknown>): string | undefined {
  const s = firstString(input, SHELL_COMMAND_KEYS);
  if (s !== undefined) return s;
  // VS Code `create_and_run_task`: `{ task: { command, args } }`.
  const task = asRecord(input.task);
  if (task !== undefined && typeof task.command === "string") {
    const args = Array.isArray(task.args) ? task.args.filter((a) => typeof a === "string") : [];
    return [task.command, ...args].join(" ");
  }
  for (const k of SHELL_COMMAND_KEYS) {
    const v = input[k];
    if (Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string")) {
      const joined = v.join(" ");
      if (joined.trim().length > 0) return joined;
    }
  }
  return undefined;
}

// ------------------------------------------------------------ shell scan --

/**
 * Write primitives a shell command may contain. Each rule names the operand positions that
 * are *paths being written*. This is a documented heuristic (D-18), not a shell parser: it
 * catches the common agent idioms (`echo x > .env`, `rm -rf .git`, `sed -i … file`,
 * `git checkout -- file`) and is bypassable by construction; the full Plan→apply path is the
 * guarantee, the gate is the seatbelt.
 */
const REDIRECT_RE = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*("([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
const WRITE_CMDS: Record<string, { skipFlags: boolean; operands: "all" | "last" | "afterI" }> = {
  tee: { skipFlags: true, operands: "all" },
  rm: { skipFlags: true, operands: "all" },
  rmdir: { skipFlags: true, operands: "all" },
  mv: { skipFlags: true, operands: "last" },
  cp: { skipFlags: true, operands: "last" },
  touch: { skipFlags: true, operands: "all" },
  truncate: { skipFlags: true, operands: "all" },
  mkdir: { skipFlags: true, operands: "all" },
  ln: { skipFlags: true, operands: "last" },
  chmod: { skipFlags: true, operands: "all" },
  unlink: { skipFlags: true, operands: "all" },
  install: { skipFlags: true, operands: "last" },
  dd: { skipFlags: false, operands: "all" },
  sed: { skipFlags: true, operands: "afterI" },
  "remove-item": { skipFlags: true, operands: "all" },
  ri: { skipFlags: true, operands: "all" },
  rd: { skipFlags: true, operands: "all" },
  "set-content": { skipFlags: true, operands: "all" },
  sc: { skipFlags: true, operands: "all" },
  "add-content": { skipFlags: true, operands: "all" },
  ac: { skipFlags: true, operands: "all" },
  "out-file": { skipFlags: true, operands: "all" },
  "move-item": { skipFlags: true, operands: "all" },
  mi: { skipFlags: true, operands: "all" },
  "copy-item": { skipFlags: true, operands: "all" },
  ci: { skipFlags: true, operands: "all" },
  cpi: { skipFlags: true, operands: "all" },
  "new-item": { skipFlags: true, operands: "all" },
  ni: { skipFlags: true, operands: "all" },
  del: { skipFlags: true, operands: "all" },
  erase: { skipFlags: true, operands: "all" },
  move: { skipFlags: true, operands: "all" },
  copy: { skipFlags: true, operands: "all" },
};
const GIT_WRITE_SUBCMDS = new Set(["checkout", "reset", "clean", "restore", "rm", "mv", "stash"]);
/** PowerShell aliases that map to a delete. */
const DELETE_CMDS = new Set(["rm", "rmdir", "unlink", "del", "erase", "remove-item", "ri", "rd"]);

function looksLikePath(word: string): boolean {
  if (word === "" || word === "-" || word === "--") return false;
  if (word.startsWith("-") && !word.startsWith("./") && !word.startsWith("../")) return false;
  if (/^\$\(|^`|^\$[A-Za-z_{]/.test(word)) return false; // substitutions: unknown target
  return true;
}

/**
 * Paths a shell command would write/delete, as written. Empty when the command has no
 * recognised write primitive. Substitutions (`$(…)`, `$VAR`) are opaque and not returned.
 */
export function extractShellWriteTargets(command: string): GateTarget[] {
  const out: GateTarget[] = [];
  const seen = new Set<string>();
  const push = (rawPath: string, op: "write" | "delete") => {
    if (!looksLikePath(rawPath) || seen.has(rawPath)) return;
    seen.add(rawPath);
    out.push({ rawPath, op, content: undefined });
  };
  // Every segment (split on ; & | && || and newlines, heredoc bodies dropped) plus the
  // commands nested in `cmd /c`, `bash -c`, `pwsh -Command`, `-EncodedCommand`, `iex '…'`.
  const segments = splitSegments(stripTrailingOverride(command)).flatMap((s) => expandNested(s));
  for (const seg of segments) {
    for (let m = REDIRECT_RE.exec(seg); m !== null; m = REDIRECT_RE.exec(seg)) {
      const target = m[2] ?? m[3] ?? m[4] ?? "";
      if (target !== "" && !/^&\d$/.test(target) && !/^\/dev\//.test(target)) push(target, "write");
    }
    REDIRECT_RE.lastIndex = 0;
    const words = shellWords(seg);
    // skip env assignments and sudo/exec prefixes
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
    while (
      i < words.length &&
      ["sudo", "exec", "command", "nohup", "time"].includes(words[i] ?? "")
    )
      i++;
    const cmd = programName(words.slice(i));
    const rest = words.slice(i + 1);
    if (cmd === "git") {
      // Global options (`-C <dir>`, `-c k=v`, `--git-dir=…`) come before the subcommand.
      const g = normalizeGit(words.slice(i));
      const sub = g?.sub;
      if (sub !== undefined && GIT_WRITE_SUBCMDS.has(sub)) {
        const afterSub = g?.args ?? [];
        const dd = afterSub.indexOf("--");
        const operands =
          dd === -1 ? afterSub.filter((w) => !w.startsWith("-")) : afterSub.slice(dd + 1);
        if (sub === "clean" || (sub === "reset" && afterSub.includes("--hard"))) {
          push(".", "delete");
          continue;
        }
        for (const p of operands) push(p, sub === "rm" ? "delete" : "write");
      }
      continue;
    }
    if (cmd === "find") {
      if (rest.includes("-delete")) {
        const start = rest.find((w) => !w.startsWith("-"));
        push(start ?? ".", "delete");
      }
      continue;
    }
    const rule = WRITE_CMDS[cmd];
    if (rule === undefined) continue;
    if (cmd === "sed") {
      if (
        !rest.some(
          (w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place" || w.startsWith("--in-place="),
        )
      )
        continue;
      const hasScriptFlag = rest.some(
        (w) => /^-[a-zA-Z]*[ef]/.test(w) || /^--(expression|file)/.test(w),
      );
      const nonFlags: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          // `-e SCRIPT` / `-f FILE` take a value
          if (/^-[a-zA-Z]*[ef]$/.test(w) || w === "--expression" || w === "--file") k++;
          continue;
        }
        nonFlags.push(w);
      }
      // Without -e/-f the first operand is the script; everything after it is a file.
      const files = hasScriptFlag ? nonFlags : nonFlags.slice(1);
      for (const w of files) push(w, "write");
      continue;
    }
    if (cmd === "dd") {
      for (const w of rest) if (w.startsWith("of=")) push(w.slice(3), "write");
      continue;
    }
    let operands: string[];
    if (cmd.includes("-") || /^(ri|rd|sc|ac|mi|ci|cpi|ni)$/.test(cmd)) {
      // PowerShell cmdlet: named parameters. Path-bearing ones name the target; every other
      // `-Name value` pair is skipped so `-Value "x"` is not mistaken for a file.
      operands = [];
      const PATH_PARAMS = ["path", "literalpath", "filepath", "destination", "newname", "target"];
      const VALUE_PARAMS = new Set([
        ...PATH_PARAMS,
        "value",
        "encoding",
        "filter",
        "include",
        "exclude",
        "itemtype",
        "name",
      ]);
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          // `-Path:value` binds the value in the same token.
          const colon = w.indexOf(":");
          if (colon > 1) {
            const pname = w.slice(1, colon).toLowerCase();
            if (PATH_PARAMS.includes(pname)) operands.push(w.slice(colon + 1));
            continue;
          }
          const name = w.slice(1).toLowerCase();
          const val = rest[k + 1];
          if (PATH_PARAMS.includes(name) && val !== undefined) operands.push(val);
          // Only parameters known to take a value consume the next token; `-Recurse`,
          // `-Force`, `-WhatIf` are switches and the token after them is positional.
          if (VALUE_PARAMS.has(name) && val !== undefined && !val.startsWith("-")) k++;
          continue;
        }
        operands.push(w);
      }
    } else {
      operands = rule.skipFlags ? rest.filter((w) => !w.startsWith("-") || w === "-") : rest;
    }
    const op: "write" | "delete" = DELETE_CMDS.has(cmd) ? "delete" : "write";
    if (rule.operands === "last") {
      const last = operands[operands.length - 1];
      if (last !== undefined) push(last, op);
    } else {
      for (const w of operands) push(w, op);
    }
  }
  return out;
}

const PATCH_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+?)\s*$/;

/** `apply_patch` V4A format: `*** Update|Add|Delete File: <path>` headers, `+` lines are new content. */
export function parseApplyPatch(patch: string): GateTarget[] {
  const out: GateTarget[] = [];
  let cur: { rawPath: string; op: "write" | "delete"; lines: string[] } | undefined;
  const flush = () => {
    if (cur === undefined) return;
    out.push({
      rawPath: cur.rawPath,
      op: cur.op,
      content: cur.op === "delete" ? undefined : cur.lines.join("\n"),
    });
    cur = undefined;
  };
  for (const line of patch.split(/\r?\n/)) {
    const h = PATCH_HEADER.exec(line);
    if (h !== null) {
      flush();
      cur = {
        rawPath: h[2] ?? "",
        op: h[1] === "Delete" ? "delete" : "write",
        lines: [],
      };
      continue;
    }
    const mv = PATCH_MOVE.exec(line);
    if (mv !== null) {
      // The destination is a second write target of the same hunk.
      out.push({ rawPath: mv[1] ?? "", op: "write", content: undefined });
      continue;
    }
    if (cur !== undefined && line.startsWith("+")) cur.lines.push(line.slice(1));
  }
  flush();
  return out.filter((t) => t.rawPath.length > 0);
}

function joinContent(parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => typeof p === "string");
  return present.length === 0 ? undefined : present.join("\n");
}

export interface Extracted {
  cls: ToolClass;
  targets: GateTarget[];
  /**
   * Write-class tool whose target could not be determined (unknown path key, V4A body
   * missing, …). Gate v2 denies this by default: an unrecognised write is exactly what the
   * gate exists to stop (D-18).
   */
  undetermined: boolean;
}

/** Extract every write target (+ new content) from a normalised payload. */
export function extractTargets(p: NormalizedPayload): Extracted {
  const cls = classifyTool(p.toolName);
  if (cls === "other") return { cls, targets: [], undetermined: false };
  if (cls === "shell") {
    const command = commandString(p.input);
    // A shell tool without a recognisable command string carries nothing we can judge; it is
    // not a write tool, so it is allowed (the scan is a heuristic seatbelt, not the gate).
    if (command === undefined) return { cls, targets: [], undetermined: false };
    return { cls, targets: extractShellWriteTargets(command), undetermined: false };
  }
  const targets = extractWriteTargets(p);
  return { cls, targets, undetermined: targets.length === 0 };
}

function extractWriteTargets(p: NormalizedPayload): GateTarget[] {
  const n = p.toolName.toLowerCase();
  const input = p.input;

  if (n.includes("apply_patch")) {
    // Codex: `tool_input.command` is the raw V4A patch, or an argv array whose last element is.
    let patch = firstString(input, ["input", "patch", "diff", "command"]);
    if (patch === undefined && Array.isArray(input.command)) {
      const last: unknown = input.command[input.command.length - 1];
      if (typeof last === "string") patch = last;
    }
    return patch === undefined ? [] : parseApplyPatch(patch);
  }

  if (n.includes("multi_replace") && Array.isArray(input.replacements)) {
    const byPath = new Map<string, (string | undefined)[]>();
    for (const r of input.replacements) {
      const rec = asRecord(r);
      if (rec === undefined) continue;
      const fp = firstString(rec, PATH_KEYS);
      if (fp === undefined) continue;
      const list = byPath.get(fp) ?? [];
      list.push(firstString(rec, CONTENT_KEYS));
      byPath.set(fp, list);
    }
    return [...byPath].map(([rawPath, parts]) => ({
      rawPath,
      op: "write",
      content: joinContent(parts),
    }));
  }

  const rawPath = firstString(input, PATH_KEYS);
  if (rawPath === undefined) return [];
  if (n.includes("delete")) return [{ rawPath, op: "delete", content: undefined }];
  let content = firstString(input, CONTENT_KEYS);
  if (Array.isArray(input.edits)) {
    // Claude MultiEdit: `{ file_path, edits: [{ old_string, new_string }] }`.
    content = joinContent([
      content,
      ...input.edits.map((e) => {
        const rec = asRecord(e);
        return rec === undefined ? undefined : firstString(rec, CONTENT_KEYS);
      }),
    ]);
  }
  return [{ rawPath, op: "write", content }];
}

// ---------------------------------------------------------------- resolve --

export interface ResolvedGateTarget {
  relPath: string;
  target: GateTarget;
}

export class GateDeny extends Error {
  readonly code: string;
  readonly relPath: string | undefined;
  /** Sanctioned command/step that does the same thing (v2.6 rule verdicts). */
  readonly fix: string | undefined;
  /** Let the human decide instead of refusing (formats that support `ask`; deny elsewhere). */
  readonly ask: boolean;
  constructor(
    code: string,
    message: string,
    relPath?: string,
    opts: { fix?: string; ask?: boolean } = {},
  ) {
    super(message);
    this.name = "GateDeny";
    this.code = code;
    this.relPath = relPath;
    this.fix = opts.fix;
    this.ask = opts.ask === true;
  }
}

/** A v2.6 rule verdict (`command.deny`, `coord.frozen`, …) as a gate deny. */
export function verdictDeny(v: RuleVerdict): GateDeny {
  return new GateDeny(v.id, v.reason, v.path, {
    ...(v.fix === undefined ? {} : { fix: v.fix }),
    ask: v.decision === "ask",
  });
}

const PATH_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "ERR_PATH_NOT_RELATIVE_POSIX",
  "ERR_PATH_SEGMENT",
  "ERR_PATH_NOT_NFC",
  "ERR_PATH_RESERVED_NAME",
  "ERR_PATH_INVALID_CHAR",
]);

/**
 * Containment + RelPath validation. Backslashes in the agent-supplied path are treated as
 * separators on every OS (a literal `\` in a POSIX file name is not worth a fail-open hole:
 * `..\\..\\x` must land on ERR_CONTAINMENT everywhere).
 */
export async function resolveGateTarget(
  rootReal: string,
  target: GateTarget,
  /** Directory relative paths are resolved against (the harness cwd); defaults to the root. */
  cwdReal: string = rootReal,
): Promise<ResolvedGateTarget> {
  const supplied = target.rawPath.replace(/\\/g, "/");
  let abs = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(cwdReal, supplied);
  if (path.isAbsolute(supplied)) {
    // The harness hands us paths under its own cwd, which may be non-canonical
    // (macOS /var → /private/var, Windows RUNNER~1). Canonicalize the deepest
    // existing ancestor so the comparison against rootReal is apples to apples.
    abs = await canonicalizeExisting(abs);
  }
  const rel = path.relative(rootReal, abs);
  if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new GateDeny("ERR_CONTAINMENT", "target escapes root", supplied);
  }
  const relPosix = rel.split(path.sep).join("/");
  // Windows 8.3 short names (`VERYLO~1`) alias a long name the globs were written for (P0-5).
  if (IS_WIN32 && relPosix.split("/").some((s) => /~\d+(\.[^.]*)?$/.test(s))) {
    throw new GateDeny(
      "ERR_PATH_SEGMENT",
      "8.3 short-name path segment: use the long name",
      relPosix,
    );
  }
  const issues = relPathIssues(relPosix);
  const first = issues[0];
  if (first !== undefined) {
    const code = PATH_CODES.has(first) ? first : "ERR_PATH_SEGMENT";
    throw new GateDeny(code, `invalid relative path: ${issues.join(",")}`, relPosix);
  }
  try {
    await resolveContained(rootReal, relPosix);
  } catch (err) {
    if (isAxiomError(err)) throw new GateDeny(err.code, err.message, relPosix);
    throw err;
  }
  return { relPath: relPosix, target };
}

async function canonicalizeExisting(abs: string): Promise<string> {
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpathNative(cur);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ------------------------------------------------------------- predicates --

/**
 * Hand-built `FactContext`: a real `ManifestBundle` would need digests, JCS and a validated
 * body — none of which the four gate predicates read. They touch `manifest.artifacts[].{path,op,bytes}`,
 * `facts.manifest.paths` and `facts.content(path)` only, so a synthetic bundle keeps the gate
 * inside its latency budget without forking the predicate code.
 */
export function buildGateContext(targets: readonly ResolvedGateTarget[]): FactContext {
  const enc = new TextEncoder();
  const contents = new Map<string, Uint8Array>();
  const artifacts = targets.map(({ relPath, target }) => {
    const bytes = target.content === undefined ? undefined : enc.encode(target.content);
    if (bytes !== undefined) contents.set(relPath, bytes);
    return {
      path: relPath,
      op: target.op === "delete" ? "delete" : "overwrite",
      mode: "0644",
      ...(bytes === undefined ? {} : { bytes: bytes.length }),
    };
  });
  const manifest = {
    apiVersion: "axiom.codai.ro/v3",
    kind: "Manifest",
    name: "gate",
    profile: "gate",
    planDigest: "sha256:gate",
    artifacts,
    checks: [],
    toolchain: { axiom: "gate", emitters: {} },
  };
  const bundle = { manifest, manifestDigest: "sha256:gate", blobs: {} };
  const ctx = {
    manifest,
    bundle,
    facts: {
      manifest: {
        artifactCount: artifacts.length,
        totalBytes: [...contents.values()].reduce((n, b) => n + b.length, 0),
        paths: artifacts.map((a) => a.path),
        byExt: {},
        hasDeletes: artifacts.some((a) => a.op === "delete"),
        signed: false,
      },
      content: async (p: string) => contents.get(p),
      profile: { allowRepo: false, allowGuards: false },
    },
  };
  return ctx as unknown as FactContext;
}

export async function runGatePredicates(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny | undefined> {
  return (await gatePredicateDenies(targets, profile))[0];
}

/** Every path/content predicate finding as a deny, in predicate order (path first). */
export async function gatePredicateDenies(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny[]> {
  const ctx = buildGateContext(targets);
  const findings = [];
  if (profile.deny.length > 0) findings.push(...(await pathDeny.run(ctx, { globs: profile.deny })));
  if (profile.allow !== undefined && profile.allow.length > 0)
    findings.push(...(await pathAllow.run(ctx, { globs: profile.allow })));
  const hasContent = targets.some((t) => t.target.content !== undefined);
  if (hasContent && profile.noSecrets) {
    const found = await contentNoSecrets.run(ctx, {
      disable: [],
      allowPaths: [],
      pii: profile.pii,
    });
    const excluded =
      profile.noSecretsExclude === undefined || profile.noSecretsExclude.length === 0
        ? undefined
        : globMatcher(profile.noSecretsExclude, false);
    findings.push(
      ...found.filter(
        (f) =>
          excluded === undefined ||
          f.path === undefined ||
          !PII_CLASS_IDS.has(f.id) ||
          !excluded(f.path),
      ),
    );
  }
  if (hasContent && profile.maxBytes !== undefined)
    findings.push(...(await contentMaxBytes.run(ctx, { max: profile.maxBytes })));
  return findings.map((f) => new GateDeny(f.id, f.message, f.path));
}

/** `content.noSecrets` ids that `noSecretsExclude` may silence (never real credentials). */
const PII_CLASS_IDS: ReadonlySet<string> = new Set([
  "content.noSecrets.email",
  "content.noSecrets.phoneRo",
  "content.noSecrets.cnp",
  "content.noSecrets.card",
  "content.noSecrets.credentialAssignment",
]);

// ------------------------------------------------------------- relaxation --

/** `axiom-override: <reason>` — the reason runs to the end of the line. */
const OVERRIDE_RE = /axiom-override:\s*([^\r\n]{1,300})/i;
/**
 * Tool-input fields an agent writes PROSE into (never file content, never the command body:
 * 3.0, D-44). A shell command may carry the override only as a trailing `# axiom-override:`
 * comment outside quotes and heredocs — see {@link findTrailingOverride}.
 */
const OVERRIDE_KEYS = ["explanation", "goal", "description", "reason", "justification"] as const;

/** ≥ 3 words with letters and ≥ 12 letters in total: "ok ok ok" or "........" is not a reason. */
export function isOverrideReason(reason: string): boolean {
  const words = reason.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = (reason.match(/\p{L}/gu) ?? []).length;
  return words.length >= 3 && letters >= 12;
}

/**
 * The override reason the agent stated in the tool call, or `undefined`. `command` is the
 * shell command of a shell-class tool (only its trailing comment counts); pass `undefined`
 * for every other tool so an apply_patch body or file content can never unlock a deny.
 */
export function findOverrideReason(
  input: Record<string, unknown>,
  command?: string,
): string | undefined {
  for (const k of OVERRIDE_KEYS) {
    const v = input[k];
    if (typeof v !== "string") continue;
    const m = OVERRIDE_RE.exec(v);
    const reason = m?.[1]?.replace(/["'`]+\s*$/, "").trim();
    if (reason !== undefined && isOverrideReason(reason)) return reason;
  }
  if (command !== undefined) return findTrailingOverride(command);
  return undefined;
}

/** True when `code` is listed in `hard` exactly, or under a `prefix.*` / `*` entry. */
export function isHardCode(hard: readonly string[], code: string): boolean {
  return hard.some((h) =>
    h === "*" ? true : h.endsWith(".*") ? code.startsWith(h.slice(0, -1)) : h === code,
  );
}

const SYSTEM_DIRS_WIN = [
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata",
];
const SYSTEM_DIRS_POSIX = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/lib",
  "/lib64",
  "/proc",
  "/sys",
  "/dev",
  "/System",
  "/Library",
];

/** Operating-system directories: `outside: "allow"` still warns for these. */
export function isSystemPath(abs: string, win32: boolean = IS_WIN32): boolean {
  const p = abs.replace(/\\/g, "/").replace(/^\/\/[?.]\/|^\/\?\?\//, "");
  const under = (dir: string, s: string) => s === dir || s.startsWith(`${dir}/`);
  if (win32) {
    const l = p.toLowerCase();
    return SYSTEM_DIRS_WIN.some((d) => under(d, l));
  }
  return SYSTEM_DIRS_POSIX.some((d) => under(d, p));
}

/** Ask id of a target matching the profile's `ask` globs (predicate-style, like `path.deny`). */
export const PATH_ASK_CODE = "path.ask";

function askDeny(relPath: string | undefined): GateDeny {
  return new GateDeny(
    PATH_ASK_CODE,
    `"${relPath ?? "."}" is a sensitive path (gate profile "ask"): confirm before the agent edits it`,
    relPath,
    { ask: true },
  );
}

/**
 * Profile `ask` globs: a target matching one → an `ask` verdict (the human confirms). Same glob
 * semantics as `path.deny` (it IS `path.deny` over the ask globs). Callers run it only after
 * every deny-class check passed, so a deny always wins.
 */
export async function runAskGlobs(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny | undefined> {
  if (profile.ask.length === 0) return undefined;
  const findings = await pathDeny.run(buildGateContext(targets), { globs: profile.ask });
  const f = findings[0];
  if (f === undefined) return undefined;
  return askDeny(f.path);
}

/** Deny id of `steer: "require"` (predicate-style, like `path.deny`). */
export const STEER_REQUIRE_CODE = "steer.requireApply";

/** Whole-file write tools: a create/overwrite, as opposed to a targeted edit. */
const WHOLE_FILE_TOOL_RE = /^(create_file|createfile|write_file|writefile|write|create_new_file)$/i;

export function isWholeFileTool(toolName: string): boolean {
  return WHOLE_FILE_TOOL_RE.test(toolName.replace(/^.*[.:/]/, ""));
}

function toSessionTargets(
  resolved: readonly ResolvedGateTarget[],
  toolName: string,
): SessionTarget[] {
  const whole = isWholeFileTool(toolName);
  return resolved.map((r) => ({ relPath: r.relPath, op: r.target.op, whole }));
}

/** A denied whole-file create leaves a marker so re-running that script is refused (S-1215). */
async function noteDeniedCreate(
  rootReal: string,
  cls: ToolClass,
  toolName: string,
  resolved: readonly ResolvedGateTarget[],
  targetRoot: string,
  profile: GateProfile,
): Promise<void> {
  if (cls !== "write" || !isWholeFileTool(toolName)) return;
  if (profile.sessions !== undefined && !profile.sessions.staleScript) return;
  for (const r of resolved) await recordDeniedCreate(rootReal, path.join(targetRoot, r.relPath));
}

/**
 * Shell-command rules of the v2.6 profile, in order: stale script (S-1215) → command rules
 * (S-1208) → coordination (S-1212) → git state (S-1213). Every command rule is evaluated
 * (3.0): the returned list keeps that order, so callers pick a hard verdict before the first.
 */
export async function runCommandRules(
  command: string,
  profile: GateProfile,
  rootReal: string,
  home?: string,
): Promise<RuleVerdict[]> {
  const out: RuleVerdict[] = [];
  if (profile.sessions === undefined || profile.sessions.staleScript) {
    const v = await checkStaleScript(rootReal, command);
    if (v !== undefined) out.push(v);
  }
  if (profile.commands !== undefined) out.push(...evaluateCommandRules(command, profile.commands));
  if (profile.coordination !== undefined) {
    const v = await evaluateCoordination(command, profile.coordination, {
      root: rootReal,
      ...(home === undefined ? {} : { home }),
    });
    if (v !== undefined) out.push(v);
  }
  if (profile.git !== undefined) {
    const v = await evaluateGit(command, profile.git as GitRules, rootReal);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * `steer: "require"`: a direct write touching `steerGlobs` is denied — the agent must go through
 * `axiom_write`. Same glob semantics as `path.deny` (it IS `path.deny` over the steer globs).
 */
export async function runSteerRequire(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny | undefined> {
  if (profile.steer !== "require" || profile.steerGlobs.length === 0) return undefined;
  const findings = await pathDeny.run(buildGateContext(targets), { globs: profile.steerGlobs });
  const f = findings[0];
  if (f === undefined) return undefined;
  return new GateDeny(
    STEER_REQUIRE_CODE,
    "this path must be changed through the axiom_write MCP tool (preview, then apply with confirmDigest), not a direct write",
    f.path,
  );
}

/** Once-per-session context hint for allowed writes (`steer: "hint" | "require"`). */
export const GATE_STEER_HINT =
  "This repository is guarded by AXIOM. For multi-file or sensitive changes prefer the axiom_write MCP tool (preview → apply with confirmDigest): atomic, checked, journaled, one-step rollback.";

/**
 * True exactly once per (root, session): creates `<root>/.axiom/hints/<sha256(session)[:16]>`
 * exclusively. Any fs error → false (a hint is never worth a failure).
 */
export async function claimSessionHint(root: string, sessionId: string): Promise<boolean> {
  const dir = path.join(root, ".axiom", "hints");
  try {
    await mkdir(dir, { recursive: true });
    const fh = await open(path.join(dir, sha256Hex(sessionId).slice(0, 16)), "wx");
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- formats --

/** Formats that can carry a hint on an allow. */
const HINT_FORMATS: ReadonlySet<GateFormat> = new Set<GateFormat>([
  "auto",
  "claude",
  "copilot",
  "vscode",
  "codex",
  "junie",
  "cursor",
  "cline",
]);

/** stdout for an ALLOW in `format`, carrying `hint` when given. */
export function allowDocument(format: GateFormat, hint?: string): string | undefined {
  if (hint === undefined || !HINT_FORMATS.has(format)) return allowStdout(format);
  if (format === "cursor") return JSON.stringify({ permission: "allow", agent_message: hint });
  if (format === "cline") return JSON.stringify({ cancel: false, contextModification: hint });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: hint },
  });
}

/** stdout (undefined = none) and exit code of a DENY in `format`. */
export function renderDeny(
  format: GateFormat,
  d: GateDeny,
  reason: string,
  extra: { toolClass?: ToolClass; denyExit?: 0 | 2 },
): { stdout: string | undefined; exitCode: 0 | 2 } {
  const exit = (dflt: 0 | 2): 0 | 2 => extra.denyExit ?? dflt;
  // `ask` hands the decision to the human where the harness has a prompt for it; every other
  // format gets a plain deny (fail-closed).
  const decision = d.ask && ASK_FORMATS.has(format) ? "ask" : "deny";
  switch (format) {
    case "codex":
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
        exitCode: exit(0),
      };
    case "cursor":
      return {
        stdout: JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }),
        exitCode: exit(0),
      };
    case "windsurf":
    case "kiro":
      // Cascade/Devin hooks block only on exit 2, Kiro on any non-zero exit; stdout is not read.
      return { stdout: undefined, exitCode: exit(GATE_EXIT_DENY) };
    case "gemini":
      return { stdout: JSON.stringify({ decision: "deny", reason }), exitCode: exit(0) };
    case "junie":
      // Junie pauses and asks the user on `decision: "ask"`.
      return { stdout: JSON.stringify({ decision, reason }), exitCode: exit(0) };
    case "claude":
      // Claude validates the hook document against its schema: only `hookSpecificOutput`
      // (extra top-level keys can turn a deny into a non-blocking hook error).
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason,
          },
        }),
        exitCode: exit(GATE_DENY_EXIT_DEFAULT),
      };
    case "cline":
      return { stdout: JSON.stringify({ cancel: true, errorMessage: reason }), exitCode: exit(0) };
    default:
      return {
        stdout: JSON.stringify(
          denyDocument(
            d,
            reason,
            extra.toolClass === undefined ? {} : { toolClass: extra.toolClass },
            decision,
          ),
        ),
        exitCode: exit(GATE_DENY_EXIT_DEFAULT),
      };
  }
}

/** Formats whose PreToolUse contract has `permissionDecision: "ask"` (Claude, VS Code, Copilot). */
const ASK_FORMATS: ReadonlySet<GateFormat> = new Set<GateFormat>([
  "auto",
  "claude",
  "copilot",
  "vscode",
  "junie",
]);

// ------------------------------------------------------------------- run --

export const GATE_LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type GateLogLevel = (typeof GATE_LOG_LEVELS)[number];
const RANK: Record<GateLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface GateOptions {
  /** Fallback root when the payload has no `cwd`. */
  root?: string;
  /** stdin exceeded the size cap: an agent action, judged fail-closed (unlike an empty stdin). */
  stdinTooLarge?: boolean;
  /** Explicit profile file (overrides the search path). */
  profilePath?: string;
  /** @deprecated Gate v2 is fail-closed by default; kept as a no-op alias for old hook configs. */
  strict?: boolean;
  /**
   * Restore the 2.1 behaviour: internal errors, malformed payloads and undetermined write
   * targets are allowed with a stderr warning instead of denied (D-18 opt-out).
   */
  failOpen?: boolean;
  /** Do not scan shell commands for write primitives (D-18 opt-out). */
  noShellScan?: boolean;
  /** Do not walk up from `cwd` to the nearest `.axiom/`/`.git/` ancestor. */
  noRootDiscovery?: boolean;
  /**
   * `--track-reads` (S-1215): read tools reach the full gate (the `cli.ts` fast path is skipped)
   * so a profile with `sessions.trackReads` can record what each session has seen.
   */
  trackReads?: boolean;
  /**
   * Exit code for a deny (D-35). Default 0: the JSON document on stdout carries the decision,
   * which survives the npm `.ps1` shim. 2 for harnesses that only read the exit code (Windsurf).
   */
  denyExit?: 0 | 2;
  /** Harness output contract (`--format`); default `auto` = combined Claude + Copilot document. */
  format?: GateFormat;
  logLevel?: GateLogLevel;
  /** Test hook for `~/.axiom/gate-profile.json`. */
  home?: string;
  /**
   * Last-resort cwd. The hook is the ONE place where the harness's cwd is acceptable:
   * both Claude Code and Copilot CLI spawn the hook in the project directory and put the
   * same value in the payload's `cwd`, so there is no ambiguity about who owns it.
   */
  cwdFallback?: () => string;
}
/** Read keys of read-only file tools (`read_file`, Claude `Read`, …). */
const READ_TOOL_RE = /(^|[_.:-])(read|view)([_-]?file|[_-]?notebook)?$|^read/i;

/** Record a read for `sessions.trackReads` (advisory; never fails the call). */
async function trackRead(
  payload: NormalizedPayload,
  opts: GateOptions,
  log: (lvl: GateLogLevel, msg: string) => void,
): Promise<void> {
  try {
    if (payload.sessionId === undefined || !READ_TOOL_RE.test(payload.toolName)) return;
    const rawPath = firstString(payload.input, PATH_KEYS);
    if (rawPath === undefined) return;
    const rootArg = payload.cwd ?? opts.root ?? (opts.cwdFallback ?? (() => process.cwd()))();
    const cwdReal = await realOrResolved(path.resolve(rootArg));
    const rootReal =
      opts.noRootDiscovery === true ? cwdReal : await discoverRoot(cwdReal, opts.home);
    const { profile } = await loadGateProfile({
      root: rootReal,
      ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
      ...(opts.home === undefined ? {} : { home: opts.home }),
    });
    if (profile.sessions?.trackReads !== true) return;
    const r = await resolveGateTarget(
      rootReal,
      { rawPath, op: "write", content: undefined },
      cwdReal,
    );
    await recordSessionRead(rootReal, payload.sessionId, "", [r.relPath]);
  } catch (err) {
    log("debug", `track read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface GateResult {
  decision: "allow" | "deny";
  /** OWASP Agent Control Standard v0.1 Guardian vocabulary; the gate emits `allow` or `deny`. */
  verdict: "allow" | "deny" | "modify" | "ask" | "defer";
  exitCode: 0 | 2;
  code?: string;
  reason?: string;
  path?: string;
  /**
   * The stdout document for the chosen format: on deny the format's deny shape (`auto` = Claude
   * `hookSpecificOutput` + Copilot flat shape + `axiom` block); on allow a hint or Cursor's
   * explicit allow, otherwise absent.
   */
  stdout?: string;
  /** Steering hint attached to an allowed write (once per session). */
  hint?: string;
  stderr: string[];
  durationMs: number;
  /** Which class of tool was judged. */
  toolClass?: ToolClass;
  /** Root actually used, when one was resolved. */
  root?: string;
}

/**
 * The single stdout document for a deny. Claude reads `hookSpecificOutput.permissionDecision`;
 * Copilot CLI/VS Code read the flat `permissionDecision`/`permissionDecisionReason` and merge
 * them into their own deny; `axiom` carries the machine-readable verdict (OWASP ACS
 * vocabulary) plus code/path for log consumers. Unknown keys are ignored by both harnesses.
 */
export function denyDocument(
  d: GateDeny,
  reason: string,
  extra: { toolClass?: ToolClass },
  decision: "deny" | "ask" = "deny",
) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
    permissionDecision: decision,
    permissionDecisionReason: reason,
    axiom: {
      verdict: decision,
      code: d.code,
      ...(d.relPath === undefined ? {} : { path: d.relPath }),
      ...(d.fix === undefined ? {} : { fix: d.fix }),
      ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
      standard: "owasp-acs/0.1",
    },
  };
}

function denyResult(
  d: GateDeny,
  stderr: string[],
  t0: number,
  extra: { toolClass?: ToolClass; root?: string; denyExit?: 0 | 2; format?: GateFormat } = {},
): GateResult {
  const where = d.relPath === undefined ? "" : ` (${d.relPath})`;
  const fix = d.fix === undefined ? "" : ` — fix: ${d.fix}`;
  const reason = `AXIOM GATE ${d.ask ? "ASK" : "DENY"} ${d.code}: ${d.message}${where}${fix}`;
  stderr.push(reason);
  const out = renderDeny(extra.format ?? "auto", d, reason, {
    ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
    ...(extra.denyExit === undefined ? {} : { denyExit: extra.denyExit }),
  });
  const asked = d.ask && ASK_FORMATS.has(extra.format ?? "auto");
  return {
    decision: "deny",
    verdict: asked ? "ask" : "deny",
    exitCode: out.exitCode,
    code: d.code,
    reason: d.message,
    ...(d.relPath === undefined ? {} : { path: d.relPath }),
    ...(out.stdout === undefined ? {} : { stdout: out.stdout }),
    stderr,
    durationMs: performance.now() - t0,
    ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
    ...(extra.root === undefined ? {} : { root: extra.root }),
  };
}

const samePath = (a: string, b: string): boolean =>
  IS_WIN32 ? a.toLowerCase() === b.toLowerCase() : a === b;

async function realOrResolved(p: string): Promise<string> {
  try {
    let r = await realpathNative(p);
    if (IS_WIN32 && r.startsWith("\\\\?\\")) r = r.slice(4);
    return r;
  } catch {
    return path.resolve(p);
  }
}

/**
 * The git common dir of the checkout rooted at `dir`, read from disk (no `git` spawn — the
 * hook budget and the no-shell invariant both forbid it). `.git` directory → itself. `.git`
 * file (`gitdir: <common>/worktrees/<name>`) → `<gitdir>/commondir`, and only when the
 * back-link `<gitdir>/gitdir` points at this very `.git` file — a hand-made `.git` file that
 * merely names another repo's worktree does not borrow that repo's identity.
 */
export async function gitCommonDir(dir: string): Promise<string | undefined> {
  const dotGit = path.join(dir, ".git");
  // Open first, verify after: the lstat confirms `.git` itself is a regular file (a symlink is
  // refused, as before) and is the inode we hold, so nothing can be swapped in between.
  let text: string;
  try {
    const fh = await open(dotGit, "r");
    try {
      const held = await fh.stat();
      const st = await lstat(dotGit);
      if (held.ino !== st.ino || held.dev !== st.dev) return undefined;
      if (st.isDirectory()) return realOrResolved(dotGit);
      if (!st.isFile()) return undefined;
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    // Windows refuses to open a directory for reading (EISDIR/EPERM): a plain `.git` directory.
    const st = await lstat(dotGit).catch(() => undefined);
    if (st?.isDirectory() === true && (err as { code?: string }).code !== "ENOENT") {
      return realOrResolved(dotGit);
    }
    return undefined;
  }
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (m?.[1] === undefined) return undefined;
    const gitdir = path.resolve(dir, m[1]);
    const back = (await readFile(path.join(gitdir, "gitdir"), "utf8")).trim();
    const [backReal, selfReal] = await Promise.all([
      realOrResolved(path.resolve(gitdir, back)),
      realOrResolved(dotGit),
    ]);
    if (!samePath(backReal, selfReal)) return undefined;
    const common = (await readFile(path.join(gitdir, "commondir"), "utf8")).trim();
    return realOrResolved(path.resolve(gitdir, common));
  } catch {
    return undefined;
  }
}

/**
 * D-35: agents work in sibling worktrees (`E:\gh\.wt\<repo>\task-N`) while the harness cwd is
 * the main clone. A target outside `rootReal` whose nearest `.git` ancestor is a worktree of
 * the SAME repository (equal common dir) is judged against that worktree's root. Anything
 * else — another repo, no git, a forged `.git` file — returns undefined (stays ERR_CONTAINMENT).
 */
export async function sameRepoWorktreeRoot(
  rootReal: string,
  rawPath: string,
  cwdReal: string,
): Promise<string | undefined> {
  const rootCommon = await gitCommonDir(rootReal);
  if (rootCommon === undefined) return undefined;
  const supplied = rawPath.replace(/\\/g, "/");
  const abs = await canonicalizeExisting(
    path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(cwdReal, supplied),
  );
  let cur = path.dirname(abs);
  for (let depth = 0; depth < 64; depth++) {
    if (samePath(cur, rootReal)) return undefined;
    const common = await gitCommonDir(cur);
    if (common !== undefined) {
      return samePath(common, rootCommon) ? cur : undefined;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

const AXIOM_REPO_MARKERS = ["journal", "cas", "applied", "profiles", "trust", "lock", "backup"];

/** Deny id for `git clean` / `git reset --hard` on the whole tree (3.0, P0-6). */
export const DESTRUCTIVE_TREE_CODE = "git.destructiveTree";

/** `git.destructiveTree` is hard whenever the profile hardens reset --hard or clean -f. */
export function destructiveTreeIsHard(hard: readonly string[]): boolean {
  return (
    isHardCode(hard, DESTRUCTIVE_TREE_CODE) ||
    isHardCode(hard, "house.resetHard") ||
    isHardCode(hard, "house.cleanForce")
  );
}

async function mtimeMs(file: string): Promise<number | undefined> {
  try {
    return (await lstat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The gate profile for `root` (3.0, I-2). A linked worktree (agent slot) whose own
 * `.axiom/gate-profile.json` is missing or OLDER than the main clone's inherits the main
 * clone's profile, so a policy change reaches every slot without copying files. `--profile`
 * always wins; a slot with a newer profile of its own keeps it.
 */
export async function loadGateProfileForRoot(
  root: string,
  opts: { profilePath?: string; home?: string } = {},
): Promise<{ profile: GateProfile; source: string; unknownKeys?: string[] }> {
  const base = {
    ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
  };
  if (opts.profilePath === undefined) {
    // 3.0 (D-42): `.axiom/axiom.json` wins over the legacy gate-profile.json.
    const v3 = await loadAxiomConfigAsGate(root, opts.home);
    if (v3 !== undefined) return v3;
    const common = await gitCommonDir(root);
    if (common !== undefined && path.basename(common).toLowerCase() === ".git") {
      const mainRoot = path.dirname(common);
      if (!samePath(mainRoot, root)) {
        const own = await mtimeMs(path.join(root, ".axiom", "gate-profile.json"));
        const inherited = await mtimeMs(path.join(mainRoot, ".axiom", "gate-profile.json"));
        if (inherited !== undefined && (own === undefined || own < inherited)) {
          return loadGateProfile({ root: mainRoot, ...base });
        }
      }
    }
  }
  return loadGateProfile({ root, ...base });
}

/** The `gate` section of `<root>/.axiom/axiom.json` (extends resolved), or undefined. */
async function loadAxiomConfigAsGate(
  root: string,
  home?: string,
): Promise<{ profile: GateProfile; source: string; unknownKeys?: string[] } | undefined> {
  let cfg: Awaited<ReturnType<typeof loadAxiomConfig>>;
  try {
    cfg = await loadAxiomConfig(root, home === undefined ? {} : { home });
  } catch (err) {
    const code = isAxiomError(err) ? err.code : undefined;
    throw new GateProfileError(
      code === "ERR_PROFILE_VERSION" ? "ERR_PROFILE_VERSION" : "ERR_INVALID_PROFILE",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (cfg === undefined) return undefined;
  const raw = cfg.gate ?? {};
  const parsed = GateProfileSchema.safeParse(raw);
  const source = cfg.sources.at(-1) ?? path.join(root, ".axiom", "axiom.json");
  if (!parsed.success) {
    throw new GateProfileError(
      "ERR_INVALID_PROFILE",
      `invalid gate section in ${source}: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const unknownKeys = [...unknownGateProfileKeys(raw), ...cfg.warnings.map((w) => `(${w})`)];
  return {
    profile: parsed.data,
    source,
    ...(unknownKeys.length === 0 ? {} : { unknownKeys }),
  };
}

/**
 * Walk up from `start` to the nearest directory that is a repository root: it holds `.git`
 * (directory, or the file a worktree/submodule uses) or a *repo* `.axiom/` (one with
 * journal/cas/applied/profiles/trust — not `~/.axiom/`, which only holds a gate profile).
 * Never climbs to or above the home directory, and never above `stopAt` when given. A
 * harness that runs the agent in `apps/web` still has `.git/**` and `.env` at the repo root,
 * and the profile lives there too. Returns `start` when nothing is found.
 */
export async function discoverRoot(start: string, home: string = homedir()): Promise<string> {
  const homeReal = path.resolve(home);
  const isHomeOrAbove = (p: string): boolean => {
    const a = IS_WIN32 ? p.toLowerCase() : p;
    const h = IS_WIN32 ? homeReal.toLowerCase() : homeReal;
    return a === h || h.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
  };
  let cur = start;
  for (let depth = 0; depth < 64; depth++) {
    if (isHomeOrAbove(cur)) break;
    try {
      const st = await lstat(path.join(cur, ".git"));
      if (st.isDirectory() || st.isFile()) return cur;
    } catch {
      /* keep walking */
    }
    try {
      const ax = path.join(cur, ".axiom");
      if ((await lstat(ax)).isDirectory()) {
        for (const m of AXIOM_REPO_MARKERS) {
          try {
            await lstat(path.join(ax, m));
            return cur;
          } catch {
            /* next marker */
          }
        }
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/**
 * Evaluate one payload (already read from stdin). Never throws.
 * `payloadText === undefined` means stdin timed out / was empty → deny (fail closed) unless
 * `failOpen`.
 */
export async function runGate(
  payloadText: string | undefined,
  opts: GateOptions = {},
): Promise<GateResult> {
  const t0 = performance.now();
  const level: GateLogLevel = opts.logLevel ?? "warn";
  const format: GateFormat = opts.format ?? "auto";
  const stderr: string[] = [];
  let toolClass: ToolClass | undefined;
  let rootUsed: string | undefined;
  const log = (lvl: GateLogLevel, msg: string) => {
    if (RANK[lvl] <= RANK[level]) stderr.push(`AXIOM GATE ${lvl.toUpperCase()}: ${msg}`);
  };
  const allow = (why: string, hint?: string): GateResult => {
    log("debug", `allow: ${why}`);
    const stdout = allowDocument(format, hint);
    return {
      decision: "allow",
      verdict: "allow",
      exitCode: GATE_EXIT_ALLOW,
      ...(stdout === undefined ? {} : { stdout }),
      ...(hint === undefined ? {} : { hint }),
      stderr,
      durationMs: performance.now() - t0,
      ...(toolClass === undefined ? {} : { toolClass }),
      ...(rootUsed === undefined ? {} : { root: rootUsed }),
    };
  };
  const deny = (d: GateDeny): GateResult =>
    denyResult(d, stderr, t0, {
      ...(toolClass === undefined ? {} : { toolClass }),
      ...(rootUsed === undefined ? {} : { root: rootUsed }),
      ...(opts.denyExit === undefined ? {} : { denyExit: opts.denyExit }),
      format,
    });
  /** Fail-closed (D-18): a non-answer is a deny unless the operator opted out. */
  const internal = (why: string): GateResult => {
    if (opts.failOpen === true) {
      log("warn", `${why} — failing open (--fail-open)`);
      return allow("internal error");
    }
    return deny(new GateDeny("ERR_INTERNAL", `${why} (fail-closed; pass --fail-open to allow)`));
  };

  // An empty / timed-out stdin is a harness or wiring hiccup, not an agent action: every
  // harness already fails open on a hook timeout, so denying here only stalls long-running
  // chats (3.0, S-1313). Unparseable JSON stays fail-closed.
  if (payloadText === undefined && opts.stdinTooLarge === true) {
    return internal(`stdin exceeded ${GATE_STDIN_MAX_BYTES} bytes`);
  }
  if (payloadText === undefined) {
    log("warn", "no payload on stdin (timeout or empty) — allowing");
    return allow("no payload on stdin");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch {
    // Never echo the parse error: it quotes the payload, which may carry a secret.
    return internal(`payload is not JSON (${payloadText.length} bytes)`);
  }
  const payload = normalizePayload(raw);
  // No tool name at all: not a PreToolUse payload we understand. Nothing to judge → allow
  // (a hook wired to the wrong event must not brick the editor); logged at info.
  if (payload === undefined) {
    log("info", "payload carries no tool name");
    return allow("payload carries no tool name");
  }
  const extracted = extractTargets(payload);
  toolClass = extracted.cls;
  if (extracted.cls === "other") {
    if (opts.trackReads === true) await trackRead(payload, opts, log);
    return allow(`tool ${payload.toolName} is not a write/shell tool`);
  }
  if (extracted.cls === "shell" && opts.noShellScan === true) {
    return allow(`tool ${payload.toolName} is a shell tool and --no-shell-scan is set`);
  }
  if (extracted.undetermined) {
    // Write-class tool, target unknown (D-18: unknown → deny with reason).
    if (opts.failOpen === true) {
      log(
        "warn",
        `write tool ${payload.toolName} has no recognised path key — allowing (--fail-open)`,
      );
      return allow("undetermined write target");
    }
  }
  const targets = extracted.targets;
  // A shell command with no write target may still hit a command / coordination / git rule
  // (v2.6), so it needs the profile; a write tool with none was handled above.
  const command = extracted.cls === "shell" ? commandString(payload.input) : undefined;
  if (targets.length === 0 && command === undefined && !extracted.undetermined)
    return allow(`tool ${payload.toolName} writes nothing recognisable`);
  const agentId = `${payload.harness ?? (format === "auto" ? "unknown" : format)}:${payload.sessionId ?? "unknown"}`;

  /** Set once the main root and its profile are known: what the decision journal needs. */
  let rec: { root: string; profile: GateProfile; source: string } | undefined;
  /** Profile file of the root that produced the blocking finding, when not the main one. */
  let decidingProfile: string | undefined;
  const judgedPaths: string[] = [];
  /**
   * Shadow mode (S-1216): the FIRST v2.6 rule verdict (command / coordination / git / session)
   * is remembered instead of enforced; the call continues and the journal line carries what the
   * gate would have decided. Path / content predicates keep enforcing — shadow never weakens the
   * protection a profile already had.
   */
  let shadowOf: GateResult | undefined;
  /** Id of the v2.6 rule that decided (enforced or shadowed), for the journal's `rule` field. */
  let ruleOf: string | undefined;
  /** 2.7: denies let through as warnings (`mode: "warn"`, an override, or `outside`). */
  const warnings: string[] = [];
  let relaxedKind: "warn" | "override" | undefined;
  let relaxedCode: string | undefined;
  const overrideReason = findOverrideReason(payload.input, command);
  /** True when `d` is let through (and remembered as a warning); hard codes and asks never are. */
  const relax = (d: GateDeny, p: GateProfile | undefined = rec?.profile): boolean => {
    if (p === undefined || d.ask || isHardCode(p.hard, d.code)) return false;
    let kind: "warn" | "override";
    if (p.override && overrideReason !== undefined) kind = "override";
    else if (p.mode === "warn") kind = "warn";
    else return false;
    if (relaxedKind !== "override") relaxedKind = kind;
    relaxedCode ??= d.code;
    const where = d.relPath === undefined ? "" : ` (${d.relPath})`;
    const fix = d.fix === undefined ? "" : ` — fix: ${d.fix}`;
    const msg =
      kind === "override"
        ? `AXIOM GATE OVERRIDE ${d.code}: ${d.message}${where} — allowed because the agent stated: "${overrideReason}"`
        : `AXIOM GATE WARN ${d.code}: ${d.message}${where}${fix} — allowed (warn mode); if this was unintended, stop and fix it`;
    warnings.push(msg);
    if (RANK.warn <= RANK[level]) stderr.push(msg);
    return true;
  };
  const recorded = async (r: GateResult): Promise<GateResult> => {
    if (rec === undefined) return r;
    // Relaxed decisions (warn / override) are always journaled: they are the audit trail D-40
    // promised. Plain allow/deny lines need `record` or `shadow`.
    const relaxedHere = r.decision === "allow" && relaxedKind !== undefined;
    if (!rec.profile.record && !rec.profile.shadow && !relaxedHere) return r;
    try {
      const judged = r.decision === "allow" && shadowOf !== undefined ? shadowOf : r;
      const relaxedAllow = judged.decision === "allow" && relaxedKind !== undefined;
      await appendDecision(rec.root, {
        v: 1,
        decided_at: new Date().toISOString(),
        agent_id: agentId,
        principal: { subject: principalSubject() },
        tool: payload.toolName,
        ...hashArgs(payload.input),
        decision: judged.verdict === "ask" ? "ask" : judged.decision,
        ...(judged.code === undefined ? {} : { code: judged.code }),
        ...(relaxedAllow && relaxedCode !== undefined ? { code: relaxedCode } : {}),
        ...(relaxedAllow && relaxedKind !== undefined ? { relaxed: relaxedKind } : {}),
        ...(relaxedAllow && relaxedKind === "override" && overrideReason !== undefined
          ? { override_reason: overrideReason }
          : {}),
        ...(judged.reason === undefined ? {} : { reason: judged.reason }),
        paths: [...new Set(judgedPaths)],
        profile: rec.source,
        ...(decidingProfile !== undefined && decidingProfile !== rec.source
          ? { profile_decided: decidingProfile }
          : {}),
        ms: Math.round(judged.durationMs * 10) / 10,
        ...(rec.profile.shadow ? { shadow: true as const } : {}),
        // Shadow records carry the command so `guard-parity.mjs --replay` can diff it (S-1216).
        ...((rec.profile.shadow || relaxedAllow) && command !== undefined ? { command } : {}),
        ...(ruleOf !== undefined &&
        (judged.code === ruleOf || (relaxedAllow && relaxedCode === ruleOf))
          ? { rule: ruleOf }
          : {}),
      });
    } catch (err) {
      log("debug", `decision journal: ${err instanceof Error ? err.message : String(err)}`);
    }
    return r;
  };
  /** A v2.6 rule verdict: enforced, or (shadow mode) remembered and `undefined` returned. */
  const ruleVerdict = async (v: RuleVerdict): Promise<GateResult | undefined> => {
    if (rec?.profile.shadow === true) {
      if (shadowOf === undefined) {
        ruleOf = v.id;
        shadowOf = denyResult(verdictDeny(v), [], t0, {
          ...(toolClass === undefined ? {} : { toolClass }),
          format,
        });
      }
      log(
        "info",
        `shadow: would ${v.decision ?? "deny"} ${v.id}${v.path === undefined ? "" : ` (${v.path})`}`,
      );
      return undefined;
    }
    ruleOf = v.id;
    const d = verdictDeny(v);
    if (relax(d)) return undefined;
    return recorded(deny(d));
  };

  try {
    const rootArg = payload.cwd ?? opts.root ?? (opts.cwdFallback ?? (() => process.cwd()))();
    let rootReal = await realpathNative(path.resolve(rootArg));
    if (IS_WIN32 && rootReal.startsWith("\\\\?\\")) rootReal = rootReal.slice(4);
    // Relative targets are relative to where the agent runs (the payload cwd), even after the
    // root is discovered above it.
    const cwdReal = rootReal;
    if (opts.noRootDiscovery !== true) {
      const discovered = await discoverRoot(rootReal, opts.home);
      if (discovered !== rootReal) {
        log("debug", `root discovered ${rootReal} → ${discovered}`);
        rootReal = discovered;
      }
    }
    rootUsed = rootReal;
    const profiles = new Map<string, { profile: GateProfile; source: string }>();
    const loadFor = async (root: string): Promise<{ profile: GateProfile; source: string }> => {
      const hit = profiles.get(root);
      if (hit !== undefined) return hit;
      const loaded = await loadGateProfileForRoot(root, opts);
      if (loaded.unknownKeys !== undefined) {
        log(
          "warn",
          `${loaded.source}: ignoring unknown key(s) ${loaded.unknownKeys.join(", ")} (written for a newer axiom?)`,
        );
      }
      log("debug", `root=${root} profile=${loaded.source}`);
      profiles.set(root, loaded);
      return loaded;
    };
    const main = await loadFor(rootReal);
    const profile = main.profile;
    rec = { root: rootReal, profile, source: main.source };
    log("debug", `class=${extracted.cls} targets=${targets.length}`);
    if (extracted.undetermined) {
      // Write-class tool, target unknown (D-18: unknown → deny with reason) — judged after the
      // profile loads so warn mode / an override relax it like any other deny (3.0).
      const d = new GateDeny(
        "ERR_UNSUPPORTED_OP",
        `write tool "${payload.toolName}" carries no recognised path key (${PATH_KEYS.join(", ")}); add it to the gate or pass --fail-open`,
      );
      if (!relax(d)) return recorded(deny(d));
      return recorded(allow("undetermined write target relaxed", warnings.join("\n")));
    }
    if (command !== undefined) {
      const found = await runCommandRules(command, profile, rootReal, opts.home);
      // A hard verdict anywhere wins over an earlier relaxable one (3.0: hard by code, never
      // by evaluation order).
      const v = found.find((x) => isHardCode(profile.hard, x.id)) ?? found[0];
      if (v !== undefined) {
        const r = await ruleVerdict(v);
        if (r !== undefined) return r;
      }
    }
    /** Targets grouped by the root they are judged against (the main root, or a sibling worktree). */
    const groups = new Map<string, ResolvedGateTarget[]>();
    /** First `ask` verdict (profile `ask` globs); returned only once every deny check passed. */
    let pendingAsk: GateDeny | undefined;
    /** Absolute out-of-root targets `outside` let through (undo snapshot, I-20). */
    const outsideAbs: string[] = [];
    const add = (root: string, r: ResolvedGateTarget) => {
      judgedPaths.push(r.relPath);
      const g = groups.get(root);
      if (g === undefined) groups.set(root, [r]);
      else g.push(r);
    };
    for (const t of targets) {
      if (extracted.cls === "shell" && t.rawPath === ".") {
        // `git clean` / `reset --hard` on the root itself — the root is not an escape, so this
        // is judged BEFORE containment/outside (3.0, P0-6). Deny when the profile protects
        // anything; code `git.destructiveTree` is hard whenever reset/clean are hard.
        judgedPaths.push(".");
        if (profile.deny.length > 0 || profile.commands !== undefined) {
          const d = new GateDeny(
            DESTRUCTIVE_TREE_CODE,
            "destructive git command on the whole tree",
            ".",
          );
          if (destructiveTreeIsHard(profile.hard)) throw d;
          if (relax(d)) continue;
          throw d;
        }
        if (profile.ask.length > 0) pendingAsk ??= askDeny(".");
        continue;
      }
      try {
        add(rootReal, await resolveGateTarget(rootReal, t, cwdReal));
      } catch (err) {
        if (err instanceof GateDeny && err.code === "ERR_CONTAINMENT") {
          const wt = await sameRepoWorktreeRoot(rootReal, t.rawPath, cwdReal);
          if (wt !== undefined) {
            log("debug", `target ${JSON.stringify(t.rawPath)} judged in worktree ${wt}`);
            add(wt, await resolveGateTarget(wt, t, cwdReal));
            continue;
          }
          if (profile.outside !== "deny") {
            const supplied = t.rawPath.replace(/\\/g, "/");
            const abs = path.isAbsolute(supplied) ? supplied : path.resolve(cwdReal, supplied);
            if (profile.outside === "warn" || isSystemPath(abs)) {
              const msg = `AXIOM GATE WARN ERR_CONTAINMENT: ${abs} is outside ${rootReal}${isSystemPath(abs) ? " (operating-system directory)" : ""} — allowed (outside: ${profile.outside})`;
              warnings.push(msg);
              if (RANK.warn <= RANK[level]) stderr.push(msg);
            }
            outsideAbs.push(abs);
            continue;
          }
          if (relax(err)) continue;
        }
        // Shell operands are heuristic: a token that is not a path (a URL, a glob, `.`)
        // must not deny the whole command. Real write tools keep the strict behaviour.
        if (
          extracted.cls === "shell" &&
          err instanceof GateDeny &&
          err.code !== "ERR_CONTAINMENT"
        ) {
          log("debug", `shell operand ${JSON.stringify(t.rawPath)} skipped: ${err.code}`);
          continue;
        }
        if (err instanceof GateDeny && relax(err)) continue;
        throw err;
      }
    }
    let n = 0;
    for (const [root, resolved] of groups) {
      const loadedP = await loadFor(root);
      const p = loadedP.profile;
      const steer = await runSteerRequire(resolved, p);
      const found = [...(await gatePredicateDenies(resolved, p)), ...(steer ? [steer] : [])];
      // A hard code anywhere wins over earlier relaxable findings.
      const blocking =
        found.find((d) => isHardCode(p.hard, d.code)) ?? found.find((d) => !relax(d, p));
      if (blocking !== undefined) {
        if (loadedP.source !== main.source) decidingProfile = loadedP.source;
        await noteDeniedCreate(rootReal, extracted.cls, payload.toolName, resolved, root, profile);
        return recorded(deny(blocking));
      }
      pendingAsk ??= await runAskGlobs(resolved, p);
      n += resolved.length;
    }
    const sessionTargets = toSessionTargets(groups.get(rootReal) ?? [], payload.toolName);
    if (profile.sessions !== undefined && extracted.cls === "write") {
      const v = await checkSessionWrite(
        {
          root: rootReal,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          agentId,
          tool: payload.toolName,
          targets: sessionTargets,
        },
        profile.sessions,
      );
      if (v !== undefined) {
        const r = await ruleVerdict(v);
        if (r !== undefined && v.decision !== "ask") {
          await noteDeniedCreate(
            rootReal,
            extracted.cls,
            payload.toolName,
            groups.get(rootReal) ?? [],
            rootReal,
            profile,
          );
        }
        if (r !== undefined) return r;
      }
    }
    // Every deny passed: an `ask` glob hands the decision to the human (deny on non-ask formats).
    if (pendingAsk !== undefined) return recorded(deny(pendingAsk));
    if (profile.undo && outsideAbs.length > 0) {
      await captureOutsideUndo(rootReal, {
        ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        agentId,
        tool: payload.toolName,
        absPaths: outsideAbs,
      });
    }
    if (sessionTargets.length > 0) {
      // Allowed: capture the pre-image for `axiom undo` and remember who is writing what.
      if (profile.undo) {
        await captureUndo(rootReal, {
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          agentId,
          tool: payload.toolName,
          targets: sessionTargets,
        });
      }
      if (profile.sessions !== undefined) {
        await recordSessionWrite({
          root: rootReal,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          agentId,
          tool: payload.toolName,
          targets: sessionTargets,
        });
      }
    }
    let hint: string | undefined;
    if (
      extracted.cls === "write" &&
      profile.steer !== "off" &&
      payload.sessionId !== undefined &&
      HINT_FORMATS.has(format) &&
      (await claimSessionHint(rootReal, payload.sessionId))
    ) {
      hint = GATE_STEER_HINT;
    }
    if (warnings.length > 0) {
      const w = warnings.join("\n");
      hint = hint === undefined ? w : `${w}\n${hint}`;
    }
    return recorded(allow(`${n} target(s) passed (${extracted.cls})`, hint));
  } catch (err) {
    if (err instanceof GateDeny) return recorded(deny(err));
    if (err instanceof GateProfileError) {
      // A broken / too-new profile is never covered by --fail-open: failing open here would
      // silently switch the gate off (P0-11).
      return deny(new GateDeny(err.code, err.message));
    }
    return recorded(internal(err instanceof Error ? err.message : String(err)));
  }
}

// ------------------------------------------------------------------- cli --

export const GATE_USAGE =
  "usage: axiom gate --stdin [--post] [--root <dir>] [--profile <file>] [--fail-open] [--no-shell-scan] [--no-root-discovery] [--track-reads] [--deny-exit 0|2] [--format auto|claude|copilot|vscode|codex|cursor|windsurf|gemini|junie|cline] [--log-level error|warn|info|debug]";

function usageError(why: string, t0: number, format: GateFormat): GateResult {
  return {
    decision: "deny",
    verdict: "deny",
    exitCode: GATE_EXIT_DENY,
    reason: why,
    // Cline ignores exit codes: only a cancel document stops the tool.
    ...(format === "cline"
      ? { stdout: JSON.stringify({ cancel: true, errorMessage: `AXIOM GATE ERROR: ${why}` }) }
      : {}),
    stderr: [`AXIOM GATE ERROR: ${why}`, GATE_USAGE],
    durationMs: performance.now() - t0,
  };
}

/**
 * `axiom gate <argv>` → result. Reads stdin only when `--stdin` is given — unless `io.read`
 * carries a payload the caller already read (the `cli.ts` fast path). Never throws.
 */
export async function gateMain(
  argv: readonly string[],
  io: {
    stdin?: NodeJS.ReadableStream;
    read?: StdinRead;
    cwdFallback?: () => string;
    home?: string;
  } = {},
): Promise<GateResult> {
  const t0 = performance.now();
  // Scanned before parseArgs so even an argv error answers in the harness's own format.
  const argvFormat = formatFromArgv(argv);
  if (argv.includes("--post")) {
    // PostToolUse (S-1205): its own module, always exit 0 — a post hook cannot stop a tool.
    const read = io.read ?? (await readStdin(io.stdin ?? process.stdin));
    return postMain(argv, {
      read,
      ...(io.cwdFallback === undefined ? {} : { cwdFallback: io.cwdFallback }),
      ...(io.home === undefined ? {} : { home: io.home }),
    });
  }
  let values: {
    stdin?: boolean;
    root?: string;
    profile?: string;
    strict?: boolean;
    "fail-open"?: boolean;
    "no-shell-scan"?: boolean;
    "no-root-discovery"?: boolean;
    "track-reads"?: boolean;
    "deny-exit"?: string;
    format?: string;
    "log-level"?: string;
  };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        stdin: { type: "boolean" },
        root: { type: "string" },
        profile: { type: "string" },
        // 2.1 flag; fail-closed is now the default so this is accepted and ignored.
        strict: { type: "boolean" },
        "fail-open": { type: "boolean" },
        "no-shell-scan": { type: "boolean" },
        "no-root-discovery": { type: "boolean" },
        "track-reads": { type: "boolean" },
        "deny-exit": { type: "string" },
        format: { type: "string" },
        "log-level": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err), t0, argvFormat);
  }
  const denyExitRaw = values["deny-exit"];
  const formatRaw = values.format;
  if (formatRaw !== undefined && !isGateFormat(formatRaw))
    return usageError(`--format must be one of ${GATE_FORMATS.join("|")}`, t0, argvFormat);
  const format: GateFormat = formatRaw ?? "auto";
  if (values.stdin !== true) return usageError("--stdin is required", t0, format);
  if (denyExitRaw !== undefined && !["0", "2"].includes(denyExitRaw))
    return usageError("--deny-exit must be 0 or 2", t0, format);
  const levelRaw = values["log-level"] ?? "warn";
  const logLevel: GateLogLevel = (GATE_LOG_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as GateLogLevel)
    : "warn";
  const read = io.read ?? (await readStdin(io.stdin ?? process.stdin));
  const opts: GateOptions = { logLevel, format };
  if (denyExitRaw !== undefined) opts.denyExit = denyExitRaw === "2" ? 2 : 0;
  if (values.root !== undefined) opts.root = values.root;
  if (values.profile !== undefined) opts.profilePath = values.profile;
  if (values.strict === true) opts.strict = true;
  if (values["fail-open"] === true) opts.failOpen = true;
  if (values["no-shell-scan"] === true) opts.noShellScan = true;
  if (values["no-root-discovery"] === true) opts.noRootDiscovery = true;
  if (values["track-reads"] === true) opts.trackReads = true;
  if (io.cwdFallback !== undefined) opts.cwdFallback = io.cwdFallback;
  if (io.home !== undefined) opts.home = io.home;
  if (read.tooLarge) {
    // An oversize payload IS an agent action (a huge write): never fail open on it unless the
    // operator asked for --fail-open.
    const r = await runGate(undefined, { ...opts, stdinTooLarge: true });
    r.stderr.unshift(`AXIOM GATE WARN: stdin exceeded ${GATE_STDIN_MAX_BYTES} bytes`);
    return r;
  }
  return runGate(read.text, opts);
}
