import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectFleet,
  type FleetOptions,
  fleetMain,
  gateCommandsOf,
  linkedWorktrees,
  renderFleet,
} from "./fleet.js";
import { tmpRepo } from "./test-helpers.js";

let base: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
let parent: string;
let main: string;
let slot: string;
beforeEach(async () => {
  base = await tmpRepo("axiom-fleet-");
  home = await tmpRepo("axiom-fleet-home-");
  parent = await realpath(base.root);
  main = join(parent, "repo");
  slot = join(parent, ".wt", "task-1");
});
afterEach(async () => {
  await Promise.all([base.cleanup(), home.cleanup()]);
});

const put = async (abs: string, v: unknown) => {
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, typeof v === "string" ? v : JSON.stringify(v));
};

const hookDoc = (command: string) => ({
  version: 1,
  hooks: { preToolUse: [{ type: "command", command, timeoutSec: 15 }] },
});

/** A main clone with one linked worktree, wired the way `git worktree add` lays it out. */
async function makeRepo(): Promise<void> {
  await mkdir(join(main, ".git", "worktrees", "task-1"), { recursive: true });
  await mkdir(slot, { recursive: true });
  await writeFile(join(slot, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task-1")}\n`);
  await writeFile(join(main, ".git", "worktrees", "task-1", "gitdir"), `${join(slot, ".git")}\n`);
  await writeFile(join(main, ".git", "worktrees", "task-1", "commondir"), "../..\n");
  await put(
    join(main, ".github", "hooks", "axiom-gate.json"),
    hookDoc("axiom gate --stdin --format auto"),
  );
  await put(
    join(slot, ".github", "hooks", "axiom-gate.json"),
    hookDoc("axiom gate --stdin --format auto"),
  );
}

const opts = (over: Partial<FleetOptions> = {}): FleetOptions => ({
  scan: [parent],
  home: home.root,
  hookLogs: [],
  locateBin: async () => ({ path: "/usr/bin/axiom", version: "3.0.0" }),
  ...over,
});

describe("axiom setup doctor --fleet (I-1)", () => {
  it("finds the main clone and its linked worktree; slot without a profile inherits", async () => {
    await makeRepo();
    await put(join(main, ".axiom", "gate-profile.json"), { version: 3, deny: [".env"] });
    expect(await linkedWorktrees(main)).toEqual([await realpath(slot)]);
    const r = await collectFleet(opts());
    expect(r.slots.map((s) => [s.kind, s.profile.source, s.status])).toEqual([
      ["main", "own", "ok"],
      ["worktree", "inherited", "ok"],
    ]);
    expect(r.ok).toBe(true);
  });

  it("an older, different slot profile is drift (warn) and the slot inherits", async () => {
    await makeRepo();
    await put(join(main, ".axiom", "gate-profile.json"), { deny: [".env", "secrets/**"] });
    await put(join(slot, ".axiom", "gate-profile.json"), { deny: [".env"] });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(slot, ".axiom", "gate-profile.json"), old, old);
    const s = (await collectFleet(opts())).slots.find((x) => x.kind === "worktree");
    expect(s?.profile.source).toBe("inherited");
    expect(s?.issues.find((i) => i.id === "profile.drift")?.status).toBe("warn");
    expect(s?.status).toBe("warn");
  });

  it("hook commands with --fail-open or without --format warn", async () => {
    await makeRepo();
    await put(
      join(slot, ".github", "hooks", "axiom-gate.json"),
      hookDoc("axiom gate --stdin --fail-open"),
    );
    const s = (await collectFleet(opts())).slots.find((x) => x.kind === "worktree");
    expect(s?.hooks[0]).toMatchObject({ failOpen: true, format: false });
    expect(s?.issues.map((i) => i.id)).toEqual(
      expect.arrayContaining(["hooks.failOpen", "hooks.format"]),
    );
  });

  it("a gate command VS Code ran in the last 24 h that no hook file declares → reload the window", async () => {
    await makeRepo();
    const stamp = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
    };
    const now = Date.now();
    const line = (at: number, id: number, command: string) =>
      `${stamp(new Date(at))} [info] [#${id}] [PreToolUse] Running: ${JSON.stringify({ command, cwd: { fsPath: slot } })}`;
    const log = join(home.root, "Hooks.log");
    await writeFile(
      log,
      [
        line(now - 2 * 86_400_000, 1, "axiom gate --stdin --very-old"),
        line(now - 3_600_000, 2, "axiom gate --stdin --format copilot"),
        line(now - 60_000, 3, "axiom gate --stdin --format auto"),
      ].join("\n"),
    );
    const r = await collectFleet(opts({ hookLogs: [log], now }));
    const s = r.slots.find((x) => x.kind === "worktree");
    expect(s?.stale).toEqual(["axiom gate --stdin --format copilot"]);
    expect(s?.issues.find((i) => i.id === "hooks.stale")?.status).toBe("warn");
    expect(r.slots.find((x) => x.kind === "main")?.stale).toEqual([]);
  });

  it("a profile that needs a newer bin fails the slot", async () => {
    await makeRepo();
    await put(join(main, ".axiom", "gate-profile.json"), { version: 3, mode: "warn" });
    const r = await collectFleet(
      opts({ locateBin: async () => ({ path: "/a", version: "2.7.0" }) }),
    );
    expect(
      r.slots.every((s) => s.issues.some((i) => i.id === "bin.profile" && i.status === "fail")),
    ).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("daemon: protocol-1 / keyless warns; the daemon roots are the default scan list", async () => {
    await makeRepo();
    await put(join(home.root, ".axiom", "daemon.json"), {
      protocol: 1,
      pid: 1,
      host: "127.0.0.1",
      port: 1,
      version: "2.6.0",
      roots: [parent],
    });
    const r = await collectFleet(opts({ scan: [] }));
    expect(r.daemon.status).toBe("warn");
    expect(r.slots.length).toBe(2);
    await put(join(home.root, ".axiom", "daemon.json"), {
      protocol: 2,
      key: "ab".repeat(32),
      pid: 1,
      host: "127.0.0.1",
      port: 1,
      version: "3.0.0",
      roots: [],
    });
    const r2 = await collectFleet(opts({ scan: [] }));
    expect(r2.daemon.status).toBe("ok");
    expect(r2.slots).toEqual([]);
  });

  it("unwired repositories are skipped; output is ASCII; --json round-trips; bad flag → 2", async () => {
    await mkdir(join(parent, "plain", ".git"), { recursive: true });
    await makeRepo();
    const r = await collectFleet(opts());
    expect(r.slots.every((s) => !s.root.endsWith("plain"))).toBe(true);
    for (const l of renderFleet(r)) expect(l).toMatch(/^[\x20-\x7e]*$/);
    const out: string[] = [];
    const io = {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
      home: home.root,
    };
    expect(await fleetMain(["--fleet", "--scan", parent, "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("\n")).slots.length).toBe(2);
    expect(await fleetMain(["--nope"], io)).toBe(2);
  });

  it("gateCommandsOf collects pre/post gate commands and ignores others", () => {
    expect(
      gateCommandsOf({
        hooks: {
          preToolUse: [
            { command: "axiom gate --stdin", bash: "axiom gate --stdin", powershell: "guard.ps1" },
          ],
          postToolUse: [{ command: "axiom gate --stdin --post" }],
        },
      }),
    ).toEqual(["axiom gate --stdin", "axiom gate --stdin --post"]);
  });
});
