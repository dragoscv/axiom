import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDecision, type DecisionRecord } from "./decisions.js";
import { DEFAULT_GATE_PROFILE } from "./gate.js";
import {
  rebuildPayloads,
  relaxVerdict,
  replayMain,
  replaySession,
  sanitizeProfile,
  sessionMatches,
} from "./replay.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-replay-");
  home = await tmpRepo("axiom-replay-home-");
  await mkdir(join(repo.root, ".git"));
});
afterEach(async () => {
  await Promise.all([repo.cleanup(), home.cleanup()]);
});

const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  v: 1,
  decided_at: "2026-10-19T10:00:00.000Z",
  agent_id: "copilot:s1",
  principal: { subject: "u" },
  tool: "create_file",
  args_hash: `sha256:${"0".repeat(64)}`,
  args_state: "recorded",
  decision: "allow",
  paths: ["src/a.ts"],
  profile: "builtin",
  ...over,
});
const setProfile = (p: unknown) =>
  writeFile(join(repo.root, ".axiom", "gate-profile.json"), JSON.stringify(p));

describe("axiom journal replay (I-9)", () => {
  it("session selector matches the full agent_id or the session part only", () => {
    expect(sessionMatches("copilot:s1", "s1")).toBe(true);
    expect(sessionMatches("copilot:s1", "copilot:s1")).toBe(true);
    expect(sessionMatches("copilot:s10", "s1")).toBe(false);
  });

  it("re-judges path decisions with the current profile and reports the diff", async () => {
    await appendDecision(repo.root, rec({ paths: ["secrets/k.txt"] }));
    await appendDecision(repo.root, rec({ paths: ["src/a.ts"] }));
    await appendDecision(repo.root, rec({ agent_id: "copilot:other", paths: ["secrets/x"] }));
    await setProfile({ deny: ["secrets/**"] });
    const r = await replaySession({ root: repo.root, session: "s1", home: home.root });
    expect(r.rows.map((x) => [x.index, x.old, x.new, x.newCode, x.changed])).toEqual([
      [1, "allow", "deny", "path.deny", true],
      [2, "allow", "allow", undefined, false],
    ]);
    expect(r.changed).toBe(1);
  });

  it("warn mode / override relax like the gate; hard codes never relax", async () => {
    await appendDecision(
      repo.root,
      rec({ decision: "deny", code: "path.deny", paths: ["secrets/a"] }),
    );
    await appendDecision(
      repo.root,
      rec({
        decision: "allow",
        code: "path.deny",
        relaxed: "override",
        override_reason: "owner said so ok",
        paths: ["secrets/b"],
      }),
    );
    await setProfile({ deny: ["secrets/**"], mode: "warn" });
    const r = await replaySession({ root: repo.root, session: "s1", home: home.root });
    expect(r.rows.map((x) => x.new)).toEqual(["warn", "warn"]);
    await setProfile({ deny: ["secrets/**"], override: true, hard: ["path.deny"] });
    const h = await replaySession({ root: repo.root, session: "s1", home: home.root });
    expect(h.rows.map((x) => x.new)).toEqual(["deny", "deny"]);
    expect(relaxVerdict("deny", "x", { ...DEFAULT_GATE_PROFILE, override: true }, true)).toBe(
      "override",
    );
    expect(relaxVerdict("ask", "path.ask", { ...DEFAULT_GATE_PROFILE, mode: "warn" }, false)).toBe(
      "ask",
    );
  });

  it("replays journaled shell commands; content, post and command-less shell lines are skipped", async () => {
    await appendDecision(
      repo.root,
      rec({
        tool: "run_in_terminal",
        command: "git reset --hard",
        paths: ["."],
        decision: "allow",
        relaxed: "warn",
        code: "house.resetHard",
      }),
    );
    await appendDecision(repo.root, rec({ decision: "deny", code: "content.noSecrets.awsKey" }));
    await appendDecision(repo.root, rec({ phase: "post" }));
    await appendDecision(repo.root, rec({ tool: "run_in_terminal", paths: [] }));
    await setProfile({ deny: [".git/**"], commands: { pack: "house" }, hard: ["house.resetHard"] });
    const r = await replaySession({ root: repo.root, session: "s1", home: home.root });
    expect(r.rows[0]).toMatchObject({ old: "warn", new: "deny", changed: true });
    expect(r.rows.slice(1).map((x) => x.skipped !== undefined)).toEqual([true, true, true]);
    expect(r.skipped).toBe(3);
  });

  it("is read-only: no journal lines, undo or session state appended under .axiom", async () => {
    await appendDecision(
      repo.root,
      rec({ paths: ["src/a.ts"], decision: "deny", code: "path.deny" }),
    );
    await setProfile({
      deny: ["src/**"],
      record: true,
      undo: true,
      mode: "warn",
      sessions: { blindOverwrite: "deny" },
    });
    const before = (await readdir(join(repo.root, ".axiom"))).sort();
    const r = await replaySession({ root: repo.root, session: "s1", home: home.root });
    expect(r.rows[0]?.new).toBe("warn");
    expect((await readdir(join(repo.root, ".axiom"))).sort()).toEqual(before);
    const { readDecisions } = await import("./decisions.js");
    expect((await readDecisions(repo.root)).length).toBe(1);
    expect(sanitizeProfile({ ...DEFAULT_GATE_PROFILE, record: true })).toMatchObject({
      record: false,
      undo: false,
      steer: "off",
    });
    expect(rebuildPayloads(rec({ tool: "read_file" }), repo.root)).toHaveProperty("skip");
  });

  it("CLI: exit 1 when a verdict changed, 0 when none, 2 without --session; ASCII output", async () => {
    await appendDecision(repo.root, rec({ paths: ["secrets/k.txt"] }));
    const out: string[] = [];
    const io = {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
      home: home.root,
    };
    expect(await replayMain(["--session", "s1", "--root", repo.root], io)).toBe(0);
    await setProfile({ deny: ["secrets/**"] });
    expect(await replayMain(["--session", "s1", "--root", repo.root], io)).toBe(1);
    for (const l of out) expect(l).toMatch(/^[\x20-\x7e]*$/);
    expect(await replayMain(["--root", repo.root], io)).toBe(2);
    const p = join(home.root, "p.json");
    await writeFile(p, JSON.stringify({ deny: [] }));
    out.length = 0;
    expect(
      await replayMain(["--session", "s1", "--root", repo.root, "--profile", p, "--json"], io),
    ).toBe(0);
    expect(JSON.parse(out.join("\n")).profile).toBe(p);
  });
});
