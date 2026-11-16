/**
 * Payload writer tests (S-1408) for `gate-fast.ts`: tool classification (A2-3, HN-6, OPS-12),
 * the exact fast path (A2-3) and `readStdin.bytes` (A2-17/A3-18).
 *
 * These live in their own file so the payload writer never edits `gate.test.ts` (integrator).
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runGate } from "./gate.js";
import {
  bareToolName,
  carriesPathValue,
  classifyTool,
  fastAllow,
  isWriteTool,
  READ_ONLY_TOOL_NAMES,
  readStdin,
} from "./gate-fast.js";

/** One hook payload, the shape every harness variant normalises to. */
function payload(tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({ tool_name: tool, tool_input: input, cwd: "/no/such/dir" });
}

describe("gate-fast: classification (A2-3, HN-6, OPS-12)", () => {
  it.each([
    // A2-3: writers whose name carried no hint were classified `other` and never judged.
    ["mcp__fs__put", "write"],
    ["put_file", "write"],
    ["copy_file", "write"],
    ["mcp__fs__copy_path", "write"],
    ["save_file", "write"],
    ["update_file", "write"],
    ["patch_file", "write"],
    ["touch_file", "write"],
    ["fsAppend", "write"],
    ["fs_append", "write"],
    ["append_file_text_by_path", "write"],
    ["str_replace_editor", "write"],
    // HN-6: shell tools the heuristics called `other`.
    ["exec", "shell"],
    ["execute_pwsh", "shell"],
    ["executePwsh", "shell"],
    ["execute_code", "shell"],
    ["execute_python", "shell"],
    // OPS-12: side effects with no path -> judged (journalled as noTarget), not fast-allowed.
    ["memory", "write"],
    ["runSubagent", "write"],
    ["run_playwright_code", "write"],
    ["manage_todo_list", "write"],
    // OPS-12: read-only tools that matched the `terminal` hint and paid for a full gate run.
    ["get_terminal_output", "other"],
    ["kill_terminal", "other"],
    ["terminal_last_command", "other"],
    ["terminal_selection", "other"],
  ])("classifyTool(%s) = %s", (name, cls) => {
    expect(classifyTool(name)).toBe(cls);
  });

  it("keeps the 3.0 classification of the names the harness really sends", () => {
    for (const name of ["Write", "Edit", "Delete", "apply_patch", "create_directory"]) {
      expect(classifyTool(name)).toBe("write");
    }
    for (const name of ["Bash", "run_in_terminal", "create_and_run_task", "run_task"]) {
      expect(classifyTool(name)).toBe("shell");
    }
    for (const name of ["Read", "read_file", "list_dir", "grep_search", "type_in_page"]) {
      expect(classifyTool(name)).toBe("other");
    }
    // `put` must not be found inside `out`+`put`.
    expect(isWriteTool("get_terminal_output")).toBe(false);
  });
});

describe("gate-fast: fastAllow is exact (A2-3)", () => {
  it.each([
    // a path-like value anywhere -> the full gate resolves it
    [payload("mcp__fs__put", { path: ".env", content: "A=1" }), false],
    [payload("copy_file", { source: "src/a.ts", destination: ".git/hooks/pre-commit" }), false],
    [payload("save_file", { path: ".env", content: "A=1" }), false],
    [payload("update_file", { path: ".env" }), false],
    [payload("patch_file", { path: ".env" }), false],
    [payload("touch_file", { path: ".env" }), false],
    [payload("fsAppend", { path: ".env", text: "A=1" }), false],
    [payload("mcp__fs__put", { files: [{ path: ".env" }] }), false],
    [payload("mcp__fs__put", { nested: { deep: { uri: "file:///etc/passwd" } } }), false],
    // write / shell named tool, no path key: still a gate decision (undetermined or noTarget)
    [payload("create_directory", {}), false],
    [payload("Delete", {}), false],
    [payload("TodoWrite", { todos: [] }), false],
    // OPS-12 side effects: journaled through the full gate, never silently allowed
    [payload("memory", { command: "create", path: "/memories/x.md" }), false],
    [payload("runSubagent", { prompt: "x" }), false],
    [payload("manage_todo_list", { todoList: [] }), false],
    [payload("run_playwright_code", { code: "x", pageId: "1" }), false],
    // read-only: allowed even with a path, exactly what the gate does
    [payload("Read", { file_path: ".env" }), true],
    [payload("read_file", { file_path: "src/a.ts" }), true],
    [payload("mcp__fs__read_file", { path: "src/a.ts" }), true],
    [payload("read_notebook_cell_output", { cellId: "1" }), true],
    [payload("view_image", { filePath: "x.png" }), true],
    // `other` with no path-like value anywhere
    [payload("type_in_page", { pageId: "1", text: "x" }), true],
    [payload("fetch_webpage", { url: "https://example.invalid/x" }), true],
    [payload("run_playwright_code", {}), false],
  ])("fastAllow(%s) = %s", (text, expected) => {
    expect(fastAllow(text)).toBe(expected);
  });

  it("never short-circuits a payload the full gate must judge", () => {
    expect(fastAllow(undefined)).toBe(false);
    expect(fastAllow("")).toBe(false);
    expect(fastAllow("{oops")).toBe(false);
    expect(fastAllow("[]")).toBe(false);
    expect(fastAllow('{"tool_input":{}}')).toBe(false);
    expect(fastAllow('{"tool_name":123}')).toBe(false);
  });

  it("every read-only name classifies `other`, so an allow is what runGate would decide", () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(classifyTool(name)).toBe("other");
    }
    expect(READ_ONLY_TOOL_NAMES.size).toBeGreaterThan(10);
  });

  it("fastAllow(read of .env) = true and runGate agrees", async () => {
    const text = payload("Read", { file_path: ".env" });
    expect(fastAllow(text)).toBe(true);
    const r = await runGate(text);
    expect(r.decision).toBe("allow");
    expect(r.toolClass).toBe("other");
  });
});

describe("gate-fast: helpers", () => {
  it("bareToolName strips an MCP namespace only", () => {
    expect(bareToolName("mcp__fs__read_file")).toBe("read_file");
    expect(bareToolName("mcp_axiom_axiom_write")).toBe("axiom_write");
    expect(bareToolName("Read")).toBe("read");
    expect(bareToolName("read_file")).toBe("read_file");
  });

  it("carriesPathValue finds a path key through arrays and objects", () => {
    expect(carriesPathValue({ a: 1 })).toBe(false);
    expect(carriesPathValue({ paths: [".env"] })).toBe(true);
    expect(carriesPathValue({ files: [{ path: ".env" }] })).toBe(true);
    expect(carriesPathValue({ a: { b: { c: { d: { e: { f: { path: "x" } } } } } } })).toBe(true);
    expect(carriesPathValue({ path: "" })).toBe(false);
  });
});

describe("gate-fast: readStdin.bytes (A2-17 / A3-18)", () => {
  it("reports the bytes received on every exit path", async () => {
    const never = new Readable({ read() {} });
    const timedOut = await readStdin(never, { timeoutMs: 20 });
    expect(timedOut).toMatchObject({ text: undefined, timedOut: true, tooLarge: false, bytes: 0 });

    // A harness hiccup mid-write: bytes arrived, then the stream went silent. The gate must be
    // able to tell this apart from "the harness sent nothing" (policy lives in gate.ts).
    const silent = new Readable({ read() {} });
    const pending = readStdin(silent, { timeoutMs: 60 });
    silent.push(Buffer.from('{"tool_name":"Write"'));
    const partial = await pending;
    expect(partial.timedOut).toBe(true);
    expect(partial.bytes).toBeGreaterThan(0);

    const ok = await readStdin(Readable.from([Buffer.from("abc")]));
    expect(ok).toMatchObject({ text: "abc", timedOut: false, tooLarge: false, bytes: 3 });

    const big = await readStdin(Readable.from([Buffer.alloc(200)]), { maxBytes: 100 });
    expect(big.tooLarge).toBe(true);
    expect(big.bytes).toBeGreaterThan(100);
  });
});
