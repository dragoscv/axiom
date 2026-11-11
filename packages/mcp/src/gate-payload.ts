/** Harness payload normalisation and write-target extraction (moved out of gate.ts in 4.0). */
import { classifyTool, TOOL_NAME_KEYS, type ToolClass } from "./gate-fast.js";
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

export const PATH_KEYS = [
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
] as const;

/** Tools that write files, matched case-insensitively by substring. */
export const SHELL_COMMAND_KEYS = [
  "command",
  "cmd",
  "script",
  "commandLine",
  "command_line",
] as const;

/** Shell command as a string; Codex sends `command` as an argv array (joined with spaces). */
export function commandString(input: Record<string, unknown>): string | undefined {
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

export function extractWriteTargets(p: NormalizedPayload): GateTarget[] {
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
