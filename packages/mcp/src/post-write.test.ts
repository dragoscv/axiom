import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import { postMain, reportedChanges, toolResponse } from "./post-write.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-post-");
  home = await tmpRepo("axiom-post-home-");
  await mkdir(join(repo.root, ".git"));
  await mkdir(join(repo.root, ".axiom"));
  await writeFile(
    join(repo.root, ".axiom", "gate-profile.json"),
    JSON.stringify({ deny: [".env", ".env.*", ".git/**"], record: true }),
  );
});
afterEach(async () => {
  await Promise.all([repo.cleanup(), home.cleanup()]);
});

const read = (payload: unknown) => ({
  text: typeof payload === "string" ? payload : JSON.stringify(payload),
  timedOut: false,
  tooLarge: false,
});
const run = (payload: unknown, format = "claude") =>
  postMain(["--stdin", "--post", "--format", format], { read: read(payload), home: home.root });

const claudeBash = (command: string, response: Record<string, unknown> = {}) => ({
  session_id: "s1",
  hook_event_name: "PostToolUse",
  cwd: repo.root,
  tool_name: "Bash",
  tool_input: { command },
  tool_response: response,
});

describe("postMain (S-1205)", () => {
  it("Claude Bash that wrote .env → block document (exit 0) + a post decision recorded", async () => {
    const r = await run(claudeBash("echo X=1 > .env"));
    expect(r.decision).toBe("deny");
    expect(r.exitCode).toBe(0);
    expect(r.code).toBe("path.deny");
    expect(r.path).toBe(".env");
    const doc = JSON.parse(r.stdout ?? "{}") as Record<string, unknown>;
    expect(doc.decision).toBe("block");
    expect(typeof doc.reason).toBe("string");
    const recs = await readDecisions(repo.root);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      phase: "post",
      decision: "deny",
      code: "path.deny",
      tool: "Bash",
      paths: [".env"],
      agent_id: "claude:s1",
    });
  });

  it("bashEditDiff.changedFiles reveals a write the command text hides", async () => {
    const r = await run(
      claudeBash("node scripts/gen.mjs", {
        bashEditDiff: { changedFiles: [join(repo.root, ".env.local")], files: [] },
      }),
    );
    expect(r.decision).toBe("deny");
    expect(r.path).toBe(".env.local");
  });

  it("clean write → allow, no stdout, an allow post decision recorded", async () => {
    const r = await run(claudeBash("echo hi > notes.txt"));
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBeUndefined();
    const recs = await readDecisions(repo.root);
    expect(recs.map((d) => [d.phase, d.decision, d.paths])).toEqual([
      ["post", "allow", ["notes.txt"]],
    ]);
  });

  it("Write/Edit tool_response.filePath and content are judged", async () => {
    const r = await run({
      cwd: repo.root,
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts", content: "x" },
      tool_response: { filePath: join(repo.root, ".git", "config"), type: "create" },
    });
    expect(r.decision).toBe("deny");
    expect(r.path).toBe(".git/config");
  });

  it("malformed / empty / timed-out payload → allow + stderr warn, nothing recorded", async () => {
    for (const io of [
      read("{nope"),
      { text: undefined, timedOut: true, tooLarge: false },
      { text: "x", timedOut: false, tooLarge: true },
    ]) {
      const r = await postMain(["--stdin", "--post"], { read: io, home: home.root });
      expect(r.decision).toBe("allow");
      expect(r.exitCode).toBe(0);
      expect(r.stderr.some((l) => l.startsWith("AXIOM GATE WARN"))).toBe(true);
    }
    expect(await readDecisions(repo.root)).toEqual([]);
  });

  it("bad flags and an unreadable profile never throw: allow + warn", async () => {
    const bad = await postMain(["--nope"], { read: read(claudeBash("echo > .env")) });
    expect(bad.decision).toBe("allow");
    await writeFile(join(repo.root, ".axiom", "gate-profile.json"), '{"deny":"x"}');
    const broken = await run(claudeBash("echo > .env"));
    expect(broken.decision).toBe("allow");
    expect(broken.stderr.some((l) => l.startsWith("AXIOM GATE WARN"))).toBe(true);
  });

  it("per-format block shapes: codex block, copilot/auto block + additionalContext, windsurf none", async () => {
    const codex = await run(claudeBash("echo > .env"), "codex");
    expect(JSON.parse(codex.stdout ?? "{}").decision).toBe("block");
    const auto = JSON.parse((await run(claudeBash("echo > .env"), "auto")).stdout ?? "{}");
    expect(auto.decision).toBe("block");
    expect(typeof auto.additionalContext).toBe("string");
    expect(auto.axiom).toMatchObject({ phase: "post", code: "path.deny" });
    const ws = await run(claudeBash("echo > .env"), "windsurf");
    expect(ws.decision).toBe("deny");
    expect(ws.stdout).toBeUndefined();
  });

  it("record: false → nothing appended; a non-write tool → allow", async () => {
    await writeFile(
      join(repo.root, ".axiom", "gate-profile.json"),
      JSON.stringify({ deny: [".env"] }),
    );
    expect((await run(claudeBash("echo > .env"))).decision).toBe("deny");
    expect(
      (await run({ cwd: repo.root, tool_name: "Read", tool_input: { file_path: ".env" } }))
        .decision,
    ).toBe("allow");
    expect(await readDecisions(repo.root)).toEqual([]);
  });

  it("toolResponse parses string results; reportedChanges marks deletes", () => {
    expect(toolResponse({ toolResult: '{"filePath":"a"}' })).toEqual({ filePath: "a" });
    expect(toolResponse({ tool_response: "plain text" })).toBeUndefined();
    expect(
      reportedChanges({
        bashEditDiff: { changedFiles: ["/r/a"], files: [{ filePath: "/r/a", deleted: true }] },
      }),
    ).toEqual([{ rawPath: "/r/a", op: "delete", content: undefined }]);
  });
});
