/**
 * v2.6 wiring of the gate (D-39): command rules, coordination, session rules, undo capture,
 * shadow mode, `ask` verdicts, `--post` routing and `--track-reads`. The rule modules have
 * their own unit tests; these assert they are reached from `runGate` / `gateMain`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import { GateProfileSchema, gateMain, isWholeFileTool, runGate } from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;

beforeEach(async () => {
  repo = await tmpRepo("axiom-gate26-");
  home = await tmpRepo("axiom-gate26-home-");
  await mkdir(join(repo.root, ".git"));
});
afterEach(async () => {
  await repo.cleanup();
  await home.cleanup();
});

async function profile(p: Record<string, unknown>): Promise<void> {
  await mkdir(join(repo.root, ".axiom"), { recursive: true });
  await writeFile(join(repo.root, ".axiom", "gate-profile.json"), JSON.stringify(p));
}

function shell(command: string, session = "s1"): string {
  return JSON.stringify({
    session_id: session,
    hook_event_name: "PreToolUse",
    cwd: repo.root,
    tool_name: "Bash",
    tool_input: { command },
  });
}

function write(tool: string, file: string, content: string, session = "s1"): string {
  return JSON.stringify({
    session_id: session,
    hook_event_name: "PreToolUse",
    cwd: repo.root,
    tool_name: tool,
    tool_input: { file_path: file, content },
  });
}

const run = (text: string, format: "auto" | "claude" | "codex" = "auto") =>
  runGate(text, { home: home.root, format });

function decision(stdout: string | undefined): unknown {
  if (stdout === undefined) return undefined;
  const doc = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } };
  return doc.hookSpecificOutput?.permissionDecision;
}

describe("gate v2.6: profile schema", () => {
  it("accepts every v2.6 key and keeps defaults off", () => {
    const p = GateProfileSchema.parse({
      commands: { pack: "house" },
      sessions: { foreignWrite: "ask" },
      undo: true,
      coordination: {},
      git: { requirePathspec: true },
      shadow: true,
    });
    expect(p.undo).toBe(true);
    expect(p.shadow).toBe(true);
    expect(p.commands?.pack).toBe("house");
    expect(GateProfileSchema.parse({}).undo).toBe(false);
    expect(GateProfileSchema.parse({}).shadow).toBe(false);
  });

  it("rejects an unknown nested key (strict)", () => {
    expect(GateProfileSchema.safeParse({ commands: { nope: 1 } }).success).toBe(false);
  });
});

describe("gate v2.6: command rules", () => {
  it("denies a house-pack command and carries the rule id + fix", async () => {
    await profile({ commands: { pack: "house" } });
    const r = await run(shell("git add -A"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("house.gitAddAll");
    const doc = JSON.parse(r.stdout ?? "{}") as { axiom?: { code?: string } };
    expect(doc.axiom?.code).toBe("house.gitAddAll");
  });

  it("allows a harmless command under the same pack", async () => {
    await profile({ commands: { pack: "house" } });
    const r = await run(shell("git status --short"));
    expect(r.decision).toBe("allow");
  });

  it("a custom ask rule answers ask in Claude format and deny in Codex format", async () => {
    await profile({
      commands: {
        deny: [{ id: "custom.curl", pattern: "\\bcurl\\b", reason: "net", decision: "ask" }],
      },
    });
    const claude = await run(shell("curl https://x"), "claude");
    expect(claude.verdict).toBe("ask");
    expect(decision(claude.stdout)).toBe("ask");
    const codex = await run(shell("curl https://x"), "codex");
    expect(codex.verdict).toBe("deny");
    expect(decision(codex.stdout)).toBe("deny");
  });

  it("no commands key → shell commands without write targets are allowed", async () => {
    await profile({});
    expect((await run(shell("git add -A"))).decision).toBe("allow");
  });
});

describe("gate v2.6: coordination", () => {
  it("refuses a build while a mark freezes it", async () => {
    const marks = join(home.root, "marks");
    await mkdir(marks);
    await writeFile(
      join(marks, "m.json"),
      JSON.stringify({ resource: "build:machine", state: "frozen", reason: "incident", at: "x" }),
    );
    await profile({ coordination: { marksDir: marks } });
    const r = await run(shell("pnpm build"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("coord.frozen");
  });
});

describe("gate v2.6: sessions + stale script + undo", () => {
  it("asks when another session wrote the file recently and this one has not seen it", async () => {
    await profile({ sessions: { foreignWrite: "ask" } });
    await writeFile(join(repo.root, "a.txt"), "v1\n");
    // session A writes (gate records a pending write), then the file changes on disk
    expect((await run(write("Edit", "a.txt", "v2", "A"), "claude")).decision).toBe("allow");
    await writeFile(join(repo.root, "a.txt"), "v2\n");
    const r = await run(write("Edit", "a.txt", "v3", "B"), "claude");
    expect(r.code).toBe("session.foreignWrite");
    expect(r.verdict).toBe("ask");
  });

  it("a denied whole-file create makes running that script a stale-script deny", async () => {
    await profile({ deny: ["scripts/**"], sessions: {} });
    const denied = await run(write("Write", "scripts/x.ps1", "Write-Host hi"));
    expect(denied.code).toBe("path.deny");
    const r = await run(shell("pwsh -File scripts/x.ps1"));
    expect(r.code).toBe("blind.staleScript");
  });

  it("captures the pre-image of an allowed write when undo is on", async () => {
    await profile({ undo: true });
    await writeFile(join(repo.root, "b.txt"), "before\n");
    expect((await run(write("Edit", "b.txt", "after"))).decision).toBe("allow");
    const logs = await readdir(join(repo.root, ".axiom", "undo"));
    expect(logs.length).toBe(1);
    const line = (await readFile(join(repo.root, ".axiom", "undo", logs[0] ?? ""), "utf8")).trim();
    const rec = JSON.parse(line) as { path: string; pre: string };
    expect(rec.path).toBe("b.txt");
    expect(rec.pre).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("isWholeFileTool knows create/write tools and not targeted edits", () => {
    expect(isWholeFileTool("create_file")).toBe(true);
    expect(isWholeFileTool("Write")).toBe(true);
    expect(isWholeFileTool("Edit")).toBe(false);
    expect(isWholeFileTool("replace_string_in_file")).toBe(false);
  });
});

describe("gate v2.6: shadow mode", () => {
  it("allows a would-be deny and records it with the command", async () => {
    await profile({ shadow: true, commands: { pack: "house" } });
    const r = await run(shell("git add -A"));
    expect(r.decision).toBe("allow");
    const recs = await readDecisions(repo.root);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.shadow).toBe(true);
    expect(recs[0]?.decision).toBe("deny");
    expect(recs[0]?.code).toBe("house.gitAddAll");
    expect(recs[0]?.rule).toBe("house.gitAddAll");
    expect(recs[0]?.command).toBe("git add -A");
    expect(typeof recs[0]?.ms).toBe("number");
  });

  it("keeps enforcing path predicates (shadow never weakens an existing profile)", async () => {
    await profile({ shadow: true, deny: ["x.txt"], commands: { pack: "house" } });
    const r = await run(write("Edit", "x.txt", "y"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("path.deny");
    const recs = await readDecisions(repo.root);
    expect(recs[0]?.shadow).toBe(true);
    expect(recs[0]?.rule).toBeUndefined();
  });

  it("records allow with shadow: true when no rule fires (the replay baseline)", async () => {
    await profile({ shadow: true, commands: { pack: "house" } });
    expect((await run(shell("git status"))).decision).toBe("allow");
    const recs = await readDecisions(repo.root);
    expect(recs[0]?.decision).toBe("allow");
    expect(recs[0]?.shadow).toBe(true);
    expect(recs[0]?.command).toBe("git status");
  });
});

describe("gate v2.6: gateMain routing", () => {
  it("--post goes to the PostToolUse check (exit 0, block document on a protected path)", async () => {
    await profile({ deny: [".env"] });
    const payload = JSON.stringify({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      cwd: repo.root,
      tool_name: "Bash",
      tool_input: { command: "echo X=1 > .env" },
      tool_response: { stdout: "" },
    });
    const r = await gateMain(["--stdin", "--post", "--format", "claude"], {
      read: { text: payload, timedOut: false, tooLarge: false },
      home: home.root,
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("deny");
    const doc = JSON.parse(r.stdout ?? "{}") as { decision?: string };
    expect(doc.decision).toBe("block");
  });

  it("--track-reads records a read so a later blind-overwrite check sees it", async () => {
    await profile({ sessions: { blindOverwrite: "deny", trackReads: true } });
    await writeFile(join(repo.root, "c.txt"), "c\n");
    const blind = await run(write("Write", "c.txt", "new", "R"));
    expect(blind.code).toBe("blind.overwrite");
    const read = JSON.stringify({
      session_id: "R",
      hook_event_name: "PreToolUse",
      cwd: repo.root,
      tool_name: "Read",
      tool_input: { file_path: "c.txt" },
    });
    const r = await gateMain(["--stdin", "--track-reads"], {
      read: { text: read, timedOut: false, tooLarge: false },
      home: home.root,
    });
    expect(r.decision).toBe("allow");
    expect((await run(write("Write", "c.txt", "new", "R"))).decision).toBe("allow");
  });
});
