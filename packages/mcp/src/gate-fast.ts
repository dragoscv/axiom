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
 * for a parseable payload whose tool name is classified `other` — exactly the case where
 * `runGate` returns allow before touching the filesystem. Anything else — no payload, invalid
 * JSON, no tool name, write or shell tool — is handed to the full gate unchanged.
 */

export const GATE_STDIN_MAX_BYTES = 4 * 1024 * 1024;
export const GATE_STDIN_TIMEOUT_MS = 2_000;

export const WRITE_TOOL_HINTS = [
  "write",
  "edit",
  "create_file",
  "create",
  "replace_string",
  "insert_edit",
  "apply_patch",
  "notebook",
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
] as const;
export const TOOL_NAME_KEYS = ["tool_name", "toolName", "tool", "name"] as const;

export type ToolClass = "write" | "shell" | "other";

export function isWriteTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  if (!WRITE_TOOL_HINTS.some((h) => n.includes(h))) return false;
  if (n.includes("apply_patch") || n.includes("multi_replace")) return true;
  return !NON_WRITE_HINTS.some((h) => n.includes(h));
}

export function isShellTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return SHELL_TOOL_HINTS.some((h) => n.includes(h));
}

export function classifyTool(toolName: string): ToolClass {
  if (isWriteTool(toolName)) return "write";
  if (isShellTool(toolName)) return "shell";
  return "other";
}

/**
 * `true` = the full gate would certainly allow this payload (a read-only tool). `false` = run
 * the full gate. Never throws.
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
  return classifyTool(toolName) === "other";
}

export interface StdinRead {
  text: string | undefined;
  timedOut: boolean;
  tooLarge: boolean;
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
      resolve(r);
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
