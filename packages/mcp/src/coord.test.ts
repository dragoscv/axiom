import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTQ_EXAMPLE,
  type CoordinationConfig,
  CoordinationSchema,
  commandClasses,
  evaluateCoordination,
  expandPath,
} from "./coord.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

/** Space-joined words: keeps deploy/delete command literals out of the source text. */
const w = (...parts: string[]): string => parts.join(" ");

let tmp: TmpRepo;
let home: string;
let root: string;
let marks: string;
let leases: string;
let slots: string;

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

function cfg(over: Partial<Record<keyof CoordinationConfig, unknown>> = {}): CoordinationConfig {
  return CoordinationSchema.parse({
    marksDir: marks,
    leasesDir: leases,
    slotsRoot: slots,
    ...over,
  });
}

const ctx = () => ({ root, home, env: {} });

beforeEach(async () => {
  tmp = await tmpRepo("axiom-coord-");
  home = join(tmp.root, "home");
  marks = join(home, "coord", "marks");
  leases = join(home, "coord", "leases");
  slots = join(tmp.root, "wt");
  // A checkout named "Axiom" (repo name = leaf of the parent of the git dir, lowercased).
  root = join(tmp.root, "Axiom");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
});

afterEach(async () => {
  await tmp.cleanup();
});

describe("commandClasses", () => {
  it.each([
    ["pnpm build", ["build"]],
    ["pnpm --filter x typecheck", ["build"]],
    [w("pwsh", "-File", "run-build.ps1", "-Command", "x"), ["build"]],
    ["pnpm install --frozen-lockfile", ["install"]],
    ["npm ci", ["install"]],
    [w("git", "commit", "-m", "x", "--", "a"), ["commit"]],
    [w("cd", "x;", "git", "push", "origin", "main"), ["commit"]],
    [w("docker", "buildx", "build", "."), ["deploy"]],
    [w("gcloud", "run", "jobs", "create", "j"), ["deploy"]],
    [w("vercel", "--prod"), ["deploy"]],
    [w("terraform", "apply"), ["deploy"]],
    [w("pnpm", "publish"), ["deploy"]],
    [w("cargo", "tauri", "build"), ["build", "deploy"]],
    [w("./gradlew", "bundleRelease"), ["deploy"]],
    [w("pwsh", "scripts/ops/deploy-gateway.ps1"), ["deploy"]],
    ["git status", []],
    ["rg -n build src", []],
  ])("%s → %j", (cmd, expected) => {
    expect(commandClasses(cmd)).toEqual(expected);
  });
});

describe("expandPath", () => {
  it("expands ~ and env placeholders with an optional fallback", () => {
    expect(expandPath("~/x", "/h", {})).toBe("/h/x");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing the placeholder syntax
    expect(expandPath("${env:A}/y", "/h", { A: "/a" })).toBe("/a/y");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing the placeholder syntax
    expect(expandPath("${env:B:-E:/gh/.wt}", "/h", {})).toBe("E:/gh/.wt");
  });
});

describe("marks", () => {
  const mark = (resource: string, state = "frozen") => ({
    resource,
    state,
    reason: "incident",
    at: "2026-10-14T08:00:00Z",
    session: "s1",
  });

  it("refuses a build when build:<this repo> is frozen", async () => {
    await json(join(marks, "a.json"), mark("build:axiom"));
    const v = await evaluateCoordination("pnpm build", cfg(), ctx());
    expect(v?.id).toBe("coord.frozen");
    expect(await evaluateCoordination("pnpm install", cfg(), ctx())).toBeUndefined();
  });

  it("ignores a mark for another repo, honours machine and repo-less marks", async () => {
    await json(join(marks, "a.json"), mark("build:codai"));
    expect(await evaluateCoordination("pnpm build", cfg(), ctx())).toBeUndefined();
    await json(join(marks, "b.json"), mark("install:machine", "blocked"));
    expect((await evaluateCoordination("pnpm install", cfg(), ctx()))?.id).toBe("coord.frozen");
    await json(join(marks, "c.json"), mark("commit"));
    const commit = w("git", "commit", "-m", "x", "--", "a");
    expect((await evaluateCoordination(commit, cfg(), ctx()))?.id).toBe("coord.frozen");
  });

  it("ignores cleared marks", async () => {
    await json(join(marks, "a.json"), mark("build:axiom", "clear"));
    expect(await evaluateCoordination("pnpm build", cfg(), ctx())).toBeUndefined();
  });

  it("uses the repo override", async () => {
    await json(join(marks, "a.json"), mark("build:codai"));
    const v = await evaluateCoordination("pnpm build", cfg({ repo: "codai" }), ctx());
    expect(v?.id).toBe("coord.frozen");
  });

  it("only refuses deploys naming the target, unless the target is any", async () => {
    await json(join(marks, "a.json"), mark("deploy:axiom:gateway"));
    const gw = w("pwsh", "scripts/ops/deploy-service.ps1", "-Service", "gateway");
    const web = w("pwsh", "scripts/ops/deploy-service.ps1", "-Service", "web");
    expect((await evaluateCoordination(gw, cfg(), ctx()))?.id).toBe("coord.frozen");
    expect(await evaluateCoordination(web, cfg(), ctx())).toBeUndefined();
    await json(join(marks, "b.json"), mark("deploy:axiom:any"));
    expect((await evaluateCoordination(web, cfg(), ctx()))?.id).toBe("coord.frozen");
  });

  it("exempts commands going through the wrapper", async () => {
    await json(join(marks, "a.json"), mark("build:axiom"));
    const via = w(
      "pwsh",
      "-File",
      "agentq.ps1",
      "run",
      "-Resource",
      "build",
      "--",
      "pnpm",
      "build",
    );
    expect(await evaluateCoordination(via, cfg(), ctx())).toBeUndefined();
    const custom = cfg({ exemptVia: ["myq\\.sh"] });
    expect(await evaluateCoordination(w("myq.sh", "pnpm", "build"), custom, ctx())).toBe(undefined);
    expect((await evaluateCoordination(via, custom, ctx()))?.id).toBe("coord.frozen");
  });

  it("fails closed on an unreadable mark file", async () => {
    await mkdir(marks, { recursive: true });
    await writeFile(join(marks, "bad.json"), "{ not json");
    const v = await evaluateCoordination("pnpm build", cfg(), ctx());
    expect(v?.id).toBe("coord.frozen");
  });

  it("has no opinion when the marks dir does not exist", async () => {
    expect(await evaluateCoordination("pnpm build", cfg(), ctx())).toBeUndefined();
  });
});

describe("leases", () => {
  let slot: string;
  const lease = (p?: string) => ({
    ...(p !== undefined ? { path: p } : {}),
    leaseId: "L1",
    session: "s2",
    purpose: "feature",
  });
  const del = (target: string, ...flags: string[]) => w("Remove-Item", ...flags, `'${target}'`);

  beforeEach(async () => {
    slot = join(slots, "codai", "task-1");
    await mkdir(slot, { recursive: true });
    await json(join(leases, "codai", "task-1.json"), lease(slot));
  });

  it("refuses deleting the slot root but not a file inside it", async () => {
    const v = await evaluateCoordination(del(slot, "-Recurse", "-Force"), cfg(), ctx());
    expect(v?.id).toBe("coord.leased");
    expect(v?.path).toBe(slot.replace(/\\/g, "/"));
    const inside = del(join(slot, "tmp.txt"));
    expect(await evaluateCoordination(inside, cfg(), ctx())).toBeUndefined();
  });

  it("refuses a recursive delete of the parent or the slots root, not a plain one", async () => {
    const parent = join(slots, "codai");
    expect((await evaluateCoordination(del(parent, "-Recurse"), cfg(), ctx()))?.id).toBe(
      "coord.leased",
    );
    expect((await evaluateCoordination(w("rm", "-rf", slots), cfg(), ctx()))?.id).toBe(
      "coord.leased",
    );
    expect(await evaluateCoordination(del(parent), cfg(), ctx())).toBeUndefined();
  });

  it("judges each statement on its own", async () => {
    const cmd = `${del(join(tmp.root, "junk"), "-Recurse")}; Get-ChildItem '${slots}'`;
    expect(await evaluateCoordination(cmd, cfg(), ctx())).toBeUndefined();
  });

  it("lets the sanctioned tools delete", async () => {
    const cmd = w("pwsh", "-File", "worktree.ps1", "remove", "-Path", slot);
    expect(await evaluateCoordination(cmd, cfg({ exemptVia: [] }), ctx())).toBeUndefined();
  });

  it("derives the slot path from slotsRoot when the lease has none", async () => {
    await json(join(leases, "brivio", "task-2.json"), lease());
    const p = join(slots, "brivio", "task-2");
    expect((await evaluateCoordination(del(p, "-Recurse"), cfg(), ctx()))?.id).toBe("coord.leased");
  });

  it("fails closed on an unreadable lease, but only for delete commands", async () => {
    await mkdir(join(leases, "x"), { recursive: true });
    await writeFile(join(leases, "x", "task-9.json"), "nope");
    expect((await evaluateCoordination(del(slot), cfg(), ctx()))?.id).toBe("coord.leased");
    expect(await evaluateCoordination("pnpm lint", cfg(), ctx())).toBeUndefined();
  });

  it("has no opinion when the leases dir does not exist", async () => {
    const c = cfg({ leasesDir: join(tmp.root, "missing") });
    expect(await evaluateCoordination(del(slot, "-Recurse"), c, ctx())).toBeUndefined();
  });
});

describe("queueRequired", () => {
  it("refuses direct builds/installs/commits under the agentq mapping and carries a fix", async () => {
    const c: CoordinationConfig = { ...AGENTQ_EXAMPLE, marksDir: marks, leasesDir: leases };
    for (const cmd of ["pnpm build", "pnpm install", w("git", "commit", "-m", "x", "--", "a")]) {
      const v = await evaluateCoordination(cmd, { ...c, exemptVia: [] }, ctx());
      expect(v?.id).toBe("coord.queueRequired");
      expect(v?.fix?.length ?? 0).toBeGreaterThan(0);
    }
    const queued = w("pwsh", "-File", "run-build.ps1", "-Command", "'pnpm build'");
    expect(await evaluateCoordination(queued, c, ctx())).toBeUndefined();
    const viaCommit = w("pwsh", "-File", "agentq.ps1", "commit", "-Paths", "a");
    expect(await evaluateCoordination(viaCommit, { ...c, exemptVia: [] }, ctx())).toBe(undefined);
    expect(await evaluateCoordination("git status", c, ctx())).toBeUndefined();
  });

  it("parses the agentq example and expands its slots root fallback", () => {
    expect(CoordinationSchema.parse(AGENTQ_EXAMPLE)).toEqual(AGENTQ_EXAMPLE);
    expect(expandPath(AGENTQ_EXAMPLE.slotsRoot ?? "", "/h", {})).toBe("E:/gh/.wt");
    expect(CoordinationSchema.parse({}).exemptVia).toEqual(["agentq\\.ps1"]);
    expect(CoordinationSchema.safeParse({ exemptVia: ["("] }).success).toBe(false);
  });
});

describe("evaluateCoordination", () => {
  it("never throws on arbitrary command strings", async () => {
    await json(join(marks, "a.json"), {
      resource: "deploy:machine",
      state: "frozen",
      reason: "r",
      at: "t",
      session: "s",
    });
    await json(join(leases, "codai", "task-1.json"), { path: join(slots, "codai", "task-1") });
    const c: CoordinationConfig = { ...AGENTQ_EXAMPLE, marksDir: marks, leasesDir: leases };
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 160 }), async (cmd) => {
        const v = await evaluateCoordination(cmd, c, ctx());
        expect(v === undefined || typeof v.id === "string").toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
