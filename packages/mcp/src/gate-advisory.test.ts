/**
 * 4.0 contract 4: an `advisory: true` verdict NEVER blocks — the gate allows the call and attaches
 * the reason as a warning, and with `oncePerSession` it is shown once per (root, session, rule).
 *
 * This is the gate-side half of OPS-9 / D-53 (`house.typecheckUnqueued`): 83 % of the 865
 * `house.buildUnqueued` records were a `tsc --noEmit`, so a typecheck advises while a real build
 * still blocks. It owns its own file because `gate*.test.ts` belongs to the integrator.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import { runGate } from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;

beforeEach(async () => {
  repo = await tmpRepo("axiom-advise-");
  home = await tmpRepo("axiom-advise-home-");
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

const shell = (command: string, session = "s1"): string =>
  JSON.stringify({
    session_id: session,
    hook_event_name: "PreToolUse",
    cwd: repo.root,
    tool_name: "run_in_terminal",
    tool_input: { command },
  });

const run = (text: string) => runGate(text, { home: home.root, format: "auto" });

function context(stdout: string | undefined): string {
  if (stdout === undefined) return "";
  const doc = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return doc.hookSpecificOutput?.additionalContext ?? "";
}

describe("4.0 advisory verdicts never block", () => {
  it("allows a typecheck and attaches the advice (D-53 / OPS-9)", async () => {
    await profile({ mode: "enforce", record: true, commands: { pack: "house" } });
    const r = await run(shell("pnpm exec tsc --noEmit -p ."));
    expect(r.decision).toBe("allow");
    expect(r.code).toBeUndefined();
    expect(context(r.stdout)).toContain("AXIOM GATE ADVISE house.typecheckUnqueued");
  });

  it("still blocks a real build under the same pack (control)", async () => {
    await profile({ mode: "enforce", record: true, commands: { pack: "house" } });
    const r = await run(shell("pnpm build"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("house.buildUnqueued");
    const recs = await readDecisions(repo.root);
    expect(recs[0]?.code).toBe("house.buildUnqueued");
  });

  it("shows a oncePerSession advice once per (root, session, rule), not once per call", async () => {
    await profile({ mode: "enforce", commands: { pack: "house" } });
    const first = await run(shell("tsc --noEmit"));
    const again = await run(shell("npx tsc --noEmit"));
    const other = await run(shell("pnpm typecheck", "s2"));
    expect(context(first.stdout)).toContain("AXIOM GATE ADVISE house.typecheckUnqueued");
    expect(context(again.stdout)).not.toContain("AXIOM GATE ADVISE");
    expect(other.decision).toBe("allow");
    expect(context(other.stdout)).toContain("AXIOM GATE ADVISE house.typecheckUnqueued");
  });

  it("blocks a user rule that carries no advisory flag (control)", async () => {
    await profile({
      mode: "enforce",
      commands: { deny: [{ id: "custom.slow", pattern: String.raw`\bthing\b`, reason: "slow" }] },
    });
    const blocked = await run(shell("run thing"));
    expect(blocked.decision).toBe("deny");
    expect(blocked.code).toBe("custom.slow");
  });

  it("honours advisory on a USER rule, through the real profile resolver", async () => {
    // `policy.ts` re-validates `commands` against a hand-written key table (`RULE_KEYS`); when the
    // two 4.0 keys were missing from it, `resolvePolicy` silently stripped them (probe 2026-11-16:
    // `GateProfileSchema.parse` kept `advisory`, `resolvePolicy` dropped it).
    await profile({
      mode: "enforce",
      commands: {
        deny: [
          {
            id: "custom.slow",
            pattern: String.raw`\bthing\b`,
            reason: "slow, but never fatal",
            advisory: true,
            oncePerSession: true,
          },
        ],
      },
    });
    const advised = await run(shell("run thing"));
    expect(advised.decision).toBe("allow");
    expect(context(advised.stdout)).toContain("AXIOM GATE ADVISE custom.slow");
    const again = await run(shell("run thing"));
    expect(context(again.stdout)).not.toContain("AXIOM GATE ADVISE");
  });

  it("lets a HARD target code win over an earlier relaxable command verdict", async () => {
    await profile({
      mode: "enforce",
      hard: ["path.deny"],
      deny: ["secrets/**"],
      commands: { deny: [{ id: "custom.touch", pattern: "Set-Content", reason: "r" }] },
    });
    const r = await run(shell("Set-Content secrets/notes.txt hi"));
    expect(r.decision).toBe("deny");
    // 3.0 returned `custom.touch` here (the command verdict came first, before the target checks).
    expect(r.code).toBe("path.deny");
  });

  it("keeps the command verdict when nothing hard comes out of the targets (3.0 order)", async () => {
    await profile({
      mode: "enforce",
      commands: { deny: [{ id: "custom.touch", pattern: "Set-Content", reason: "r" }] },
    });
    const r = await run(shell("Set-Content src/a.txt hi"));
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("custom.touch");
  });
});
