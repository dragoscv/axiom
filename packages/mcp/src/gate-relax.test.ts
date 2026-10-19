/**
 * Gate 2.7 relaxation: `mode: "warn"`, `hard` codes, agent `axiom-override: <reason>` and
 * `outside` (targets beyond the root). Each knob is asserted both ways (on → allow + warning,
 * off → the 2.6 deny) so a mutant that ignores the knob fails here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import {
  findOverrideReason,
  GateProfileSchema,
  isHardCode,
  isSystemPath,
  runGate,
} from "./gate.js";
import { summarizeDecisions } from "./stats.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
let other: Awaited<ReturnType<typeof tmpRepo>>;

beforeEach(async () => {
  repo = await tmpRepo("axiom-relax-");
  home = await tmpRepo("axiom-relax-home-");
  other = await tmpRepo("axiom-relax-other-");
  await mkdir(join(repo.root, ".git"));
});
afterEach(async () => {
  await repo.cleanup();
  await home.cleanup();
  await other.cleanup();
});

async function profile(p: Record<string, unknown>): Promise<void> {
  await mkdir(join(repo.root, ".axiom"), { recursive: true });
  await writeFile(join(repo.root, ".axiom", "gate-profile.json"), JSON.stringify(p));
}

function shell(command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    cwd: repo.root,
    tool_name: "run_in_terminal",
    tool_input: { command, ...extra },
  });
}

function write(file: string, content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    cwd: repo.root,
    tool_name: "create_file",
    tool_input: { filePath: file, content, ...extra },
  });
}

const run = (text: string) => runGate(text, { home: home.root, format: "auto" });

function context(stdout: string | undefined): string {
  if (stdout === undefined) return "";
  const doc = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return doc.hookSpecificOutput?.additionalContext ?? "";
}

describe("gate 2.7: profile schema", () => {
  it("defaults keep 2.6 behaviour", () => {
    const p = GateProfileSchema.parse({});
    expect(p.mode).toBe("enforce");
    expect(p.hard).toStrictEqual([]);
    expect(p.override).toBe(false);
    expect(p.outside).toBe("deny");
  });

  it("rejects unknown values", () => {
    expect(GateProfileSchema.safeParse({ mode: "off" }).success).toBe(false);
    expect(GateProfileSchema.safeParse({ outside: "maybe" }).success).toBe(false);
    expect(GateProfileSchema.safeParse({ hard: [""] }).success).toBe(false);
  });
});

describe("gate 2.7: helpers", () => {
  it("isHardCode matches exact, prefix.* and *", () => {
    expect(isHardCode(["house.forcePush"], "house.forcePush")).toBe(true);
    expect(isHardCode(["house.forcePush"], "house.resetHard")).toBe(false);
    expect(isHardCode(["content.noSecrets.*"], "content.noSecrets.privateKey")).toBe(true);
    expect(isHardCode(["content.noSecrets.*"], "content.maxBytes")).toBe(false);
    expect(isHardCode(["*"], "anything")).toBe(true);
    expect(isHardCode([], "anything")).toBe(false);
  });

  it("findOverrideReason reads prose fields or a trailing shell comment, needs 3 words, ignores file content", () => {
    expect(findOverrideReason({ explanation: "x axiom-override: the user asked for it" })).toBe(
      "the user asked for it",
    );
    expect(findOverrideReason({}, "rm a # axiom-override: removing a temporary scratch file")).toBe(
      "removing a temporary scratch file",
    );
    expect(findOverrideReason({ command: "rm a # axiom-override: removing a scratch file" })).toBe(
      undefined,
    );
    expect(findOverrideReason({ explanation: "axiom-override: short" })).toBeUndefined();
    expect(findOverrideReason({ content: "axiom-override: hidden in the file body" })).toBe(
      undefined,
    );
  });

  it("isSystemPath knows OS directories on both platforms", () => {
    expect(isSystemPath("C:\\Windows\\System32\\x.dll", true)).toBe(true);
    expect(isSystemPath("c:/program files/app/x", true)).toBe(true);
    expect(isSystemPath("C:\\Users\\me\\Documents\\x", true)).toBe(false);
    expect(isSystemPath("/etc/hosts", false)).toBe(true);
    expect(isSystemPath("/etcetera/x", false)).toBe(false);
    expect(isSystemPath("/home/me/x", false)).toBe(false);
  });
});

describe("gate 2.7: mode warn", () => {
  it("a command rule deny becomes allow + warning; journal says relaxed warn", async () => {
    await profile({ mode: "warn", record: true, commands: { pack: "house" } });
    const r = await run(shell("git add -A"));
    expect(r.decision).toBe("allow");
    expect(context(r.stdout)).toContain("AXIOM GATE WARN house.gitAddAll");
    const recs = await readDecisions(repo.root);
    expect(recs[0]?.decision).toBe("allow");
    expect(recs[0]?.relaxed).toBe("warn");
    expect(recs[0]?.code).toBe("house.gitAddAll");
    expect(recs[0]?.rule).toBe("house.gitAddAll");
    expect(recs[0]?.command).toBe("git add -A");
    expect(summarizeDecisions(recs).relaxed).toBe(1);
  });

  it("enforce mode (default) still denies the same command", async () => {
    await profile({ commands: { pack: "house" } });
    const r = await run(shell("git add -A"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("house.gitAddAll");
  });

  it("path.deny and content.noSecrets warn instead of deny", async () => {
    await profile({ mode: "warn", deny: [".env.example"], noSecrets: true, pii: true });
    const a = await run(write(".env.example", "A=1\n"));
    expect(a.decision).toBe("allow");
    expect(context(a.stdout)).toContain("path.deny");
    const b = await run(write("notes.md", "contact: ion.popescu@example.ro\n"));
    expect(b.decision).toBe("allow");
    expect(context(b.stdout)).toContain("content.noSecrets.email");
  });

  it("hard codes keep denying in warn mode, even after a relaxable finding", async () => {
    await profile({
      mode: "warn",
      deny: ["keys/**"],
      hard: ["house.forcePush", "content.noSecrets.privateKey"],
      commands: { pack: "house" },
    });
    const push = await run(shell("git push --force origin main"));
    expect(push.decision).toBe("deny");
    expect(push.code).toBe("house.forcePush");
    const key = ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIB\n-----END ", "RSA PRIVATE KEY-----"];
    const k = await run(write("keys/id.pem", key.join("")));
    expect(k.decision).toBe("deny");
    expect(k.code).toBe("content.noSecrets.privateKey");
  });

  it("ask globs still ask in warn mode", async () => {
    await profile({ mode: "warn", ask: [".github/**"] });
    const r = await run(write(".github/workflows/x.yml", "on: push\n"));
    expect(r.verdict).toBe("ask");
  });

  it("a whole-file create allowed by warn leaves no stale-script marker", async () => {
    await profile({ mode: "warn", deny: ["scripts/**"], sessions: {} });
    expect((await run(write("scripts/x.ps1", "Write-Host hi"))).decision).toBe("allow");
    expect((await run(shell("pwsh -File scripts/x.ps1"))).decision).toBe("allow");
  });
});

describe("gate 2.7: override", () => {
  it("override: true + reason in explanation lets a deny through and journals the reason", async () => {
    await profile({ override: true, record: true, commands: { pack: "house" } });
    const r = await run(
      shell("git add -A", { explanation: "axiom-override: scratch repo in TEMP, no other agents" }),
    );
    expect(r.decision).toBe("allow");
    expect(context(r.stdout)).toContain("AXIOM GATE OVERRIDE house.gitAddAll");
    const recs = await readDecisions(repo.root);
    expect(recs[0]?.relaxed).toBe("override");
    expect(recs[0]?.override_reason).toBe("scratch repo in TEMP, no other agents");
  });

  it("without the reason the deny stands; without override: true the reason is ignored", async () => {
    await profile({ override: true, commands: { pack: "house" } });
    expect((await run(shell("git add -A"))).decision).toBe("deny");
    await profile({ commands: { pack: "house" } });
    const r = await run(shell("git add -A", { explanation: "axiom-override: I really want it" }));
    expect(r.decision).toBe("deny");
  });

  it("a hard code cannot be overridden", async () => {
    await profile({ override: true, hard: ["house.forcePush"], commands: { pack: "house" } });
    const r = await run(
      shell("git push --force origin x", { explanation: "axiom-override: my own branch only" }),
    );
    expect(r.decision).toBe("deny");
  });
});

describe("gate 2.7: outside", () => {
  it("outside: deny (default) refuses a write beyond the root", async () => {
    await profile({});
    const r = await run(write(join(other.root, "x.txt"), "hi"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("ERR_CONTAINMENT");
  });

  it("outside: allow lets the write through silently", async () => {
    await profile({ outside: "allow" });
    const r = await run(write(join(other.root, "x.txt"), "hi"));
    expect(r.decision).toBe("allow");
    expect(context(r.stdout)).not.toContain("ERR_CONTAINMENT");
  });

  it("outside: warn allows with a warning; shell operands outside are allowed too", async () => {
    await profile({ outside: "warn" });
    const r = await run(write(join(other.root, "x.txt"), "hi"));
    expect(r.decision).toBe("allow");
    expect(context(r.stdout)).toContain("ERR_CONTAINMENT");
    const s = await run(shell(`rm ${join(other.root, "x.txt")}`));
    expect(s.decision).toBe("allow");
  });

  it("outside targets skip root-relative predicates (no false path.deny)", async () => {
    await profile({ outside: "allow", deny: ["**/*.txt"] });
    expect((await run(write(join(other.root, "x.txt"), "hi"))).decision).toBe("allow");
    expect((await run(write("in.txt", "hi"))).decision).toBe("deny");
  });
});
