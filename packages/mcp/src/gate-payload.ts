/** Harness payload normalisation and write-target extraction (moved out of gate.ts in 4.0). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  carriesPathValue,
  classifyTool,
  isAxiomToolName,
  isShellTool,
  PATH_DEST_KEYS,
  PATH_PRIMARY_KEYS,
  PATH_SOURCE_KEYS,
  SIDE_EFFECT_TOOL_RE,
  TOOL_NAME_KEYS,
  type ToolClass,
} from "./gate-fast.js";
import { extractShellWriteTargets, type GateTarget } from "./shell-targets.js";

// ---------------------------------------------------------------- payload --

export interface NormalizedPayload {
  toolName: string;
  cwd: string | undefined;
  input: Record<string, unknown>;
  /** Agent session id when the harness sends one (hint once-per-session, decision journal). */
  sessionId?: string;
  /** Harness recognised from the payload shape alone (`cursor`, `windsurf`, `cline`). */
  harness?: string;
  /**
   * 4.0 contract: working directory the TOOL INPUT names for a shell command
   * (`working_directory`, `workdir`, `cwd` inside the input). Relative shell operands resolve
   * against it instead of the payload cwd.
   */
  commandCwd?: string;
  /**
   * 4.0 contract (A2-18): a payload that IS a hook tool call but names no tool (`tool_name: ""`,
   * a Kiro `{toolUse}`, an OpenCode `{tool,args}`). `normalizePayload` returns it instead of
   * `undefined` so the gate can warn + journal it when `--format` was given (and deny it for
   * exit-code-only formats). `toolName` is `""`; nothing else may be inferred from this flag.
   */
  unknownTool?: true;
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function firstString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export const SESSION_KEYS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "trajectory_id",
  "taskId",
  "generation_id",
] as const;
export const CWD_KEYS = ["cwd", "workingDirectory", "working_directory"] as const;
/** Keys naming a working directory INSIDE the tool input (A2-25: `commandCwd`). */
export const COMMAND_CWD_KEYS = ["working_directory", "workdir", "cwd"] as const;

/** `commandCwd` = the cwd the tool input names, when it names one. */
function withCommandCwd(
  input: Record<string, unknown>,
  cwd: string | undefined,
): { commandCwd?: string } {
  const named = firstString(input, COMMAND_CWD_KEYS);
  if (named === undefined || named === cwd) return {};
  return { commandCwd: named };
}

/** An object, or a JSON string that parses to one. */
export function parseRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string") return asRecord(v);
  try {
    return asRecord(JSON.parse(v));
  } catch {
    return undefined;
  }
}

export function firstArrayString(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  const f: unknown = v[0];
  return typeof f === "string" && f.length > 0 ? f : undefined;
}

export function withMeta(
  p: NormalizedPayload,
  obj: Record<string, unknown>,
  harness: string | undefined,
): NormalizedPayload {
  const sessionId = firstString(obj, SESSION_KEYS);
  return {
    ...p,
    ...withCommandCwd(p.input, p.cwd),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(harness === undefined ? {} : { harness }),
  };
}

/** Cline: every parameter value may arrive JSON-stringified; keep the raw string otherwise. */
export function clineParams(params: Record<string, unknown>): Record<string, unknown> {
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
export function normalizeNamelessPayload(
  obj: Record<string, unknown>,
): NormalizedPayload | undefined {
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
  return nestedToolCall(obj);
}

/**
 * A2-18: shapes that put the tool name and its arguments ONE LEVEL DOWN — Kiro
 * `{toolUse:{name,input}}`, Gemini CLI `{toolCall:{name,args}}`, OpenCode `{tool:{id},args}`.
 * Recognising them is what keeps the "no tool name" path a last resort instead of a hole.
 */
function nestedToolCall(obj: Record<string, unknown>): NormalizedPayload | undefined {
  const toolUse = asRecord(obj.toolUse);
  const toolCall = asRecord(obj.toolCall);
  const toolObj = asRecord(obj.tool);
  const carrier = toolUse ?? toolCall ?? toolObj;
  if (carrier === undefined) return undefined;
  const name = firstString(carrier, ["name", "tool_name", "toolName", "id"]);
  if (name === undefined) return undefined;
  const input =
    parseRecord(carrier.input) ??
    parseRecord(carrier.arguments) ??
    parseRecord(carrier.args) ??
    parseRecord(obj.arguments) ??
    parseRecord(obj.args) ??
    {};
  const cwd =
    firstString(obj, CWD_KEYS) ??
    firstString(carrier, CWD_KEYS) ??
    firstArrayString(obj.workspace_roots);
  const harness = toolUse !== undefined ? "kiro" : toolCall !== undefined ? "gemini" : "opencode";
  return withMeta({ toolName: name, cwd, input }, obj, harness);
}

/**
 * Keys that mark an object as a hook TOOL CALL even when the tool name itself is missing or not
 * a string (A2-18): a Kiro `{toolUse}`, an OpenCode `{tool,args}`, a Gemini `{toolCall}`, a
 * Claude `{tool_name: ""}`, a Cline `{preToolUse}`. A bare `{cwd}` — or a hook event such as
 * `{hook_event_name:"Stop"}` with no tool arguments — is NOT a tool call.
 */
const HOOK_PAYLOAD_KEYS = [
  "tool_input",
  "toolInput",
  "toolArgs",
  "tool_args",
  "args",
  "input",
  "toolUse",
  "toolCall",
  "agent_action_name",
  "preToolUse",
] as const;

/**
 * A2-18: a payload that is a tool call but names no tool. Returned (with `unknownTool: true`)
 * instead of `undefined` so gate.ts can warn and journal it when `--format` was explicit, and
 * deny it for exit-code-only formats. `undefined` stays for objects that are not tool calls.
 */
function unnamedHookPayload(obj: Record<string, unknown>): NormalizedPayload | undefined {
  if (!HOOK_PAYLOAD_KEYS.some((k) => obj[k] !== undefined)) return undefined;
  const input =
    parseRecord(obj.tool_input) ??
    parseRecord(obj.toolInput) ??
    parseRecord(obj.toolArgs) ??
    parseRecord(obj.tool_args) ??
    parseRecord(obj.args) ??
    parseRecord(obj.input) ??
    {};
  const cwd = firstString(obj, CWD_KEYS) ?? firstArrayString(obj.workspace_roots);
  return { toolName: "", cwd, input, unknownTool: true };
}

/**
 * Accept Claude Code / Codex / Junie / Gemini CLI (`{session_id, tool_name, tool_input, cwd}`),
 * Copilot CLI camelCase (`{sessionId, toolName, toolArgs, cwd}` — `toolArgs` arrives as a JSON
 * *string*), the VS Code shape (`tool_input` object), Cursor (`workspace_roots` cwd fallback),
 * Windsurf, Cline and Cursor shell payloads. Returns `undefined` for anything that is not a
 * tool call, and an `unknownTool` payload for a hook payload whose tool name is missing (A2-18).
 */
export function normalizePayload(raw: unknown): NormalizedPayload | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;
  // The top-level tool name wins (same keys as the fast path, so `fastAllow` stays exact).
  const toolName = firstString(obj, TOOL_NAME_KEYS);
  if (toolName === undefined) return normalizeNamelessPayload(obj) ?? unnamedHookPayload(obj);
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

/**
 * Every path-like key (A2-2), primary first, then destinations, then the sources of a
 * move/rename. `gate.ts` builds its "no recognised path key" message from this list, and
 * `trackRead` reads the FIRST value for a read-only tool.
 */
export const PATH_KEYS = [...PATH_PRIMARY_KEYS, ...PATH_DEST_KEYS, ...PATH_SOURCE_KEYS] as const;
export const CONTENT_KEYS = [
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
  // A2-15: content that arrived unscanned because the key was not known here.
  "contents",
  "code_edit",
  "codeEdit",
  "data",
  "insert_text",
  "insertText",
  "newText",
  "new_text",
] as const;

/** Shell command keys; `input` is terminal stdin (`send_terminal_input`, `write_bash`). */
export const SHELL_COMMAND_KEYS = [
  "command",
  "cmd",
  "script",
  "commandLine",
  "command_line",
  "input",
] as const;

/** Keys naming the folder a `run_task` id lives in. */
const TASK_FOLDER_KEYS = ["workspaceFolder", "workspace_folder", "folder", "root"] as const;

/**
 * POSIX-quote one argv element so joining an argv keeps a nested script ONE argument (A2-9):
 * `[bash,-lc,'git push --force']` must read as `bash -lc 'git push --force'`, never as
 * `bash -lc git push --force` (which hides the command unit from the shell scan and the rules).
 */
function quoteArgvElement(a: string): string {
  if (a.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a;
  return `'${a.replace(/'/g, "'\\''")}'`;
}

export function joinArgv(argv: readonly string[]): string {
  return argv.map(quoteArgvElement).join(" ");
}

/** `file:///E:/x/a.ts` → `E:\x\a.ts`; anything else is returned unchanged (A2-16). */
export function decodePathValue(v: string): string {
  if (!/^file:/i.test(v)) return v;
  try {
    return fileURLToPath(v);
  } catch {
    return v.replace(/^file:\/{0,3}/i, "");
  }
}

/** A path key may hold one path or an array of them (`paths: [".env", "src/a.ts"]`). */
export function pathValues(v: unknown): string[] {
  if (typeof v === "string") return v.length > 0 ? [decodePathValue(v)] : [];
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string" && x.length > 0).map(decodePathValue);
  return [];
}

/** The `command` + `args` line of one `.vscode/tasks.json` task. */
function taskCommandLine(task: Record<string, unknown>): string | undefined {
  const command = task.command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  const args = Array.isArray(task.args) ? task.args.filter((a) => typeof a === "string") : [];
  // A task is run by a shell (`type: "shell"` is the default), so the line is joined raw: the
  // scan must see the `>` / `&&` the shell will act on.
  return [command, ...args].join(" ");
}

/**
 * A2-25: `run_task {id}` names a task by label, not a command. Resolve it through the
 * repository's `.vscode/tasks.json` (and its `dependsOn`) so the shell scan and the rules see
 * the command the harness is about to run. Silent on any read/parse failure (no tasks file, a
 * JSONC file npm would reject, a label that does not match): the gate then judges what it has.
 */
export function taskCommandsFromJson(dir: string | undefined, id: string): string[] {
  if (dir === undefined || id.length === 0) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path.join(dir, ".vscode", "tasks.json"), "utf8"));
  } catch {
    return [];
  }
  const tasks = Array.isArray(asRecord(doc)?.tasks) ? (asRecord(doc)?.tasks as unknown[]) : [];
  const byLabel = new Map<string, Record<string, unknown>>();
  for (const t of tasks) {
    const rec = asRecord(t);
    if (rec === undefined) continue;
    if (typeof rec.label === "string") byLabel.set(rec.label, rec);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (label: string, depth: number): void => {
    if (depth > 2 || out.length >= 8 || seen.has(label)) return;
    seen.add(label);
    const task = byLabel.get(label);
    if (task === undefined) return;
    const line = taskCommandLine(task);
    if (line !== undefined) out.push(line);
    const dep = task.dependsOn;
    for (const d of Array.isArray(dep) ? dep : [dep]) {
      if (typeof d === "string") walk(d, depth + 1);
    }
  };
  walk(id, 0);
  // VS Code ids are `shell: <label>` / `<folder>: <label>` as well as the bare label.
  if (out.length === 0) {
    for (const [label] of byLabel) {
      if (id === label || id.endsWith(`: ${label}`)) walk(label, 0);
    }
  }
  return out;
}

/** The commands a `.vscode/tasks.json` WRITE stages: its content is a command source (A2-25). */
function tasksJsonWriteCommands(input: Record<string, unknown>): string[] {
  const rawPath = firstString(input, PATH_KEYS);
  if (rawPath === undefined) return [];
  if (path.basename(decodePathValue(rawPath)) !== "tasks.json") return [];
  const content = firstString(input, CONTENT_KEYS);
  if (content === undefined) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  const tasks = Array.isArray(asRecord(doc)?.tasks) ? (asRecord(doc)?.tasks as unknown[]) : [];
  const out: string[] = [];
  for (const t of tasks) {
    const rec = asRecord(t);
    if (rec === undefined) continue;
    const line = taskCommandLine(rec);
    if (line !== undefined) out.push(line);
  }
  return out;
}

/**
 * Shell command as a string. Codex sends `command` as an argv array (each element quoted when
 * joined, A2-9); VS Code `create_and_run_task` sends `{ task: { command, args } }`; a `run_task`
 * id is resolved through `.vscode/tasks.json`; a write of that file is a command source too.
 */
export function commandString(
  input: Record<string, unknown>,
  opts: { cwd?: string } = {},
): string | undefined {
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
      const joined = joinArgv(v as string[]);
      if (joined.trim().length > 0) return joined;
    }
  }
  const id = firstString(input, ["id", "label", "taskId", "task_id"]);
  if (id !== undefined) {
    const dir =
      opts.cwd ??
      firstString(input, TASK_FOLDER_KEYS) ??
      firstString(input, COMMAND_CWD_KEYS) ??
      // Last resort, same contract as gate.ts's cwdFallback: the hook runs in the project
      // directory. `extractTargets` always passes the payload cwd, so this only fires for a
      // caller that has none.
      process.cwd();
    const resolved = taskCommandsFromJson(dir, id);
    if (resolved.length > 0) return resolved.join(" && ");
  }
  const staged = tasksJsonWriteCommands(input);
  if (staged.length > 0) return staged.join(" && ");
  return undefined;
}

export const PATCH_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/;
export const PATCH_MOVE = /^\*\*\* Move to: (.+?)\s*$/;

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

export function joinContent(parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => typeof p === "string");
  return present.length === 0 ? undefined : present.join("\n");
}

/** A2-15: stop after this many content strings — a payload with more is not a tool call we need. */
const CONTENT_PART_MAX = 200;
/** Keys holding an ARRAY of edits, each with its own content (`{ edits: [{ new_string }] }`). */
const EDIT_KEYS = ["edits", "replacements", "changes"] as const;

/**
 * Every new-content string the payload carries (A2-15): any content key, a string ARRAY under one
 * (`newCode: [...]`), the same inside `edits` / `replacements`, and one level into an object
 * (`data: { … }`). Joined with newlines for the content predicates to scan.
 */
export function gatherContent(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const add = (v: unknown, depth: number): void => {
    if (parts.length >= CONTENT_PART_MAX) return;
    if (typeof v === "string") {
      if (v.length > 0) parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) add(x, depth + 1);
      return;
    }
    if (typeof v === "object" && v !== null && depth < 2) {
      for (const x of Object.values(v)) add(x, depth + 1);
      return;
    }
  };
  for (const k of CONTENT_KEYS) add(input[k], 0);
  for (const k of EDIT_KEYS) {
    const arr = input[k];
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      const rec = asRecord(e);
      if (rec === undefined) continue;
      for (const ck of CONTENT_KEYS) add(rec[ck], 0);
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** `true` when the tool name says the path it names disappears (`delete`, `rm`, `unlink`, …). */
const DELETE_NAME_RE = /(^|[_.:-])(delete|remove|unlink|trash|rm)([_.:-]|$)/i;
/** A move/rename: its SOURCE is a delete (A2-2). `remove`/`improve` do not match (no boundary). */
const MOVE_NAME_RE = /(^|[_.:-])(rename|move|mv)/i;
/** Codex `apply_patch`: `command`/`input`/`diff` is a V4A body, never a shell command. */
const V4A_PATCH_RE = /apply_?patch/i;
/** A patch-shaped tool: an unparseable body stays `undetermined`, never a shell command (D-18). */
const PATCH_TOOL_RE = /(apply_?patch|multi_?replace)/i;

/** Name segments a tool that writes by PATH contains (`create_file`, `NotebookEdit`, `fs_append`). */
const FILE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "delete",
  "replace",
  "insert",
  "patch",
  "touch",
  "save",
  "put",
  "append",
  "copy",
  "rename",
  "move",
  "mv",
  "mkdir",
  "rm",
  "unlink",
  "truncate",
  "file",
  "path",
  "dir",
  "directory",
]);

/** A tool name in segments: split on separators AND camelCase (`vscode_renameSymbol`). */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

/** Does the input carry new content for a file at all? */
function hasNewContent(input: Record<string, unknown>): boolean {
  if (CONTENT_KEYS.some((k) => input[k] !== undefined)) return true;
  return EDIT_KEYS.some((k) => Array.isArray(input[k]) && input[k].length > 0);
}

/** `Delete`, `mkdir`, `create_file`, `NotebookEdit` — a tool that writes by path, not by id. */
function isFilePathTool(name: string): boolean {
  return nameSegments(name).some((s) => FILE_PATH_SEGMENTS.has(s));
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
  /**
   * 4.0 contract: write-NAMED tool whose input carries no path-like value at all
   * (`create_issue`, `TodoWrite`, …): nothing on disk to judge. The gate core allows it and
   * journals it; `undetermined` stays for inputs that look like a file write it cannot parse.
   */
  noTarget?: boolean;
  /**
   * 4.0 contract: the shell command this payload implies, when it implies one — the inline
   * string/argv, a `run_task` id resolved through `.vscode/tasks.json`, or the commands a
   * `.vscode/tasks.json` write stages. The joined, quoted form is what the shell scan and the
   * command rules must see (A2-9/A2-25).
   */
  command?: string;
}

/**
 * Extract every write target (+ new content) from a normalised payload.
 *
 * Class precedence: `other` is allowed untouched; a side-effecting tool with no file path is
 * `noTarget`; a write whose input carries a command (or that WRITES `.vscode/tasks.json`) is a
 * shell payload; a write with no target and no path-like value is `noTarget`, with a path-like
 * value it stays `undetermined` (D-18).
 */
export function extractTargets(p: NormalizedPayload): Extracted {
  const cls = classifyTool(p.toolName);
  if (cls === "other") return { cls, targets: [], undetermined: false };
  // OPS-12: these have side effects but keep no file path (`memory` writes a virtual store);
  // they are judged (journalled as `noTarget`) instead of being fast-allowed in silence.
  if (SIDE_EFFECT_TOOL_RE.test(p.toolName)) {
    return { cls: "write", targets: [], undetermined: false, noTarget: true };
  }
  const cwd = p.commandCwd ?? p.cwd;
  const cwdOpt = cwd === undefined ? {} : { cwd };
  if (cls === "shell") {
    const command = commandString(p.input, cwdOpt);
    // A shell tool without a recognisable command string carries nothing we can judge; it is
    // not a write tool, so it is allowed (the scan is a heuristic seatbelt, not the gate).
    if (command === undefined) return { cls, targets: [], undetermined: false };
    return { cls, targets: extractShellWriteTargets(command), undetermined: false, command };
  }
  const targets = extractWriteTargets(p);
  // A `.vscode/tasks.json` write is also a command source: judge the file AND the commands it
  // stages, as a shell payload so the command rules see them (A2-25).
  if (tasksJsonWriteCommands(p.input).length > 0) {
    const command = commandString(p.input, cwdOpt);
    if (command === undefined) return { cls, targets, undetermined: false };
    return {
      cls: "shell",
      targets: [...targets, ...extractShellWriteTargets(command)],
      undetermined: false,
      command,
    };
  }
  if (targets.length > 0) return { cls, targets, undetermined: false };
  // A write-NAMED tool whose whole input is a command (`write_bash`, `write_powershell`) is a
  // shell tool: the command must be scanned and the rules must see it (HN-5/A2-25).
  if (!PATCH_TOOL_RE.test(p.toolName) && isShellTool(p.toolName)) {
    const command = commandString(p.input, cwdOpt);
    if (command !== undefined) {
      return {
        cls: "shell",
        targets: extractShellWriteTargets(command),
        undetermined: false,
        command,
      };
    }
  }
  // AXIOM's own tools carry a manifest (`bundle.artifacts[].path`), not a tool target: with
  // nothing to judge they are `noTarget`, never `undetermined` (HN-5: the gate must not deny
  // the tool its own hint recommends; axiom_apply re-checks the bundle itself).
  if (isAxiomToolName(p.toolName)) {
    return { cls, targets: [], undetermined: false, noTarget: true };
  }
  if (carriesPathValue(p.input)) return { cls, targets: [], undetermined: true };
  // D-18: a file tool that names neither a path we know nor any content is a write we cannot
  // parse (an empty `Delete {}`, `Write {output_location}`) — deny it. A write tool whose
  // arguments are simply not paths (`TodoWrite {todos}`, `create_issue {title}`,
  // `write_agent {prompt}`) writes nothing on disk: allow + journal (`noTarget`).
  if (isFilePathTool(p.toolName) && (Object.keys(p.input).length === 0 || hasNewContent(p.input))) {
    return { cls, targets: [], undetermined: true };
  }
  return { cls, targets: [], undetermined: false, noTarget: true };
}

/** `files: [{ path, op, content }]` — batch writers such as `axiom_write`. */
function fileObjectTargets(
  input: Record<string, unknown>,
  del: boolean,
  shared: string | undefined,
): GateTarget[] {
  const files = input.files;
  if (!Array.isArray(files)) return [];
  const out: GateTarget[] = [];
  for (const f of files) {
    const rec = asRecord(f);
    if (rec === undefined) continue;
    const raw = firstString(rec, PATH_KEYS);
    if (raw === undefined) continue;
    const declared = typeof rec.op === "string" ? rec.op.toLowerCase() : "";
    const op: "write" | "delete" = declared === "delete" || del ? "delete" : "write";
    out.push({
      rawPath: decodePathValue(raw),
      op,
      content: op === "write" ? (firstString(rec, CONTENT_KEYS) ?? shared) : undefined,
    });
  }
  return out;
}

/**
 * EVERY path-key value of the payload (A2-2): destinations are writes, the SOURCE of a
 * move/rename is a delete. Deletes never carry content; every write carries the payload's new
 * content so it is scanned at whichever path it lands.
 */
export function extractWriteTargets(p: NormalizedPayload): GateTarget[] {
  const n = p.toolName.toLowerCase();
  const input = p.input;

  if (V4A_PATCH_RE.test(n)) {
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

  const move = MOVE_NAME_RE.test(n);
  const del = DELETE_NAME_RE.test(n);
  const shared = gatherContent(input);
  const out: GateTarget[] = fileObjectTargets(input, del, shared);
  const seen = new Set(out.map((t) => `${t.op}:${t.rawPath}`));
  const push = (rawPath: string, op: "write" | "delete"): void => {
    if (rawPath.length === 0) return;
    const key = `${op}:${rawPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rawPath, op, content: op === "write" ? shared : undefined });
  };
  // The primary path: the file the tool touches, or the source of a move/rename.
  for (const k of PATH_PRIMARY_KEYS) {
    for (const v of pathValues(input[k])) push(v, move || del ? "delete" : "write");
  }
  // A destination is always a write.
  for (const k of PATH_DEST_KEYS) {
    for (const v of pathValues(input[k])) push(v, "write");
  }
  // `source`/`from`/`oldPath` name the thing that disappears — but only for a move/rename;
  // for a copy the source is read, not written, so it is not a target at all.
  if (move) {
    for (const k of PATH_SOURCE_KEYS) {
      for (const v of pathValues(input[k])) push(v, "delete");
    }
  }
  return out;
}
