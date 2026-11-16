/**
 * Zero-dependency prefilter for `axiom gate --stdin` (2.4.1).
 *
 * Measured in production (codai, 2026-10-07..14, 2624 VS Code hook runs): p50 603 ms, p95 1.3 s,
 * 10 runs over the 5 s hook timeout (= the harness fails open). Copilot CLI and VS Code have no
 * matcher, so the hook fires on EVERY tool call and ~90 % of them are read-only tools that the
 * gate allows without looking. Loading the gate chunk (zod + checks, ~290 KB) costs ~85 ms on
 * top of node's own start; this module answers those calls from `cli.ts` without loading it.
 *
 * Exactness: it must never allow a call the full gate would judge. The tool classification
 * lives HERE and gate.ts imports it (one source, no drift); `fastAllow` answers `allow` only
 * for a payload whose tool is classified `other` AND either names a read-only tool or carries
 * no path-like value — the cases where `runGate` returns allow before touching the filesystem.
 * Anything else — no payload, invalid JSON, no tool name, a path-like value anywhere, a write
 * or shell tool — is handed to the full gate unchanged (A2-3: the old "any unknown name is
 * `other`" rule let `mcp__fs__put {path:".env"}` through unjudged).
 */

export const GATE_STDIN_MAX_BYTES = 4 * 1024 * 1024;
export const GATE_STDIN_TIMEOUT_MS = 2_000;

export const WRITE_TOOL_HINTS = [
  "write",
  "edit",
  "create_file",
  "create",
  "replace_string",
  "replace",
  "insert_edit",
  "apply_patch",
  "notebook",
  "delete",
  "rename",
  "move",
  "mkdir",
  // A2-3: tools that write files but carried no hint, so they were classified `other` and the
  // fast path allowed them. A false "write" only costs a gate run; a false "other" is a hole.
  "save",
  "update",
  "patch",
  "touch",
  "append",
  "copy",
  // Same class (A2-3 probe list): these write the path they name and were classed `other`.
  "download",
  "editor",
] as const;
/**
 * Write hints that win over every read-only hint: `search_replace` (Cursor), `delete_directory`,
 * `multi_replace_string_in_file`. A false "write" costs a gate run; a false "other" is a hole.
 */
export const WRITE_OVERRIDE_HINTS = [
  "apply_patch",
  "replace",
  "delete",
  "rename",
  "move",
  "mkdir",
  "create_directory",
] as const;
/** Substrings that mark a tool as read-only even when a write hint also matches (`create_directory`, …). */
export const NON_WRITE_HINTS = [
  "read",
  "list",
  "search",
  "grep",
  "glob",
  "view",
  "directory",
  "dir",
] as const;
/** Tools that execute a shell command; matched case-insensitively by substring. */
export const SHELL_TOOL_HINTS = [
  "bash",
  "shell",
  "run_in_terminal",
  "terminal",
  "execute_command",
  "exec_command",
  "run_command",
  "powershell",
  "cmd",
  "create_and_run_task",
  "run_task",
  // HN-6: Devin `exec`, Kiro `execute_pwsh` (a Windows shell) and every `execute_*` runner.
  "exec",
  "pwsh",
] as const;
export const TOOL_NAME_KEYS = ["tool_name", "toolName", "tool", "name"] as const;

export type ToolClass = "write" | "shell" | "other";

/**
 * A2-3: `mcp__fs__put`, `put_file` — a write whose name carries no other hint. Segment-anchored
 * so the `put` inside `get_terminal_output` (`out`+`put`) never matches.
 */
const PUT_TOOL_RE = /(^|[_.:-])put([_.:-]|$)/i;

export function isWriteTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  if (!WRITE_TOOL_HINTS.some((h) => n.includes(h)) && !PUT_TOOL_RE.test(n)) return false;
  if (WRITE_OVERRIDE_HINTS.some((h) => n.includes(h))) return true;
  return !NON_WRITE_HINTS.some((h) => n.includes(h));
}

export function isShellTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return SHELL_TOOL_HINTS.some((h) => n.includes(h));
}

/** Task runners execute a shell command even though their names contain write hints. */
const TASK_TOOL_RE = /(^|[_.:-])(create_and_run_task|run_task)$/i;

/**
 * OPS-12: read-only tools whose name contains a shell hint (`terminal`) and a terminal-killing
 * tool. They are classed `other`, so they cost no full-gate run and are not journaled.
 */
const SHELL_EXEMPT_TOOL_RE =
  /(^|[_.:-])(get_?terminal_?output|kill_?terminal|terminal_?last_?command|terminal_?selection)$/i;

/**
 * OPS-12: tools seen in the field that have SIDE EFFECTS but no file path, so the fast path
 * allowed them without a journal line. Classed `write`: the full gate runs, and because the
 * input carries no path-like value they are reported as `noTarget` (allow + journal).
 */
export const SIDE_EFFECT_TOOL_RE =
  /(^|[_.:-])(run_?subagent|run_?playwright_?code|manage_?todo_?list|memory)$/i;

export function classifyTool(toolName: string): ToolClass {
  if (TASK_TOOL_RE.test(toolName)) return "shell";
  if (SHELL_EXEMPT_TOOL_RE.test(toolName)) return "other";
  // HN-5/QA-12/PM-5: AXIOM's own MCP tools are judged (and never denied for lack of a path).
  if (isAxiomToolName(toolName)) return "write";
  if (isWriteTool(toolName) || SIDE_EFFECT_TOOL_RE.test(toolName)) return "write";
  if (isShellTool(toolName)) return "shell";
  return "other";
}

/**
 * A2-3: tools whose only effect is reading. `fastAllow` short-circuits these even when they
 * carry a path (`Read { file_path }` is the common case). Every name here must classify as
 * `other`, so allowing it is exactly what `runGate` would do (a test pins that invariant).
 * Names are lower case and namespace-free (`read_notebook_cell_output`, not
 * `mcp_tools_read_notebook_cell_output`).
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "read_file",
  "read_text",
  "read_page",
  "read_notebook_cell_output",
  "get_screen",
  "get_errors",
  "get_task_output",
  "get_terminal_output",
  "list_dir",
  "list_directory",
  "list_code_usages",
  "list_windows",
  "terminal_last_command",
  "terminal_selection",
  "glob",
  "grep",
  "grep_search",
  "search",
  "file_search",
  "semantic_search",
  "fetch_webpage",
  "view_image",
  "view",
]);

/** `mcp__fs__read_file` / `mcp_axiom_axiom_read` → `read_file` / `read`. */
const MCP_NAMESPACE_RE = /^mcp[_-]{1,2}[a-z0-9-]+[_-]{1,2}/i;

export function bareToolName(toolName: string): string {
  return toolName.toLowerCase().replace(MCP_NAMESPACE_RE, "");
}

/**
 * AXIOM's own MCP tools in any of the name forms a harness produces (`axiom_write`,
 * `mcp_axiom_axiom_write`, `mcp__axiom__axiom_apply`). They are judged so `files[].path` is
 * checked, and a call with no path is `noTarget` — never `ERR_UNSUPPORTED_OP` (HN-5/QA-12).
 */
export function isAxiomToolName(toolName: string): boolean {
  return bareToolName(toolName).startsWith("axiom");
}

/**
 * Keys whose string value names something on disk, kept here so `fastAllow` stays
 * dependency-free and the payload extractor and the fast path cannot drift.
 *
 * `PRIMARY` is the path a write tool touches — for a move/rename it is the SOURCE that
 * disappears (A2-2). `SOURCE` is the origin of a move/rename, `DEST` the destination of a
 * move/rename or the second path of a write. Every one of them is judged.
 */
export const PATH_PRIMARY_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
  "file",
  "uri",
  "dirPath",
  "dir_path",
  "paths",
  "pathInProject",
] as const;
export const PATH_SOURCE_KEYS = [
  "oldPath",
  "old_path",
  "oldFilePath",
  "old_file_path",
  "from",
  "source",
  "source_path",
  "sourcePath",
] as const;
export const PATH_DEST_KEYS = [
  "newPath",
  "new_path",
  "newFilePath",
  "new_file_path",
  "destination",
  "destination_path",
  "destinationPath",
  "target",
  "target_path",
  "targetPath",
  "to",
] as const;
export const PATH_VALUE_KEYS = [
  ...PATH_PRIMARY_KEYS,
  ...PATH_SOURCE_KEYS,
  ...PATH_DEST_KEYS,
] as const;

const PATH_VALUE_KEY_SET: ReadonlySet<string> = new Set(PATH_VALUE_KEYS);
/** A payload this deep is not a tool call we can reason about; stop and let the gate judge it. */
const PATH_SCAN_MAX_DEPTH = 6;

/**
 * `true` = some string under a path-like key exists anywhere in `value` (objects and arrays
 * included). Bounded: an unusually deep payload returns `true` (defer to the gate).
 */
export function carriesPathValue(value: unknown, depth = 0): boolean {
  if (depth > PATH_SCAN_MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => carriesPathValue(v, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  for (const [k, v] of Object.entries(value)) {
    if (PATH_VALUE_KEY_SET.has(k)) {
      if (typeof v === "string") {
        if (v.length > 0) return true;
      } else if (v !== undefined && v !== null) {
        // A path key holding something that is not a path is a write we cannot parse: defer.
        return true;
      }
    }
    if (typeof v === "object" && v !== null && carriesPathValue(v, depth + 1)) return true;
  }
  return false;
}

/**
 * `true` = the full gate would certainly allow this payload. Two cases only (A2-3):
 * an explicit read-only tool, or a payload that carries NO path-like value AND whose tool is
 * not a write/shell tool (so `runGate` returns allow at the `other` branch). Anything else —
 * no payload, invalid JSON, no tool name, any path-like value, write or shell tool — goes to
 * the full gate unchanged. Never throws.
 */
export function fastAllow(payloadText: string | undefined): boolean {
  if (payloadText === undefined || payloadText.length === 0) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  let toolName: string | undefined;
  for (const k of TOOL_NAME_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      toolName = v;
      break;
    }
  }
  if (toolName === undefined) return false;
  if (classifyTool(toolName) !== "other") return false;
  // A read-only tool is allowed whatever it carries; for everything else a path-like value
  // means the gate must resolve it (a mis-classified MCP writer must not be short-circuited).
  return READ_ONLY_TOOL_NAMES.has(bareToolName(toolName)) || !carriesPathValue(obj);
}

// ---------------------------------------------------------------- formats --

/** `axiom gate --format <f>`: the stdout/exit contract of each harness (Phase 8). */
export const GATE_FORMATS = [
  "auto",
  "claude",
  "copilot",
  "vscode",
  "codex",
  "cursor",
  "windsurf",
  "gemini",
  "junie",
  "cline",
  "kiro",
] as const;
export type GateFormat = (typeof GATE_FORMATS)[number];

export function isGateFormat(v: string): v is GateFormat {
  return (GATE_FORMATS as readonly string[]).includes(v);
}

/** `--format X` / `--format=X` from argv; absent or unknown → `auto`. Never throws. */
export function formatFromArgv(argv: readonly string[]): GateFormat {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    let v: string | undefined;
    if (a === "--format") v = argv[i + 1];
    else if (a.startsWith("--format=")) v = a.slice("--format=".length);
    else continue;
    return v !== undefined && isGateFormat(v) ? v : "auto";
  }
  return "auto";
}

/**
 * What an ALLOW must print for `format` (undefined = nothing). Cursor's `failClosed` treats an
 * empty hook output as a failure, so it needs an explicit `{"permission":"allow"}`.
 */
export function allowStdout(format: GateFormat): string | undefined {
  return format === "cursor" ? '{"permission":"allow"}' : undefined;
}

export interface StdinRead {
  text: string | undefined;
  timedOut: boolean;
  tooLarge: boolean;
  /**
   * 4.0 contract: bytes received (before a timeout, or in total). `readStdin` always sets it;
   * it stays optional so callers that build a `StdinRead` by hand keep type-checking.
   * 0 = the harness sent nothing.
   */
  bytes?: number;
}

/** Read all of `stream` (≤ maxBytes) or give up after `timeoutMs` — a hook must never hang. */
export function readStdin(
  stream: NodeJS.ReadableStream,
  { timeoutMs = GATE_STDIN_TIMEOUT_MS, maxBytes = GATE_STDIN_MAX_BYTES } = {},
): Promise<StdinRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: StdinRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      // A3-18/A2-17: `bytes` is what the gate needs to tell a harness hiccup (a timeout with
      // nothing received -> allow + warn) from a truncated write (bytes received -> fail closed).
      resolve({ ...r, bytes: size });
    };
    const timer = setTimeout(
      () => finish({ text: undefined, timedOut: true, tooLarge: false }),
      timeoutMs,
    );
    timer.unref?.();
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c, "utf8") : c;
      size += b.length;
      if (size > maxBytes) {
        finish({ text: undefined, timedOut: false, tooLarge: true });
        return;
      }
      chunks.push(b);
    });
    stream.on("end", () =>
      finish({ text: Buffer.concat(chunks).toString("utf8"), timedOut: false, tooLarge: false }),
    );
    stream.on("error", () => finish({ text: undefined, timedOut: false, tooLarge: false }));
    stream.resume();
  });
}
