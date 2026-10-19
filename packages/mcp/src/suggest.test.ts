import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDecision, type DecisionRecord } from "./decisions.js";
import {
  aggregate,
  isScratchPath,
  proposeProfile,
  scratchGlobFor,
  suggestMain,
} from "./suggest.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-suggest-");
  home = await tmpRepo("axiom-suggest-home-");
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
const times = (n: number, r: DecisionRecord) => Array.from({ length: n }, () => r);
const empty = { hard: [], ask: [] };

describe("suggest-profile (I-3)", () => {
  it("relaxed often and never overridden → keep warn; below min → nothing", () => {
    const records = times(5, rec({ code: "path.deny", relaxed: "warn", paths: ["docs/x.md"] }));
    expect(proposeProfile(records, empty, 5).keepWarn).toEqual(["path.deny"]);
    expect(proposeProfile(records.slice(1), empty, 5).keepWarn).toEqual([]);
  });

  it("the same override reason repeatedly on one glob → candidate ask glob (once)", () => {
    const records = times(
      6,
      rec({
        code: "path.deny",
        relaxed: "override",
        override_reason: "Owner approved infra edit",
        paths: ["infra/prod/main.tf"],
      }),
    );
    const p = proposeProfile(records, empty, 5);
    expect(p.patch).toEqual([
      expect.objectContaining({ op: "add", path: "/ask/-", value: "infra/prod/**" }),
    ]);
    expect(p.keepWarn).toEqual([]);
    expect(proposeProfile(records, { hard: [], ask: ["infra/prod/**"] }, 5).patch).toEqual([]);
  });

  it("PII-class hits concentrated in tests/scratch → noSecretsExclude; token-class never", () => {
    const records = [
      ...times(
        4,
        rec({
          code: "content.noSecrets.email",
          decision: "deny",
          paths: ["packages/x/src/a.test.ts"],
        }),
      ),
      ...times(
        4,
        rec({ code: "content.noSecrets.email", decision: "deny", paths: [".copilot-tmp/n.md"] }),
      ),
      rec({ code: "content.noSecrets.email", decision: "deny", paths: ["src/real.ts"] }),
      ...times(
        9,
        rec({ code: "content.noSecrets.awsKey", decision: "deny", paths: ["tests/fx.ts"] }),
      ),
    ];
    const p = proposeProfile(records, empty, 5);
    expect(p.patch.filter((x) => x.path === "/noSecretsExclude/-").map((x) => x.value)).toEqual([
      "**/*.test.ts",
      ".copilot-tmp/**",
    ]);
  });

  it("a destructive code let through → add to hard (unless already hard)", () => {
    const records = [
      rec({ code: "house.resetHard", rule: "house.resetHard", relaxed: "warn", paths: ["."] }),
    ];
    expect(proposeProfile(records, empty, 5).patch).toEqual([
      expect.objectContaining({ path: "/hard/-", value: "house.resetHard" }),
    ]);
    expect(proposeProfile(records, { hard: ["house.*"], ask: [] }, 5).patch).toEqual([]);
  });

  it("aggregate counts by rule/code; plain allows are ignored; scratch helpers", () => {
    const a = aggregate([
      rec(),
      rec({ code: "x", decision: "deny" }),
      rec({ code: "x", decision: "ask" }),
    ]);
    expect(a).toEqual([
      expect.objectContaining({ code: "x", deny: 1, ask: 1, warn: 0, override: 0 }),
    ]);
    expect(isScratchPath("a/__tests__/b.ts")).toBe(true);
    expect(isScratchPath("src/b.ts")).toBe(false);
    expect(scratchGlobFor("tests/a/b.ts")).toBe("tests/**");
    expect(scratchGlobFor("pkg/fixtures/b.json")).toBe("**/fixtures/**");
  });

  it("CLI: reads the journal window, never writes the profile, --json; bad args → 2", async () => {
    const profile = join(repo.root, ".axiom", "gate-profile.json");
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(profile, JSON.stringify({ mode: "warn" }));
    for (const r of times(
      5,
      rec({ code: "path.deny", relaxed: "warn", decided_at: "2026-10-18T00:00:00.000Z" }),
    ))
      await appendDecision(repo.root, r);
    await appendDecision(
      repo.root,
      rec({ code: "old", decision: "deny", decided_at: "2026-01-01T00:00:00.000Z" }),
    );
    const before = await readFile(profile, "utf8");
    const out: string[] = [];
    const io = {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
      home: home.root,
      now: Date.parse("2026-10-19T12:00:00Z"),
    };
    expect(await suggestMain(["--root", repo.root, "--json"], io)).toBe(0);
    const r = JSON.parse(out.join("\n"));
    expect(r.total).toBe(5);
    expect(r.keepWarn).toEqual(["path.deny"]);
    expect(await readFile(profile, "utf8")).toBe(before);
    out.length = 0;
    expect(await suggestMain(["--root", repo.root], io)).toBe(0);
    expect(out.join("\n")).toMatch(/proposal only/);
    for (const l of out) expect(l).toMatch(/^[\x20-\x7e]*$/);
    expect(await suggestMain(["--days", "0"], io)).toBe(2);
    expect(await suggestMain(["--wat"], io)).toBe(2);
  });
});
