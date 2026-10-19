import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDecision, type DecisionRecord } from "./decisions.js";
import {
  type ExplainRecord,
  explainDecision,
  explainMain,
  fixFor,
  selectDecision,
} from "./explain.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-explain-");
});
afterEach(async () => {
  await repo.cleanup();
});

const rec = (over: Partial<ExplainRecord> = {}): ExplainRecord => ({
  v: 1,
  decided_at: "2026-10-19T10:00:00.000Z",
  agent_id: "copilot:s1",
  principal: { subject: "u" },
  tool: "create_file",
  args_hash: `sha256:${"0".repeat(64)}`,
  args_state: "recorded",
  decision: "deny",
  paths: ["a.txt"],
  profile: "builtin",
  ...over,
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  };
};

describe("axiom explain (I-6)", () => {
  const list = [
    rec({ code: "path.deny" }),
    rec({ code: "house.gitAddAll" }),
    rec({ id: "01J", code: "ERR_CONTAINMENT" }),
  ];

  it("selects by last, -N, N and id; out of range → undefined", () => {
    expect(selectDecision(list, "last")?.index).toBe(3);
    expect(selectDecision(list, "-2")?.record.code).toBe("house.gitAddAll");
    expect(selectDecision(list, "1")?.record.code).toBe("path.deny");
    expect(selectDecision(list, "01J")?.index).toBe(3);
    expect(selectDecision(list, "9")).toBeUndefined();
    expect(selectDecision(list, "-9")).toBeUndefined();
    expect(selectDecision([], "last")).toBeUndefined();
  });

  it("gives a fix per code family; house rules use the pack's own fix text", () => {
    expect(fixFor("path.deny")).toMatch(/deny/);
    expect(fixFor("house.gitAddAll")).toBe("git add -- <path> <path>");
    expect(fixFor("command.deny", "house.resetHard")).toMatch(/reset --hard/);
    expect(fixFor("ERR_CONTAINMENT")).toMatch(/outside/);
    expect(fixFor("content.noSecrets.awsKey")).toMatch(/secret store/);
    expect(fixFor("git.destructiveTree")).toBeDefined();
    expect(fixFor("ERR_PROFILE_VERSION")).toMatch(/upgrade/);
    expect(fixFor("something.unknown")).toBeUndefined();
    expect(explainDecision(list, "-2")?.fix).toBe("git add -- <path> <path>");
  });

  it("prints the journaled decision (ASCII) and exits 0; relaxed + profile_decided shown", async () => {
    await appendDecision(repo.root, rec({ code: "path.deny" }) as DecisionRecord);
    await appendDecision(repo.root, {
      ...rec({
        decision: "allow",
        code: "path.deny",
        relaxed: "override",
        override_reason: "owner asked for it",
      }),
      profile_decided: "/slot/.axiom/gate-profile.json",
    } as DecisionRecord);
    const t = io();
    expect(await explainMain(["last", "--root", repo.root], t.io)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/decision #2 of 2/);
    expect(text).toMatch(/relaxed: +override \(reason: owner asked for it\)/);
    expect(text).toMatch(/decided by profile: \/slot/);
    expect(text).toMatch(/FIX:/);
    for (const l of t.out) expect(l).toMatch(/^[\x20-\x7e]*$/);
    const j = io();
    expect(await explainMain(["1", "--root", repo.root, "--json"], j.io)).toBe(0);
    expect(JSON.parse(j.out.join("\n"))).toMatchObject({ index: 1, total: 2 });
  });

  it("empty journal / no match → 1 with ERR_NOT_FOUND; bad flag or root → 2", async () => {
    const t = io();
    expect(await explainMain(["--root", repo.root], t.io)).toBe(1);
    expect(t.err[0]).toMatch(/^ERR_NOT_FOUND/);
    await appendDecision(repo.root, rec() as DecisionRecord);
    const m = io();
    expect(await explainMain(["nope-id", "--root", repo.root], m.io)).toBe(1);
    expect(await explainMain(["--bogus"], io().io)).toBe(2);
    const r = io();
    expect(await explainMain(["last", "--root", `${repo.root}/missing`], r.io)).toBe(2);
    expect(r.err[0]).toMatch(/^ERR_ROOT_NOT_DIR/);
  });
});
