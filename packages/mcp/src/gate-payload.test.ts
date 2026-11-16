/**
 * Payload writer tests (S-1408) for `gate-payload.ts`: normalisation (commandCwd, the A2-18
 * no-tool-name flag), every path key (A2-2), every content key (A2-15), argv joining (A2-9),
 * `noTarget` vs `undetermined` (A2-16/HN-5/QA-12/PM-5/D-18), the side-effecting tools (OPS-12)
 * and the `.vscode/tasks.json` / terminal-stdin sources (A2-25).
 *
 * Own file on purpose: `gate.test.ts` belongs to the integrator.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import { runGate } from "./gate.js";
import {
  commandString,
  decodePathValue,
  type Extracted,
  extractTargets,
  gatherContent,
  normalizePayload,
  pathValues,
  taskCommandsFromJson,
} from "./gate-payload.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

const SECRET = [`-----BEGIN ${"RSA"} PRIVATE ${"KEY"}-----`, "MIIE", "END"].join("\n");

function extract(toolName: string, input: Record<string, unknown>): Extracted {
  return extractTargets({ toolName, cwd: "/repo", input });
}

/** `op:path` pairs, sorted: the ORDER the keys appear in the payload is not part of the contract. */
function pairs(e: Extracted): string[] {
  return e.targets.map((t) => `${t.op}:${t.rawPath}`).sort();
}

let home: TmpRepo;
beforeAll(async () => {
  home = await tmpRepo("axiom-w-e-home-");
});
afterAll(async () => {
  await home.cleanup();
});

/** Temp root with a plain `.git` (so root discovery stops there) and optional files. */
async function rootWith(files: Record<string, string> = {}): Promise<TmpRepo> {
  const repo = await tmpRepo("axiom-w-e-repo-");
  await mkdir(join(repo.root, ".git"), { recursive: true });
  await writeFile(join(repo.root, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const [rel, content] of Object.entries(files)) {
    const f = join(repo.root, ...rel.split("/"));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, content);
  }
  return repo;
}

function hook(tool: string, input: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({
    session_id: "w-e",
    hook_event_name: "PreToolUse",
    cwd,
    tool_name: tool,
    tool_input: input,
  });
}

const judge = (cwd: string, tool: string, input: Record<string, unknown>) =>
  runGate(hook(tool, input, cwd), { home: home.root });

/** A root with an explicit profile (legacy path, still a supported 4.x layer). */
async function rootWithProfile(
  doc: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<TmpRepo> {
  const repo = await rootWith({
    ...files,
    ".axiom/gate-profile.json": JSON.stringify(doc),
  });
  return repo;
}

describe("gate-payload: normalisation", () => {
  it("commandCwd is the working directory the tool INPUT names (item 11)", () => {
    const n = normalizePayload({
      tool_name: "run_in_terminal",
      tool_input: { command: "ls", cwd: "sub/dir" },
      cwd: "/repo",
    });
    expect(n?.cwd).toBe("/repo");
    expect(n?.commandCwd).toBe("sub/dir");
    const same = normalizePayload({
      tool_name: "Bash",
      tool_input: { command: "ls", workdir: "/repo" },
      cwd: "/repo",
    });
    // naming the payload cwd changes nothing, so it is not reported
    expect(same?.commandCwd).toBeUndefined();
    expect(
      normalizePayload({ tool_name: "Bash", tool_input: { command: "ls" } })?.commandCwd,
    ).toBeUndefined();
  });

  it("a hook payload with no tool name is returned with unknownTool (A2-18)", () => {
    const empty = normalizePayload({
      tool_name: "",
      tool_input: { file_path: ".env", content: "x" },
      cwd: "/r",
    });
    expect(empty).toMatchObject({ toolName: "", cwd: "/r", unknownTool: true });
    expect(empty?.input).toMatchObject({ file_path: ".env" });
    expect(normalizePayload({ tool_input: { file_path: ".env" } })?.unknownTool).toBe(true);
    expect(normalizePayload({ preToolUse: { parameters: { path: ".env" } } })?.unknownTool).toBe(
      true,
    );
    expect(
      normalizePayload({ tool_name: 123, tool_input: { file_path: ".env" } })?.unknownTool,
    ).toBe(true);
    // Not a tool call at all: still undefined (a hook on the wrong event must stay silent).
    expect(normalizePayload({ cwd: "/r" })).toBeUndefined();
    expect(normalizePayload("nope")).toBeUndefined();
    expect(normalizePayload({ hook_event_name: "Stop" })).toBeUndefined();
  });

  it("the nested tool-name shapes are recognised, so they are judged (A2-18 cause)", () => {
    const kiro = normalizePayload({
      toolUse: { name: "fsWrite", input: { path: ".env", text: "x" } },
      cwd: "/r",
    });
    expect(kiro).toMatchObject({
      toolName: "fsWrite",
      harness: "kiro",
      cwd: "/r",
      input: { path: ".env", text: "x" },
    });
    expect(kiro?.unknownTool).toBeUndefined();
    expect(
      normalizePayload({
        toolCall: { name: "write_file", args: { file_path: "a.ts" } },
        cwd: "/r",
      }),
    ).toMatchObject({ toolName: "write_file", harness: "gemini", input: { file_path: "a.ts" } });
    expect(
      normalizePayload({ tool: { id: "write" }, args: { filePath: "a.ts" }, cwd: "/r" }),
    ).toMatchObject({ toolName: "write", harness: "opencode", input: { filePath: "a.ts" } });
    // an ACP-style toolCall without a name is never GUESSED as a tool, but it is a tool call we
    // cannot name: it stays flagged (`unknownTool`) so the gate can warn or deny it (A2-18).
    const acp = normalizePayload({ toolCall: { toolCallId: "c1", kind: "edit" } });
    expect(acp?.unknownTool).toBe(true);
    expect(acp?.toolName).toBe("");
  });

  it("a named payload keeps the 3.0 shape (no extra fields)", () => {
    expect(
      normalizePayload({ tool_name: "Write", tool_input: { file_path: "a" }, cwd: "/r" }),
    ).toStrictEqual({ toolName: "Write", cwd: "/r", input: { file_path: "a" } });
  });
});

describe("gate-payload: every path key is judged (A2-2)", () => {
  it.each([
    ["rename_file", { path: "src/a.ts", newPath: ".env" }, ["delete:src/a.ts", "write:.env"]],
    [
      "move_file",
      { path: "src/a.ts", destination: ".git/config" },
      ["delete:src/a.ts", "write:.git/config"],
    ],
    ["move_file", { file_path: "src/a.ts", target: ".env" }, ["delete:src/a.ts", "write:.env"]],
    [
      "mcp__filesystem__move_file",
      { source: ".env", destination: "src/x" },
      ["delete:.env", "write:src/x"],
    ],
    [
      "mcp__filesystem__move_file",
      { source: "src/a.ts", destination: ".env" },
      ["delete:src/a.ts", "write:.env"],
    ],
    [
      "rename_file",
      { oldPath: ".git/config", newPath: "src/c" },
      ["delete:.git/config", "write:src/c"],
    ],
    ["mcp__fs__copy_path", { source_path: "src/a.ts", destination_path: ".env" }, ["write:.env"]],
    ["edit_files", { paths: [".env", "src/a.ts"], content: "x" }, ["write:.env", "write:src/a.ts"]],
    ["write_files", { files: [{ path: ".env", content: "A=1" }] }, ["write:.env"]],
    ["mcp_axiom_axiom_write", { root: "/r", files: [{ path: "src/b.ts" }] }, ["write:src/b.ts"]],
    ["axiom_write", { files: [{ path: ".env", op: "delete" }] }, ["delete:.env"]],
    ["download_file", { url: "https://x.invalid/a", path: ".env" }, ["write:.env"]],
    ["touch_file", { path: ".env" }, ["write:.env"]],
    ["create_file", { filePath: "src/a.ts", content: "x" }, ["write:src/a.ts"]],
    ["Delete", { path: "x" }, ["delete:x"]],
  ])("%s -> %j", (tool, input, expected) => {
    expect(pairs(extract(tool, input))).toEqual([...expected].sort());
  });

  it("a copy's source is read, not a target (only the destination is judged)", () => {
    expect(
      pairs(extract("copy_file", { source: "src/a.ts", destination: ".git/hooks/pre-commit" })),
    ).toEqual(["write:.git/hooks/pre-commit"]);
  });

  it("decodes a file:// URI to a path (A2-16)", () => {
    const uri = pathToFileURL(join("/repo", "src", "a.ts")).href;
    expect(decodePathValue(uri)).toBe(fileURLToPath(uri));
    expect(decodePathValue(uri)).toContain("a.ts");
    expect(pairs(extract("vscode_renameSymbol", { uris: uri, uri }))).toEqual([
      `delete:${fileURLToPath(uri)}`,
    ]);
    expect(pairs(extract("Write", { filePath: uri, content: "x" }))).toEqual([
      `write:${fileURLToPath(uri)}`,
    ]);
    expect(pathValues(["a", 1, "b"])).toEqual(["a", "b"]);
  });
});

describe("gate-payload: content from every content key (A2-15)", () => {
  it.each([
    ["Write", { file_path: "src/a.ts", contents: SECRET }],
    ["edit_file", { target_file: "src/a.ts", code_edit: SECRET }],
    ["write_file", { path: "src/a.bin", data: SECRET }],
    ["edit_file", { target_file: "src/a.ts", insert_text: SECRET }],
    [
      "mcp__filesystem__edit_file",
      { path: "src/a.ts", edits: [{ oldText: "a", newText: SECRET }] },
    ],
    ["edit_notebook_file", { filePath: "src/n.ipynb", newCode: [SECRET] }],
    ["Write", { file_path: "src/a.ts", data: { nested: { content: SECRET } } }],
    ["Write", { file_path: "src/a.ts", content: SECRET }],
  ])("%s carries the new content", (tool, input) => {
    const e = extract(tool, input);
    expect(e.targets).toHaveLength(1);
    expect(e.targets[0]?.content).toContain(SECRET);
  });

  it("collects every edit of a MultiEdit payload", () => {
    expect(
      gatherContent({ file_path: "a", edits: [{ new_string: "y" }, { new_string: "q" }] }),
    ).toBe("y\nq");
  });
});

describe("gate-payload: argv joining (A2-9)", () => {
  const packed = "git push --force origin main";
  it("quotes each argv element, so the nested script stays one argument", () => {
    expect(commandString({ command: ["bash", "-lc", packed] })).toBe(`bash -lc '${packed}'`);
    expect(commandString({ command: `bash -lc '${packed}'` })).toBe(`bash -lc '${packed}'`);
    expect(commandString({ command: ["bash", "-lc", "echo x > .env"] })).toBe(
      "bash -lc 'echo x > .env'",
    );
    expect(commandString({ command: ["rm", "-rf", ".git"] })).toBe("rm -rf .git");
  });

  it("the shell scan sees what the joined form contains", () => {
    expect(pairs(extract("Bash", { command: ["bash", "-lc", "rm -rf .git"] }))).toEqual([
      "delete:.git",
    ]);
    expect(pairs(extract("Bash", { command: ["bash", "-lc", "echo x > .env"] }))).toEqual([
      "write:.env",
    ]);
    expect(extract("Bash", { command: ["bash", "-lc", packed] }).command).toBe(
      `bash -lc '${packed}'`,
    );
  });
});

describe("gate-payload: noTarget vs undetermined (A2-16, HN-5, D-18)", () => {
  it.each([
    ["TodoWrite", { todos: [{ content: "x", status: "pending" }] }],
    ["todo_write", { todos: [] }],
    ["write_todos", { todos: [] }],
    ["TaskCreate", { subject: "x" }],
    ["mcp_linear_create_issue", { title: "t" }],
    ["mcp_github_create_pull_request", { owner: "o", repo: "r" }],
    ["create_new_jupyter_notebook", { query: "plot" }],
    ["mcp_axiom_axiom_write", {}],
    ["mcp_axiom_axiom_apply", { root: "/r", bundle: {} }],
    ["write_agent", { prompt: "x" }],
    ["edit_preferences", { key: "a", value: "b" }],
  ])("%s with no path-like value is noTarget", (tool, input) => {
    const e = extract(tool, input);
    expect(e.noTarget).toBe(true);
    expect(e.undetermined).toBe(false);
    expect(e.targets).toEqual([]);
  });

  it.each([
    ["mcp_axiom_axiom_write", { root: "/r", files: [{ path: ".env", content: "x" }] }],
    ["mcp__axiom__axiom_write", { files: [{ path: "src/b.ts", content: "x" }] }],
    ["patch_file", { path: ".env", content: "A=1" }],
    ["insert_edit_into_file", { filePath: "src/a.ts", code: "x" }],
    ["run_notebook_cell", { filePath: "src/n.ipynb", cellId: "c1" }],
  ])("%s with a real path is judged, not noTarget", (tool, input) => {
    const e = extract(tool, input);
    expect(e.noTarget).toBeUndefined();
    expect(e.undetermined).toBe(false);
    expect(e.targets.length).toBeGreaterThan(0);
  });

  it("an empty write call stays undetermined (D-18, the integrator test pins this)", () => {
    for (const tool of ["Delete", "Write", "create_directory"]) {
      const e = extract(tool, {});
      expect(e.undetermined).toBe(true);
      expect(e.noTarget).toBeUndefined();
    }
  });

  it("a file tool with an unknown path key or content only stays undetermined (D-18)", () => {
    for (const input of [
      { output_location: "src/a.ts", content: "x" },
      { contents: "x" },
      { edits: [{ new_string: "x" }] },
    ]) {
      const e = extract("Write", input);
      expect(e.undetermined).toBe(true);
      expect(e.noTarget).toBeUndefined();
    }
    // ...while a write tool whose arguments are simply not paths is a noTarget
    expect(extract("write_agent", { prompt: "x" }).noTarget).toBe(true);
    expect(extract("edit_preferences", { key: "a", value: "b" }).noTarget).toBe(true);
  });

  it("a path key we cannot turn into a target is undetermined, not noTarget", () => {
    const e = extract("Write", { path: 42, content: "x" });
    expect(e.undetermined).toBe(true);
  });
});

describe("gate-payload: side-effecting tools (OPS-12)", () => {
  it.each([
    ["memory", { command: "create", path: "/memories/x.md", file_text: "x" }],
    ["runSubagent", { prompt: "x", description: "y" }],
    ["run_playwright_code", { code: "await page.click()", pageId: "1" }],
    ["manage_todo_list", { todoList: [] }],
  ])("%s is judged as noTarget, never as a write target", (tool, input) => {
    const e = extract(tool, input);
    expect(e.cls).toBe("write");
    expect(e.noTarget).toBe(true);
    expect(e.targets).toEqual([]);
  });

  it("memory's virtual /memories path is not a filesystem target", async () => {
    const repo = await rootWith();
    try {
      const r = await judge(repo.root, "memory", {
        command: "create",
        path: "/memories/x.md",
        file_text: "x",
      });
      expect(r.decision).toBe("allow");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("gate-payload: tasks.json and terminal stdin (A2-25)", () => {
  it("resolves a run_task id through .vscode/tasks.json", async () => {
    const repo = await rootWith({
      ".vscode/tasks.json": JSON.stringify({
        version: "2.0.0",
        tasks: [
          { label: "stage", type: "shell", command: "echo x > .env" },
          { label: "all", type: "shell", command: "true", dependsOn: ["stage"] },
        ],
      }),
    });
    try {
      expect(taskCommandsFromJson(repo.root, "stage")).toEqual(["echo x > .env"]);
      expect(taskCommandsFromJson(repo.root, "all")).toEqual(["true", "echo x > .env"]);
      expect(commandString({ id: "stage" }, { cwd: repo.root })).toBe("echo x > .env");
      expect(commandString({ id: "stage", workspaceFolder: repo.root })).toBe("echo x > .env");
      // `run_task` is a shell tool the harness sends as `{ id }`
      const resolved = extractTargets({
        toolName: "run_task",
        cwd: repo.root,
        input: { id: "stage" },
      });
      expect(pairs(resolved)).toEqual(["write:.env"]);
      expect(resolved.command).toBe("echo x > .env");
      // VS Code ids are also `shell: <label>`
      expect(commandString({ id: "shell: stage" }, { cwd: repo.root })).toBe("echo x > .env");
      expect(commandString({ id: "nope" }, { cwd: repo.root })).toBeUndefined();
      const r = await judge(repo.root, "run_task", { id: "stage", workspaceFolder: repo.root });
      expect(r.code).toBe("path.deny");
    } finally {
      await repo.cleanup();
    }
  });

  it("a .vscode/tasks.json WRITE is scanned as a command source", async () => {
    const repo = await rootWith();
    try {
      const content = JSON.stringify({
        version: "2.0.0",
        tasks: [{ label: "x", type: "shell", command: "echo x > .env" }],
      });
      const e = extract("create_file", { filePath: ".vscode/tasks.json", content });
      expect(e.cls).toBe("shell");
      expect(e.command).toBe("echo x > .env");
      expect(pairs(e)).toEqual(["write:.env", "write:.vscode/tasks.json"]);
      const r = await judge(repo.root, "create_file", {
        filePath: ".vscode/tasks.json",
        content,
      });
      expect(r.code).toBe("path.deny");
    } finally {
      await repo.cleanup();
    }
  });

  it("terminal stdin under `input` is scanned (send_terminal_input, write_bash)", async () => {
    expect(
      pairs(extract("send_terminal_input", { terminalId: "1", input: "echo x > .env\n" })),
    ).toEqual(["write:.env"]);
    const writeBash = extract("write_bash", { sessionId: "1", input: "echo x > .env\n" });
    expect(writeBash.cls).toBe("shell");
    expect(pairs(writeBash)).toEqual(["write:.env"]);
    // a terminal answer ("y") is not a command: the payload stays an allowed shell call
    const answer = extract("write_bash", { sessionId: "1", input: "y\n", delay: 10 });
    expect(answer.cls).toBe("shell");
    expect(answer.targets).toEqual([]);
    expect(answer.undetermined).toBe(false);
    expect(answer.noTarget).toBeUndefined();
    const repo = await rootWith();
    try {
      const r = await judge(repo.root, "write_bash", { sessionId: "1", input: "echo x > .env\n" });
      expect(r.code).toBe("path.deny");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("gate-payload: end to end through runGate", () => {
  it("a payload with no tool name warns, and denies for exit-code-only formats (A2-18)", async () => {
    const shape = JSON.stringify({
      tool_input: { file_path: ".env" },
      cwd: home.root,
    });
    const kiro = await runGate(shape, { format: "kiro", home: home.root });
    expect(kiro.decision).toBe("deny");
    expect(kiro.code).toBe("ERR_INVALID_INPUT");
    expect(kiro.stdout).toBeUndefined();
    const claude = await runGate(shape, { format: "claude", home: home.root });
    expect(claude.decision).toBe("allow");
    expect(claude.stderr.some((l) => l.includes("names no tool"))).toBe(true);
    // `auto` is not an explicit guess: it stays a silent allow
    const auto = await runGate(shape, { home: home.root });
    expect(auto.decision).toBe("allow");
    expect(auto.stderr.some((l) => l.includes("names no tool"))).toBe(false);
  });

  it("a Kiro/OpenCode/Gemini nested shape is judged, not warned about (A2-18 cause)", async () => {
    const repo = await rootWith({ "src/a.ts": "x" });
    try {
      for (const shape of [
        { toolUse: { name: "fsWrite", input: { path: ".env", text: "x" } } },
        { toolCall: { name: "write_file", args: { file_path: ".env", content: "x" } } },
        { tool: { id: "write" }, args: { filePath: ".env", content: "x" } },
      ]) {
        const r = await runGate(JSON.stringify({ ...shape, cwd: repo.root }), {
          format: "kiro",
          home: home.root,
        });
        expect(r.decision).toBe("deny");
        expect(r.code).toBe("path.deny");
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("a stdin timeout with bytes received fails closed; with none it allows (A2-17)", async () => {
    const empty = await runGate(undefined, { stdinBytes: 0, home: home.root });
    expect(empty.decision).toBe("allow");
    const truncated = await runGate(undefined, { stdinBytes: 12, home: home.root });
    expect(truncated.decision).toBe("deny");
    expect(truncated.code).toBe("ERR_INTERNAL");
    const oversize = await runGate(undefined, {
      stdinTooLarge: true,
      stdinBytes: 1024,
      home: home.root,
    });
    expect(oversize.code).toBe("ERR_INTERNAL");
    // --fail-open still lets an operator through
    expect((await runGate(undefined, { stdinBytes: 12, failOpen: true })).decision).toBe("allow");
  });

  it("a noTarget call is allowed and journaled with no_target (contract, OPS-12)", async () => {
    const repo = await rootWithProfile({ deny: [".env"], record: true });
    try {
      const r = await runGate(
        hook("memory", { command: "create", path: "/memories/x.md" }, repo.root),
        {
          home: home.root,
        },
      );
      expect(r.decision).toBe("allow");
      const entries = await readDecisions(repo.root);
      const line = entries.find((e) => e.tool === "memory");
      expect(line?.no_target).toBe(true);
      expect(line?.decision).toBe("allow");
    } finally {
      await repo.cleanup();
    }
  });

  it("commandCwd resolves relative shell operands against the directory the input names (contract 3)", async () => {
    const repo = await rootWith({ "src/a.ts": "x" });
    try {
      // without a named cwd the operand lands in the root and is fine
      const plain = await runGate(
        hook("run_in_terminal", { command: "echo x > out.txt" }, repo.root),
        {
          home: home.root,
        },
      );
      expect(plain.decision).toBe("allow");
      // naming a subdirectory keeps it inside the root
      const inside = await runGate(
        hook("run_in_terminal", { command: "echo x > out.txt", cwd: "src" }, repo.root),
        { home: home.root },
      );
      expect(inside.decision).toBe("allow");
      // naming the parent puts the same operand OUTSIDE the root: proof the input's cwd was used
      const outside = await runGate(
        hook("run_in_terminal", { command: "echo x > out.txt", cwd: ".." }, repo.root),
        { home: home.root },
      );
      expect(outside.decision).toBe("deny");
      expect(outside.code).toBe("ERR_CONTAINMENT");
    } finally {
      await repo.cleanup();
    }
  });

  it("the rules see the command the extractor resolved (run_task through tasks.json)", async () => {
    const forcePush = ["git", "push", `${"--fo"}rce`, "origin", "main"].join(" ");
    const repo = await rootWithProfile(
      { deny: [".env"], commands: { pack: "core" }, record: true },
      {
        ".vscode/tasks.json": JSON.stringify({
          version: "2.0.0",
          tasks: [{ label: "x", type: "shell", command: forcePush }],
        }),
      },
    );
    try {
      const r = await runGate(
        hook("run_task", { id: "x", workspaceFolder: repo.root }, repo.root),
        {
          home: home.root,
        },
      );
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("house.forcePush");
      const staged = await runGate(
        hook(
          "create_file",
          {
            filePath: ".vscode/tasks.json",
            content: JSON.stringify({
              version: "2.0.0",
              tasks: [{ label: "x", type: "shell", command: forcePush }],
            }),
          },
          repo.root,
        ),
        { home: home.root },
      );
      expect(staged.decision).toBe("deny");
      expect(staged.code).toBe("house.forcePush");
    } finally {
      await repo.cleanup();
    }
  });

  it("rename/move into a denied path is a deny now (A2-2)", async () => {
    const repo = await rootWith({ "src/a.ts": "export const a = 1;\n" });
    try {
      expect(
        (await judge(repo.root, "rename_file", { path: "src/a.ts", newPath: ".env" })).code,
      ).toBe("path.deny");
      expect(
        (await judge(repo.root, "move_file", { path: "src/a.ts", destination: ".git/config" }))
          .code,
      ).toBe("path.deny");
      expect(
        (
          await judge(repo.root, "mcp__filesystem__move_file", {
            source: ".env",
            destination: "src/x",
          })
        ).code,
      ).toBe("path.deny");
    } finally {
      await repo.cleanup();
    }
  });

  it("a tool with no write hint is judged (A2-3)", async () => {
    const repo = await rootWith({ "src/a.ts": "x" });
    try {
      expect((await judge(repo.root, "mcp__fs__put", { path: ".env", content: "A=1" })).code).toBe(
        "path.deny",
      );
      expect((await judge(repo.root, "save_file", { path: ".env", content: "A=1" })).code).toBe(
        "path.deny",
      );
      expect(
        (
          await judge(repo.root, "copy_file", {
            source: "src/a.ts",
            destination: ".git/hooks/pre-commit",
          })
        ).code,
      ).toBe("path.deny");
      expect((await judge(repo.root, "fsAppend", { path: ".env", text: "A=1" })).code).toBe(
        "path.deny",
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("a shell argv array is judged like the quoted string (A2-9)", async () => {
    const repo = await rootWith();
    try {
      const asArray = await judge(repo.root, "Bash", {
        command: ["bash", "-lc", "echo x > .env"],
      });
      expect(asArray.code).toBe("path.deny");
      const asString = await judge(repo.root, "Bash", { command: "bash -lc 'echo x > .env'" });
      expect(asString.code).toBe(asArray.code);
    } finally {
      await repo.cleanup();
    }
  });

  it("content under a new content key is scanned (A2-15)", async () => {
    const repo = await rootWith({ "src/a.ts": "x" });
    try {
      for (const input of [
        { file_path: "src/a.ts", contents: SECRET },
        { target_file: "src/a.ts", code_edit: SECRET },
        { path: "src/a.bin", data: SECRET },
        { filePath: "src/n.ipynb", newCode: [SECRET] },
      ]) {
        const r = await judge(repo.root, "Write", input);
        expect(r.code).toBe("content.noSecrets.privateKey");
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("AXIOM's own tools and pathless writers are allowed, not ERR_UNSUPPORTED_OP (A2-16)", async () => {
    const repo = await rootWith({ "src/b.ts": "x" });
    try {
      const ok = await judge(repo.root, "mcp_axiom_axiom_write", {
        root: repo.root,
        files: [{ path: "src/b.ts", content: "x" }],
      });
      expect(ok.decision).toBe("allow");
      expect((await judge(repo.root, "TodoWrite", { todos: [] })).decision).toBe("allow");
      expect((await judge(repo.root, "mcp_linear_create_issue", { title: "t" })).decision).toBe(
        "allow",
      );
      expect(
        (await judge(repo.root, "create_new_jupyter_notebook", { query: "plot" })).decision,
      ).toBe("allow");
      // ...but their real path is judged
      expect(
        (
          await judge(repo.root, "mcp__axiom__axiom_write", {
            files: [{ path: ".env", content: "x" }],
          })
        ).code,
      ).toBe("path.deny");
      // an empty file write stays the D-18 deny
      expect((await judge(repo.root, "Delete", {})).code).toBe("ERR_UNSUPPORTED_OP");
    } finally {
      await repo.cleanup();
    }
  });

  it("a file:// URI is judged instead of ERR_PATH_INVALID_CHAR (A2-16)", async () => {
    const repo = await rootWith({ "src/a.ts": "x" });
    try {
      const uri = pathToFileURL(join(repo.root, "src", "a.ts")).href;
      const r = await judge(repo.root, "vscode_renameSymbol", { symbol: "a", newName: "b", uri });
      expect(r.decision).toBe("allow");
    } finally {
      await repo.cleanup();
    }
  });

  it("a write whose path key we do not know is still denied (D-18 unchanged)", async () => {
    const repo = await rootWith({ "src/a.ts": "x" });
    try {
      const r = await judge(repo.root, "Write", { output_location: "src/a.ts", content: "x" });
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("ERR_UNSUPPORTED_OP");
      expect(r.toolClass).toBe("write");
      const open = await runGate(
        hook("Write", { output_location: "src/a.ts", content: "x" }, repo.root),
        { home: home.root, failOpen: true },
      );
      expect(open.decision).toBe("allow");
    } finally {
      await repo.cleanup();
    }
  });
});
