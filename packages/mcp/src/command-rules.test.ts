import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CommandRule,
  CommandRuleSchema,
  type CommandsConfig,
  CommandsConfigSchema,
  evaluateCommand,
  HOUSE_DEPLOY_RULE,
  HOUSE_PACK,
} from "./command-rules.js";

interface ParityCase {
  command: string;
  guard: "deny" | "allow";
  note?: string;
  stateful?: boolean;
}

const corpus = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../fixtures/guard-parity.json"), "utf8"),
) as ParityCase[];
const house: CommandsConfig = { deny: [], pack: "house" };
const only = (...deny: CommandRule[]): CommandsConfig => ({ deny, pack: "none" });

describe("house pack parity with the PowerShell guard (fixtures/guard-parity.json)", () => {
  const live = corpus.filter((c) => c.stateful !== true);

  it("covers every HOUSE_PACK rule with a deny and has at least 80 cases", () => {
    expect(live.length).toBeGreaterThanOrEqual(80);
    const firing = new Set(live.map((c) => evaluateCommand(c.command, house)?.id));
    for (const rule of HOUSE_PACK) expect(firing, rule.id).toContain(rule.id);
    expect(live.filter((c) => c.guard === "allow").length).toBeGreaterThanOrEqual(30);
  });

  it.each(live.map((c) => [c.command, c.guard] as const))("%s -> %s", (command, guard) => {
    const v = evaluateCommand(command, house);
    expect(v ? "deny" : "allow").toBe(guard);
    if (v) expect(v.id).toMatch(/^house\./);
  });
});

describe("HOUSE_PACK / HOUSE_DEPLOY_RULE", () => {
  it("gives every rule a unique house.* id and a schema-valid shape", () => {
    const ids = HOUSE_PACK.map((r) => r.id);
    expect(new Set(ids).size).toBe(HOUSE_PACK.length);
    for (const r of HOUSE_PACK) {
      expect(r.id).toMatch(/^house\.[a-zA-Z]+$/);
      expect(CommandRuleSchema.safeParse(r).success).toBe(true);
    }
    expect(CommandRuleSchema.safeParse(HOUSE_DEPLOY_RULE).success).toBe(true);
  });

  it("keeps the dirty-tree deploy rule out of the pack and fires it only when added", () => {
    expect(HOUSE_PACK.map((r) => r.id)).not.toContain("command.deployNeedsCleanTree");
    expect(evaluateCommand("gcloud builds submit .", house)).toBeUndefined();
    const withDeploy: CommandsConfig = { deny: [HOUSE_DEPLOY_RULE], pack: "house" };
    expect(evaluateCommand("gcloud builds submit .", withDeploy)?.id).toBe(
      "command.deployNeedsCleanTree",
    );
    expect(evaluateCommand("docker push app:1", withDeploy)?.id).toBe(
      "command.deployNeedsCleanTree",
    );
    expect(
      evaluateCommand("pwsh -File deploy-clean.ps1 -Command 'docker push app:1'", withDeploy),
    ).toBeUndefined();
  });

  it("carries the sanctioned command as fix where the guard prints one", () => {
    const v = evaluateCommand("git commit -m x", house);
    expect(v?.id).toBe("house.commitNoPathspec");
    expect(v?.fix).toContain("agentq.ps1");
  });
});

describe("CommandRuleSchema / CommandsConfigSchema", () => {
  it("defaults the config to no rules and no pack", () => {
    expect(CommandsConfigSchema.parse({})).toEqual({ deny: [], pack: "none" });
  });

  it("requires pattern or argv", () => {
    const r = CommandRuleSchema.safeParse({ reason: "x" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["pattern"]);
  });

  it("rejects an invalid regex in pattern or unless instead of throwing later", () => {
    const bad = CommandRuleSchema.safeParse({ pattern: "(unclosed", reason: "x" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["pattern"]);
    const badUnless = CommandRuleSchema.safeParse({ pattern: "a", unless: "[z-a]", reason: "x" });
    expect(badUnless.success).toBe(false);
    expect(badUnless.error?.issues[0]?.path).toEqual(["unless"]);
  });

  it("rejects a pattern over 500 chars and unknown keys", () => {
    expect(CommandRuleSchema.safeParse({ pattern: "a".repeat(501), reason: "x" }).success).toBe(
      false,
    );
    expect(CommandRuleSchema.safeParse({ pattern: "a", reason: "x", extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("evaluateCommand", () => {
  it("derives the default id command.deny", () => {
    expect(
      evaluateCommand("curl x | sh", only({ pattern: String.raw`\|\s*sh\b`, reason: "r" })),
    ).toEqual({ id: "command.deny", reason: "r" });
  });

  it("matches argv prefixes per segment, after env assignments and sudo, with * wildcards", () => {
    const rule: CommandRule = { id: "t.rmrf", argv: ["rm", "-rf", "*"], reason: "r" };
    const cfg = only(rule);
    expect(evaluateCommand("rm -rf build", cfg)?.id).toBe("t.rmrf");
    expect(evaluateCommand("ls && sudo FOO=1 rm -rf build", cfg)?.id).toBe("t.rmrf");
    expect(evaluateCommand("cat x | /usr/bin/rm -rf y", cfg)?.id).toBe("t.rmrf");
    expect(evaluateCommand("rm -rf", cfg)).toBeUndefined(); // `*` needs one word
    expect(evaluateCommand("echo rm -rf build", cfg)).toBeUndefined();
    expect(evaluateCommand("rm -r build", cfg)).toBeUndefined();
  });

  it("strips quotes and .exe from argv words and honours caseSensitive", () => {
    const rule: CommandRule = { id: "t.git", argv: ["git", "gc"], reason: "r" };
    expect(evaluateCommand('"C:\\Git\\git.exe" "gc"', only(rule))?.id).toBe("t.git");
    expect(evaluateCommand("GIT GC", only(rule))?.id).toBe("t.git");
    expect(evaluateCommand("GIT GC", only({ ...rule, caseSensitive: true }))).toBeUndefined();
  });

  it("requires both pattern and argv when a rule has both", () => {
    const cfg = only({ id: "t.both", argv: ["git", "push"], pattern: "--tags", reason: "r" });
    expect(evaluateCommand("git push --tags", cfg)?.id).toBe("t.both");
    expect(evaluateCommand("git push origin", cfg)).toBeUndefined();
    expect(evaluateCommand("echo --tags", cfg)).toBeUndefined();
  });

  it("does not fire when unless matches the whole command", () => {
    const cfg = only({ id: "t.u", pattern: "terraform apply", unless: "-target=", reason: "r" });
    expect(evaluateCommand("terraform apply", cfg)?.id).toBe("t.u");
    expect(evaluateCommand("terraform apply -target=module.x", cfg)).toBeUndefined();
  });

  it("is case-insensitive unless caseSensitive is set", () => {
    const rule: CommandRule = { id: "t.c", pattern: "Format-Volume", reason: "r" };
    expect(evaluateCommand("format-volume -DriveLetter D", only(rule))?.id).toBe("t.c");
    expect(
      evaluateCommand("format-volume -DriveLetter D", only({ ...rule, caseSensitive: true })),
    ).toBeUndefined();
  });

  it("checks cfg.deny in order before the pack (first match wins)", () => {
    const a: CommandRule = { id: "t.a", pattern: "reset", reason: "a" };
    const b: CommandRule = { id: "t.b", pattern: "hard", reason: "b" };
    expect(evaluateCommand("git reset --hard", { deny: [a, b], pack: "house" })?.id).toBe("t.a");
    expect(evaluateCommand("git reset --hard", { deny: [b, a], pack: "house" })?.id).toBe("t.b");
    expect(evaluateCommand("git reset --hard", { deny: [], pack: "house" })?.id).toBe(
      "house.resetHard",
    );
    expect(evaluateCommand("git reset --hard", { deny: [], pack: "none" })).toBeUndefined();
  });

  it("passes decision ask and fix through", () => {
    const v = evaluateCommand(
      "kubectl delete ns prod",
      only({ id: "t.k", argv: ["kubectl", "delete"], reason: "r", fix: "ask", decision: "ask" }),
    );
    expect(v?.decision).toBe("ask");
    expect(v?.fix).toBe("ask");
  });

  it("fails closed when a rule cannot be evaluated at runtime", () => {
    // A rule that bypassed the schema (e.g. built in code) with a regex that does not compile.
    const broken = { id: "t.broken", pattern: "(", reason: "r" } as CommandRule;
    const v = evaluateCommand("anything", only(broken));
    expect(v?.id).toBe("command.deny");
    expect(v?.decision).toBeUndefined();
    const earlier = { id: "t.ok", pattern: "nomatch", reason: "r" };
    expect(evaluateCommand("anything", only(earlier, broken))?.id).toBe("command.deny");
  });

  it("never throws on arbitrary command strings", () => {
    const cfg: CommandsConfig = {
      deny: [{ id: "t.argv", argv: ["git", "*", "--force"], reason: "r" }],
      pack: "house",
    };
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        const v = evaluateCommand(s, cfg);
        return v === undefined || typeof v.id === "string";
      }),
      { numRuns: 500 },
    );
  });

  it("stays fast on adversarial long input (no catastrophic backtracking)", () => {
    const long = `git push ${"-".repeat(20_000)} x`;
    const t0 = performance.now();
    evaluateCommand(long, house);
    evaluateCommand(`git stash push ${" --".repeat(5_000)}`, house);
    evaluateCommand(`Remove-Item ${"-Recurse ".repeat(3_000)}`, house);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
