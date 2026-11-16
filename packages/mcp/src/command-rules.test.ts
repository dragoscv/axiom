import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CORE_PACK,
  type CommandRule,
  CommandRuleSchema,
  type CommandsConfig,
  CommandsConfigSchema,
  evaluateCommand,
  evaluateCommandRules,
  HOUSE_DEPLOY_RULE,
  HOUSE_PACK,
  NON_OVERRIDABLE_RULE_IDS,
  SHARED_CLONE_PACK,
} from "./command-rules.js";
import { isSelfHardCode } from "./self-protect.js";
import { UNDECODABLE } from "./shell-lex.js";

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
/** v3 rules the PowerShell guard does not have; covered by the bypass tables below instead. */
const AXIOM_ONLY = new Set([
  "house.pushDelete",
  "house.undecodable",
  "self.uninstall",
  "self.adminVerb",
]);
const enc = (s: string): string => Buffer.from(s, "utf16le").toString("base64");
const ids = (command: string): string[] => evaluateCommandRules(command, house).map((v) => v.id);

describe("house pack parity with the PowerShell guard (fixtures/guard-parity.json)", () => {
  const live = corpus.filter((c) => c.stateful !== true);

  it("covers every HOUSE_PACK rule with a deny and has at least 80 cases", () => {
    expect(live.length).toBeGreaterThanOrEqual(80);
    const firing = new Set(live.flatMap((c) => ids(c.command)));
    for (const rule of HOUSE_PACK) {
      if (!AXIOM_ONLY.has(rule.id ?? "")) expect(firing, rule.id).toContain(rule.id);
    }
    expect(live.filter((c) => c.guard === "allow").length).toBeGreaterThanOrEqual(30);
  });

  it.each(live.map((c) => [c.command, c.guard] as const))("%s -> %s", (command, guard) => {
    const v = evaluateCommand(command, house);
    expect(v ? "deny" : "allow").toBe(guard);
    if (v) expect(v.id).toMatch(/^house\./);
  });
});

describe("v3 semantic house rules (shell-lex) close the 2.7.0 bypasses", () => {
  const PUSH = "git push --force origin main";
  const cases: readonly (readonly [string, string])[] = [
    ["git push -uf origin main", "house.forcePush"],
    ["git push -fu origin main", "house.forcePush"],
    ["git push origin +main", "house.forcePush"],
    ["git push origin +HEAD:refs/heads/main", "house.forcePush"],
    ["git push --mirror", "house.forcePush"],
    ["git -C . push --force", "house.forcePush"],
    ["git -c x=y push --force origin main", "house.forcePush"],
    ["git --no-pager push --force", "house.forcePush"],
    ["git --git-dir=.git --work-tree . push -f", "house.forcePush"],
    ["git.exe push --force", "house.forcePush"],
    ['& "C:\\Program Files\\Git\\cmd\\git.exe" push --force', "house.forcePush"],
    ["& 'git' push --force", "house.forcePush"],
    ['"git" push --force', "house.forcePush"],
    ['git push "--force"', "house.forcePush"],
    ["git push '--force'", "house.forcePush"],
    ['git push -"f"', "house.forcePush"],
    ['git push --forc"e"', "house.forcePush"],
    ["git p`ush --force", "house.forcePush"],
    ["git push --for`ce", "house.forcePush"],
    ["git push --force-with-lease", "house.forcePush"],
    ["git push --force-with-lease=main:abc origin main", "house.forcePush"],
    ["iex 'git push --force'", "house.forcePush"],
    ['Invoke-Expression "git push --force"', "house.forcePush"],
    [`pwsh -EncodedCommand ${enc("git push --force origin main")}`, "house.forcePush"],
    [`pwsh -NoProfile -ExecutionPolicy Bypass -enc ${enc(PUSH)}`, "house.forcePush"],
    [`powershell -enc ${enc(PUSH)}`, "house.forcePush"],
    ['pwsh -NoProfile -Command "git push -f"', "house.forcePush"],
    ['cmd /c "git push -f"', "house.forcePush"],
    ["cmd.exe /c git push -f", "house.forcePush"],
    ["bash -c 'git push -f'", "house.forcePush"],
    ["sh -lc 'cd x && git push -f'", "house.forcePush"],
    ["bash -c \"pwsh -c 'git push -f'\"", "house.forcePush"],
    ["echo ok\ngit push -f", "house.forcePush"],
    ["echo ok\r\ngit push -f", "house.forcePush"],
    ["echo ok & git push -f", "house.forcePush"],
    ["$r = git push -f", "house.forcePush"],
    ["(git push -f)", "house.forcePush"],
    ["echo 'git push -f' | bash", "house.forcePush"],
    ["bash <<'EOF'\ngit push -f\nEOF", "house.forcePush"],
    ["git push --delete origin main", "house.pushDelete"],
    ["git push -d origin main", "house.pushDelete"],
    ["git push origin :main", "house.pushDelete"],
    ["git reset HEAD --hard", "house.resetHard"],
    ['git reset "--hard"', "house.resetHard"],
    ["git reset --ha`rd", "house.resetHard"],
    ["git -C . reset --hard", "house.resetHard"],
    ["git clean -d -f", "house.cleanForce"],
    ["git clean --force", "house.cleanForce"],
    ["git clean -fdx", "house.cleanForce"],
    ["git -C . clean -fd", "house.cleanForce"],
    ["git worktree remove --force x", "house.worktreeRemoveForce"],
    ["git worktree remove -f x", "house.worktreeRemoveForce"],
    ["git worktree remove x --force", "house.worktreeRemoveForce"],
    ["git stash drop", "house.stashDrop"],
    ["git stash drop stash@{1}", "house.stashDrop"],
    ["git stash clear", "house.stashDrop"],
    ["git -C repo stash clear", "house.stashDrop"],
    ["pwsh -enc !!notbase64!!", "house.undecodable"],
    [`pwsh -enc ${Buffer.from([1, 0, 2, 0]).toString("base64")}`, "house.undecodable"],
    ["pwsh -EncodedCommand", "house.undecodable"],
  ];

  it.each(cases)("%j -> %s", (command, id) => {
    expect(ids(command)).toContain(id);
  });

  const negatives: readonly string[] = [
    "git push origin main",
    "git push --follow-tags",
    "git push -u origin feat/x",
    "git push --force-if-includes origin main",
    "git push origin main:main",
    "git push origin refs/tags/v1:refs/tags/v1",
    "git reset --soft HEAD~1",
    "git reset HEAD -- a.ts",
    "git clean -n",
    "git clean -dn",
    'echo "git push --force"',
    "echo 'git push --force'",
    'Write-Host "git reset --hard"',
    "cat <<'EOF'\ngit push -f\nEOF",
    "cat <<EOF > notes.md\ngit push -f\ngit reset --hard\nEOF",
    "$t = @'\ngit push -f\n'@",
    'git commit -m "fix: force push docs" -- a.ts',
    "git log --grep=force -- push.ts",
    "git worktree list",
    "git stash list",
    "git stash show -p stash@{0}",
    "rg -n 'git push -f' docs",
    "git push origin main # never --force here",
  ];

  it.each(negatives)("%j -> no destructive house rule", (command) => {
    const hit = ids(command).filter((id) =>
      [
        "house.forcePush",
        "house.pushDelete",
        "house.resetHard",
        "house.cleanForce",
        "house.worktreeRemoveForce",
        "house.stashDrop",
        "house.undecodable",
      ].includes(id),
    );
    expect(hit).toEqual([]);
  });

  it("returns every match in pack order so a softer first match cannot shadow a hard one", () => {
    expect(ids("git worktree remove --force ../x")).toEqual([
      "house.worktreeRemoveForce",
      "house.worktreeRawRemove",
    ]);
    expect(ids("git stash drop")).toEqual(["house.stashDrop", "house.stashBare"]);
    const both = ids("git reset --hard; git push -f");
    expect(both).toEqual(["house.forcePush", "house.resetHard"]);
    expect(evaluateCommand("git reset --hard; git push -f", house)?.id).toBe("house.forcePush");
  });

  it("marks undecodable nested commands ask, with a fix", () => {
    const v = evaluateCommandRules("powershell -enc ####", house).find(
      (x) => x.id === "house.undecodable",
    );
    expect(v?.decision).toBe("ask");
    expect(v?.fix).toBe("decode the command and run it plainly");
    expect(HOUSE_PACK.find((r) => r.id === "house.undecodable")?.pattern).toBe(UNDECODABLE);
  });

  it("treats nesting deeper than 3 levels as undecodable", () => {
    const three = `bash -c "sh -c 'pwsh -c \\"git push -f\\"'"`;
    expect(ids(three)).toContain("house.forcePush");
    const four = `bash -c "sh -c 'pwsh -c \\"cmd /c git push -f\\"'"`;
    expect(ids(four)).toEqual(["house.undecodable"]);
    let cmd = "git status";
    for (let i = 0; i < 5; i++) cmd = `pwsh -enc ${enc(cmd)}`;
    expect(ids(cmd)).toEqual(["house.undecodable"]);
  });

  it("keeps a user rule that reuses a house id on its own pattern", () => {
    const mine: CommandRule = { id: "house.forcePush", pattern: "never-matches-xyz", reason: "r" };
    expect(evaluateCommand("git push -f", only(mine))).toBeUndefined();
  });
});

describe("HOUSE_PACK / HOUSE_DEPLOY_RULE", () => {
  it("gives every rule a unique house.* id and a schema-valid shape", () => {
    const ids = HOUSE_PACK.map((r) => r.id);
    expect(new Set(ids).size).toBe(HOUSE_PACK.length);
    for (const r of HOUSE_PACK) {
      // `house.*` keeps its 3.x name (journals reference it); the 4.0 self-protection rules are
      // `self.*` and are part of the core pack.
      expect(r.id).toMatch(/^(?:house|self)\.[a-zA-Z]+$/);
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
    // Deploy-class reads the guard allows even on a dirty tree (S-1219 parity cases).
    for (const c of corpus.filter((x) => x.note?.startsWith("deploy-class READ"))) {
      expect(evaluateCommand(c.command, withDeploy), c.command).toBeUndefined();
    }
    expect(corpus.filter((x) => x.note?.startsWith("deploy-class READ")).length).toBe(3);
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

describe("A2-32 / OPS-8: every house rule matches a command unit, not the raw string", () => {
  const idsOf = (command: string): string[] =>
    evaluateCommandRules(command, house).map((v) => v.id);

  it("refuses a bare statement that the 3.0 regex missed (the real bypass)", () => {
    // `git add -A;` did not satisfy `(?:-A|--all|\.)(?:\s|$)` in 3.0, so the rule let it through.
    expect(idsOf("git add -A; echo done")).toContain("house.gitAddAll");
    expect(idsOf("git add -A && echo done")).toContain("house.gitAddAll");
    expect(idsOf("echo done; git commit -am x")).toContain("house.gitCommitAll");
  });

  it("does not fire on the rule's text inside a comment or a quoted argument", () => {
    for (const command of [
      "echo done # git stash drop",
      "rg -n 'git stash drop' docs",
      'Write-Host "git reset --hard"',
      "Write-Host 'git stash drop'",
      "cat <<EOF > notes.md\ngit stash drop\nEOF",
      "git commit -m 'fix: force push docs' -- a.ts",
      "echo 'git worktree add ../x'",
    ]) {
      expect(idsOf(command), command).toEqual([]);
    }
  });

  it("does not exempt a command because a wrapper is named elsewhere (EN-6)", () => {
    expect(idsOf("pwsh -File agentq.ps1 run -Resource build -- pnpm build")).toEqual([]);
    expect(idsOf("pnpm build # run-build.ps1")).toContain("house.buildUnqueued");
    expect(idsOf("pnpm build; echo run-build.ps1")).toContain("house.buildUnqueued");
    expect(idsOf("git commit -m x # agentq.ps1")).toContain("house.commitNoPathspec");
    expect(idsOf("echo agentq.ps1; git worktree add ../x")).toContain("house.worktreeRawAdd");
    expect(idsOf("pwsh -File run-build.ps1 -Command 'pnpm build'")).toEqual([]);
  });

  it("clears the four shapes the field data reported as false denies (OPS-8)", () => {
    // 100%: the flag of the NEXT statement after a `--`.
    expect(
      idsOf("git stash push -m 'x' -- docs/a.md; git checkout -q -b lane/x origin/dev"),
    ).not.toContain("house.stashFlagsAfterDashDash");
    // 100%: `--staged` alone only unstages.
    expect(idsOf("git restore --staged -- docs/INVENTAR.md")).not.toContain("house.restore");
    expect(idsOf("git restore --staged --worktree -- a.md")).toContain("house.restore");
    // 82%: resolving a conflict is not discarding work.
    expect(idsOf("git checkout --theirs -- apps/web/a.spec.ts")).not.toContain(
      "house.checkoutDiscard",
    );
    expect(idsOf("git checkout -q -b lane/x origin/dev")).not.toContain("house.checkoutDiscard");
    // 67%: `-A` with an explicit pathspec stages only what the pathspec names.
    expect(idsOf("git add -A -- src/a.ts")).not.toContain("house.gitAddAll");
    // 100%: a search pattern is not a Playwright run.
    expect(idsOf("rg -n 'playwright test' scripts/e2e-cloud/run.mjs")).not.toContain(
      "house.playwrightLocal",
    );
  });

  it("keeps refusing the real thing after the semantic rewrite", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["git add .", "house.gitAddAll"],
      ["git add --all", "house.gitAddAll"],
      ["git commit -a -m wip", "house.gitCommitAll"],
      ["git checkpoint; git add -A", "house.gitAddAll"],
      ["git checkout .", "house.checkoutDiscard"],
      ["git checkout HEAD -- a.ts", "house.checkoutDiscard"],
      ["git restore src/a.ts", "house.restore"],
      ["git stash push -- a.ts -m wip", "house.stashFlagsAfterDashDash"],
      ["git stash pop", "house.stashBare"],
      ["git stash drop 'stash@{2}'", "house.stashDrop"],
      ['psql -c "DROP TABLE users"', "house.sqlDestructive"],
      ["TRUNCATE TABLE logs", "house.sqlDestructive"],
      ["rm -rf $HOME", "house.rmRoot"],
      ["rm -rf ~/", "house.rmRoot"],
      ['rm -rf "$HOME/"', "house.rmRoot"],
      ["Remove-Item -Recurse -Force $env:USERPROFILE", "house.removeItemRoot"],
      ["Remove-Item -Recurse -Force C:\\", "house.removeItemRoot"],
      ["git commit -m x", "house.commitNoPathspec"],
      ["git worktree move a b", "house.worktreeRawRemove"],
      ["git worktree add ../x main", "house.worktreeRawAdd"],
      ["npx playwright test", "house.playwrightLocal"],
      ["pnpm a11y:routes", "house.playwrightLocal"],
    ];
    for (const [command, id] of cases) {
      expect(idsOf(command), command).toContain(id);
    }
  });

  it("does not fire a SQL rule where the statement is only named", () => {
    expect(idsOf("rg -n 'DROP TABLE users' docs")).toEqual([]);
    expect(idsOf("echo 'TRUNCATE TABLE logs'")).toEqual([]);
    expect(idsOf("Get-Content -Raw notes.md").filter((i) => i.startsWith("house.sql"))).toEqual([]);
  });
});

describe("OPS-9 / D-53: house.typecheckUnqueued is advisory, house.buildUnqueued still blocks", () => {
  const idsOf = (command: string): string[] =>
    evaluateCommandRules(command, house).map((v) => v.id);
  const verdict = (command: string, id: string) =>
    evaluateCommandRules(command, house).find((v) => v.id === id);

  it("splits the exact command the field data counted 722 times out of 865 records", () => {
    const probe =
      "cd E:\\gh\\.wt\\codai\\task-1\\apps\\hub; pnpm exec tsc --noEmit -p . 2>&1 | Select-Object -First 60 # axiom-override: single-package typecheck, not a build";
    const v = verdict(probe, "house.typecheckUnqueued");
    expect(v?.advisory).toBe(true);
    expect(v?.oncePerSession).toBe(true);
    expect(idsOf(probe)).not.toContain("house.buildUnqueued");
  });

  it("routes every typecheck shape to the advisory rule and every build shape to the blocking one", () => {
    const typechecks: readonly string[] = [
      "tsc --noEmit",
      "npx tsc --noEmit",
      "pnpm typecheck",
      "pnpm --filter @codai/axiom-mcp typecheck",
      "pnpm run typecheck",
      "node --max-old-space-size=8192 node_modules/typescript/lib/tsc.js --noEmit",
      "Start-Process pwsh -ArgumentList '-NoProfile','-Command','pnpm exec tsc --noEmit'",
      "pwsh -File x.ps1 -Cmd 'pnpm exec tsc --noEmit'",
    ];
    for (const command of typechecks) {
      expect(idsOf(command), command).toContain("house.typecheckUnqueued");
      expect(idsOf(command), command).not.toContain("house.buildUnqueued");
    }
    const builds: readonly string[] = [
      "pnpm build",
      "npm run build",
      "turbo run build",
      "next build",
      "pnpm test:e2e",
      "pwsh -File run3.ps1 -Dir packages/sdk -Cmd 'pnpm run build'",
    ];
    for (const command of builds) {
      expect(idsOf(command), command).toContain("house.buildUnqueued");
      expect(idsOf(command), command).not.toContain("house.typecheckUnqueued");
    }
    // A launcher's quoted argument is not enough when the program it names is not a build tool.
    expect(idsOf("bash -c 'rg -n \"pnpm build\" docs'")).toEqual([]);
    for (const command of ["pnpm test", "pnpm lint", "pnpm install", "docker build -t app ."]) {
      expect(idsOf(command), command).toEqual([]);
    }
  });

  it("keeps the wrapper exemption, tested on the unit that actually runs", () => {
    expect(idsOf("pwsh -NoProfile -File run-build.ps1 -Command 'pnpm exec tsc --noEmit'")).toEqual(
      [],
    );
  });

  it("carries advisory through the schema for a user rule too", () => {
    const parsed = CommandRuleSchema.parse({
      id: "t.adv",
      pattern: "x",
      reason: "r",
      advisory: true,
      oncePerSession: true,
    });
    expect(parsed.advisory).toBe(true);
    const v = evaluateCommand("x", only(parsed));
    expect(v?.advisory).toBe(true);
    expect(v?.oncePerSession).toBe(true);
  });
});

describe("A2-23: AXIOM's own operator verbs and the bin itself", () => {
  const verdict = (command: string, id: string) =>
    evaluateCommandRules(command, house).find((v) => v.id === id);

  it("asks before an operator verb changes the gate's own state", () => {
    for (const command of [
      "axiom journal undo --force",
      "axiom gc",
      "axiom setup init --force",
      "axiom keys trust add k1",
      "axiom journal rotate",
      "axiom daemon stop",
      "npx -y @codai/axiom-mcp gc",
    ]) {
      const v = verdict(command, "self.adminVerb");
      expect(v, command).toBeDefined();
      expect(v?.decision, command).toBe("ask");
    }
  });

  it("denies removing or downgrading the bin", () => {
    for (const command of [
      "npm uninstall -g @codai/axiom-mcp",
      "npm un -g axiom",
      "pnpm remove -g @codai/axiom-mcp",
      "yarn global remove @codai/axiom-mcp",
      "npm i -g @codai/axiom-mcp@2",
      "npm install --global @codai/axiom-mcp@2.7.0",
    ]) {
      expect(verdict(command, "self.uninstall"), command).toBeDefined();
    }
  });

  it("leaves the gate's own read verbs and third-party packages alone", () => {
    for (const command of [
      "axiom gate --stdin --format auto",
      "axiom journal status",
      "axiom setup doctor",
      "axiom check --root .",
      "npm uninstall -g some-other-tool",
      "npm i -g @codai/axiom-mcp",
      'echo "axiom gc"',
      "rg -n 'axiom journal undo' docs",
      "echo done # axiom gc",
    ]) {
      const ids = evaluateCommandRules(command, house).map((v) => v.id);
      expect(ids, command).not.toContain("self.adminVerb");
      expect(ids, command).not.toContain("self.uninstall");
    }
  });

  it("hands the override governance a rule-side list that is exactly the hard set", () => {
    expect(NON_OVERRIDABLE_RULE_IDS).toContain("self.uninstall");
    for (const id of NON_OVERRIDABLE_RULE_IDS) {
      expect(isSelfHardCode(id), id).toBe(true);
    }
    expect(NON_OVERRIDABLE_RULE_IDS).not.toContain("self.adminVerb");
    expect(isSelfHardCode("self.adminVerb")).toBe(false);
  });
});

describe("S-1411: the core / shared-clone split", () => {
  const idsFor = (command: string, pack: CommandsConfig["pack"]): string[] =>
    evaluateCommandRules(command, { deny: [], pack }).map((v) => v.id);

  it("keeps house = core + shared-clone and every rule id unchanged", () => {
    expect([...CORE_PACK, ...SHARED_CLONE_PACK]).toEqual([...HOUSE_PACK]);
    const core = new Set(CORE_PACK.map((r) => r.id));
    const shared = new Set(SHARED_CLONE_PACK.map((r) => r.id));
    expect(core.size + shared.size).toBe(HOUSE_PACK.length);
    for (const id of core) expect(shared.has(id), String(id)).toBe(false);
    for (const r of HOUSE_PACK) expect(r.id).toMatch(/^(house|self)\./);
  });

  it("evaluates only the selected base pack", () => {
    expect(idsFor("git push --force origin main", "core")).toEqual(["house.forcePush"]);
    expect(idsFor("git push --force origin main", "shared-clone")).toEqual([]);
    expect(idsFor("git add -A", "shared-clone")).toEqual(["house.gitAddAll"]);
    expect(idsFor("git add -A", "core")).toEqual([]);
    // `stash drop` is core; the bare-stash rule is the shared-clone workflow one.
    expect(idsFor("git stash drop", "core")).toEqual(["house.stashDrop"]);
    expect(idsFor("git stash drop", "shared-clone")).toEqual(["house.stashBare"]);
    expect(idsFor("git stash drop", "house")).toEqual(["house.stashDrop", "house.stashBare"]);
    expect(idsFor("git add -A", "house")).toEqual(["house.gitAddAll"]);
    expect(idsFor("git add -A", "none")).toEqual([]);
  });

  it("keeps evaluateCommandRules(command, cfg) as the only entry point", () => {
    expect(typeof evaluateCommandRules).toBe("function");
    expect(idsFor("pnpm typecheck", "shared-clone")).toEqual(["house.typecheckUnqueued"]);
    expect(idsFor("pnpm typecheck", "core")).toEqual([]);
  });
});
