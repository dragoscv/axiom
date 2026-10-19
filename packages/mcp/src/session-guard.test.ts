import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkSessionBudget,
  checkSessionWrite,
  checkStaleScript,
  recordDeniedCreate,
  recordSessionRead,
  recordSessionWrite,
  type SessionCtx,
  type SessionsConfig,
  SessionsConfigSchema,
} from "./session-guard.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-sessions-");
});
afterEach(async () => {
  await repo.cleanup();
});

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function cfg(over: Partial<SessionsConfig> = {}): SessionsConfig {
  return SessionsConfigSchema.parse(over);
}

function ctx(
  session: string,
  rel: string,
  now: number,
  over: Partial<SessionCtx> & { whole?: boolean } = {},
): SessionCtx {
  return {
    root: repo.root,
    sessionId: session,
    agentId: `claude:${session}`,
    tool: over.whole === true ? "Write" : "Edit",
    targets: [{ relPath: rel, op: "write", whole: over.whole ?? false }],
    now,
    ...over,
  };
}

async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(repo.root, ...rel.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** Session A writes `rel` at T0 (gate allow, then the tool changes the bytes). */
async function aWrites(rel: string, content: string, at = T0): Promise<void> {
  await recordSessionWrite(ctx("A", rel, at));
  await put(rel, content);
}

describe("SessionsConfigSchema", () => {
  it("defaults and strictness", () => {
    expect(SessionsConfigSchema.parse({})).toEqual({
      foreignWrite: "off",
      windowMin: 15,
      blindOverwrite: "off",
      trackReads: false,
      staleScript: true,
    });
    expect(SessionsConfigSchema.safeParse({ windowMin: 0 }).success).toBe(false);
    expect(SessionsConfigSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("budget defaults: windowMin 60, decision ask; strict", () => {
    expect(SessionsConfigSchema.parse({ budget: { maxFiles: 3 } }).budget).toEqual({
      maxFiles: 3,
      windowMin: 60,
      decision: "ask",
    });
    expect(SessionsConfigSchema.safeParse({ budget: { maxFiles: 0 } }).success).toBe(false);
    expect(SessionsConfigSchema.safeParse({ budget: { extra: 1 } }).success).toBe(false);
    expect(SessionsConfigSchema.safeParse({ budget: { decision: "warn" } }).success).toBe(false);
  });
});

describe("sessions.budget", () => {
  const target = (rel: string, op: "write" | "delete" = "write"): SessionCtx => ({
    root: repo.root,
    sessionId: "A",
    agentId: "claude:A",
    tool: "Edit",
    targets: [{ relPath: rel, op, whole: false }],
  });
  async function wrote(rel: string, at: number, op: "write" | "delete" = "write") {
    await recordSessionWrite({ ...target(rel, op), now: at });
  }

  it("maxFiles: the (N+1)th distinct file in the window asks with counts; repeats do not count", async () => {
    const c = cfg({ budget: { maxFiles: 2 } });
    await wrote("a.txt", T0);
    await wrote("b.txt", T0 + MIN);
    expect(await checkSessionWrite({ ...target("a.txt"), now: T0 + 2 * MIN }, c)).toBeUndefined();
    const v = await checkSessionWrite({ ...target("c.txt"), now: T0 + 2 * MIN }, c);
    expect(v?.id).toBe("sessions.budget");
    expect(v?.decision).toBe("ask");
    expect(v?.reason).toContain("3 distinct files");
    expect(v?.reason).toContain("max 2");
    // outside the 60 min window the old writes no longer count
    expect(await checkSessionWrite({ ...target("c.txt"), now: T0 + 61 * MIN }, c)).toBeUndefined();
  });

  it("maxDeletes with decision deny; another session has its own budget", async () => {
    const c = cfg({ budget: { maxDeletes: 1, decision: "deny", windowMin: 10 } });
    await wrote("a.txt", T0, "delete");
    const v = await checkSessionWrite({ ...target("b.txt", "delete"), now: T0 + MIN }, c);
    expect(v).toMatchObject({ id: "sessions.budget", decision: "deny" });
    expect(v?.reason).toContain("2 files deleted");
    const other = { ...target("b.txt", "delete"), sessionId: "B", agentId: "claude:B", now: T0 };
    expect(await checkSessionWrite(other, c)).toBeUndefined();
    expect(await checkSessionWrite({ ...target("b.txt"), now: T0 + MIN }, c)).toBeUndefined();
  });

  it("no sessionId / no limits → no opinion; a blind deny outranks a budget ask", async () => {
    const { sessionId: _s, ...anon } = target("x.txt");
    expect(
      await checkSessionWrite({ ...anon, now: T0 }, cfg({ budget: { maxFiles: 1 } })),
    ).toBeUndefined();
    const noLimits = { windowMin: 60, decision: "ask" as const };
    expect(
      checkSessionBudget({ wrote: {}, deleted: {} }, target("x").targets, noLimits, T0),
    ).toBeUndefined();
    await put("a.txt", "v0");
    await recordSessionWrite(ctx("B", "a.txt", T0));
    await put("a.txt", "v1");
    await wrote("z.txt", T0);
    const c = cfg({ blindOverwrite: "deny", budget: { maxFiles: 1 } });
    const whole: SessionCtx = {
      ...target("a.txt"),
      tool: "Write",
      targets: [{ relPath: "a.txt", op: "write", whole: true }],
      now: T0 + MIN,
    };
    expect((await checkSessionWrite(whole, c))?.id).toBe("blind.overwrite");
  });
});

describe("session.foreignWrite", () => {
  it("another session wrote within the window → deny", async () => {
    await put("src/a.ts", "v0");
    await aWrites("src/a.ts", "v1-by-A");
    const v = await checkSessionWrite(
      ctx("B", "src/a.ts", T0 + 5 * MIN),
      cfg({ foreignWrite: "deny" }),
    );
    expect(v?.id).toBe("session.foreignWrite");
    expect(v?.decision).toBe("deny");
    expect(v?.path).toBe("src/a.ts");
  });

  it("mode ask → decision ask", async () => {
    await aWrites("a.txt", "new file by A");
    const v = await checkSessionWrite(ctx("B", "a.txt", T0 + MIN), cfg({ foreignWrite: "ask" }));
    expect(v?.id).toBe("session.foreignWrite");
    expect(v?.decision).toBe("ask");
  });

  it("same session → no opinion", async () => {
    await aWrites("a.txt", "A1");
    const v = await checkSessionWrite(ctx("A", "a.txt", T0 + MIN), cfg({ foreignWrite: "deny" }));
    expect(v).toBeUndefined();
  });

  it("outside the window → no opinion", async () => {
    await aWrites("a.txt", "A1");
    const v = await checkSessionWrite(
      ctx("B", "a.txt", T0 + 16 * MIN),
      cfg({ foreignWrite: "deny", windowMin: 15 }),
    );
    expect(v).toBeUndefined();
  });

  it("calling session has seen the current hash → no opinion", async () => {
    await aWrites("a.txt", "A1");
    await recordSessionRead(repo.root, "B", "claude:B", ["a.txt"]);
    const v = await checkSessionWrite(ctx("B", "a.txt", T0 + MIN), cfg({ foreignWrite: "deny" }));
    expect(v).toBeUndefined();
  });

  it("attribution survives settlement by a later record, and unknown session is ignored", async () => {
    await aWrites("a.txt", "A1");
    // an unrelated write by C settles A's pending write into the map
    await recordSessionWrite(ctx("C", "other.txt", T0 + MIN));
    const v = await checkSessionWrite(
      ctx("B", "a.txt", T0 + 2 * MIN),
      cfg({ foreignWrite: "deny" }),
    );
    expect(v?.id).toBe("session.foreignWrite");
    const anon = { ...ctx("B", "a.txt", T0 + 2 * MIN) };
    delete anon.sessionId;
    expect(await checkSessionWrite(anon, cfg({ foreignWrite: "deny" }))).toBeUndefined();
  });

  it("pending write never landed (tool failed) → not attributed", async () => {
    await put("a.txt", "v0");
    await recordSessionWrite(ctx("A", "a.txt", T0)); // bytes unchanged afterwards
    const v = await checkSessionWrite(ctx("B", "a.txt", T0 + MIN), cfg({ foreignWrite: "deny" }));
    expect(v).toBeUndefined();
  });

  it("config off → no opinion", async () => {
    await aWrites("a.txt", "A1");
    expect(await checkSessionWrite(ctx("B", "a.txt", T0 + MIN), cfg())).toBeUndefined();
  });
});

describe("blind.overwrite", () => {
  it("without trackReads: whole write over a file last written by another session → blind", async () => {
    await aWrites("a.txt", "A1");
    const c = cfg({ blindOverwrite: "deny" });
    const v = await checkSessionWrite(ctx("B", "a.txt", T0 + 60 * MIN, { whole: true }), c);
    expect(v?.id).toBe("blind.overwrite");
    expect(v?.decision).toBe("deny");
    // a targeted edit is not blind
    expect(await checkSessionWrite(ctx("B", "a.txt", T0 + 60 * MIN), c)).toBeUndefined();
    // the writer itself is not blind
    expect(
      await checkSessionWrite(ctx("A", "a.txt", T0 + 60 * MIN, { whole: true }), c),
    ).toBeUndefined();
    // a file nobody tracked is not blind without read tracking
    await put("untracked.txt", "x");
    expect(
      await checkSessionWrite(ctx("B", "untracked.txt", T0, { whole: true }), c),
    ).toBeUndefined();
  });

  it("with trackReads: never read → blind (ask); after a read → allowed; new file → allowed", async () => {
    await put("a.txt", "v0");
    const c = cfg({ blindOverwrite: "ask", trackReads: true });
    const v = await checkSessionWrite(ctx("B", "a.txt", T0, { whole: true }), c);
    expect(v?.id).toBe("blind.overwrite");
    expect(v?.decision).toBe("ask");
    await recordSessionRead(repo.root, "B", "claude:B", ["a.txt"]);
    expect(await checkSessionWrite(ctx("B", "a.txt", T0, { whole: true }), c)).toBeUndefined();
    expect(await checkSessionWrite(ctx("B", "new.txt", T0, { whole: true }), c)).toBeUndefined();
  });

  it("a file this session wrote is not blind", async () => {
    await put("a.txt", "v0");
    const c = cfg({ blindOverwrite: "deny", trackReads: true });
    await recordSessionWrite(ctx("B", "a.txt", T0));
    await put("a.txt", "v1");
    expect(
      await checkSessionWrite(ctx("B", "a.txt", T0 + MIN, { whole: true }), c),
    ).toBeUndefined();
  });
});

describe("blind.staleScript", () => {
  it("re-running a script whose create was just denied → verdict; after 10 min → none", async () => {
    const abs = path.join(repo.root, ".copilot-tmp", "fix.ps1");
    const before = Date.now();
    await recordDeniedCreate(repo.root, abs);
    const v = await checkStaleScript(repo.root, `pwsh -NoProfile -File "${abs}"`, before + 60_000);
    expect(v?.id).toBe("blind.staleScript");
    expect(v?.path).toBe(".copilot-tmp/fix.ps1");
    expect(typeof v?.fix).toBe("string");
    expect(
      await checkStaleScript(repo.root, `pwsh -File "${abs}"`, before + 11 * 60_000),
    ).toBeUndefined();
  });

  it("matches the script leaf and a relative path; ignores unrelated commands", async () => {
    await recordDeniedCreate(repo.root, path.join(repo.root, "scripts", "gen.mjs"));
    const now = Date.now() + 1000;
    expect((await checkStaleScript(repo.root, "node gen.mjs --all", now))?.id).toBe(
      "blind.staleScript",
    );
    expect((await checkStaleScript(repo.root, "node ./scripts/gen.mjs", now))?.id).toBe(
      "blind.staleScript",
    );
    expect(await checkStaleScript(repo.root, "node regen.mjs", now)).toBeUndefined();
    expect(await checkStaleScript(repo.root, "pnpm test", now)).toBeUndefined();
  });

  it("no denied markers → no opinion", async () => {
    expect(await checkStaleScript(repo.root, "node x.mjs")).toBeUndefined();
  });
});
