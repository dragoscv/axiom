import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { newJournal, writeJournal } from "@codai/axiom-apply";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASK_MIN_VERSION,
  compareVersions,
  type DoctorOptions,
  defaultHealthFetch,
  GATE_P95_FAIL_MS,
  GATE_PROBE_RUNS,
  runDoctor,
  stripJsonc,
} from "./doctor.js";
import {
  CLAUDE_HOOK_ENTRY,
  CLAUDE_POST_HOOK_ENTRY,
  codexHookEntry,
  cursorHooks,
  runInit,
} from "./init.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-doctor-");
  home = await tmpRepo("axiom-doctor-home-");
});
afterEach(async () => {
  await Promise.all([repo.cleanup(), home.cleanup()]);
});

const fastProbe: NonNullable<DoctorOptions["probe"]> = async () => ({ ms: 50, exit: 0 });
const bin: NonNullable<DoctorOptions["locateBin"]> = async () => ({
  path: "/usr/bin/axiom",
  version: "9.9.9",
});
const base = (over: Partial<DoctorOptions> = {}): DoctorOptions => ({
  root: repo.root,
  version: "9.9.9",
  probe: fastProbe,
  locateBin: bin,
  home: home.root,
  hookLogs: [],
  locateNode: async () => "/usr/bin/node",
  ...over,
});
const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) =>
  r.checks.find((c) => c.id === id);

describe("axiom doctor (S-702)", () => {
  it("a freshly init'ed root has no failing check", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const r = await runDoctor(base());
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
    for (const id of [
      "root",
      "bin",
      "hook.copilot",
      "mcp.vscode",
      "lock",
      "journal",
      "chain",
      "profile.demo",
      "gate.profile",
      "gitignore",
      "gate.latency",
    ]) {
      expect(byId(r, id)?.status, id).toBe("ok");
    }
  });

  it("an interrupted journal fails with a rollback hint", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const digest = `sha256:${"ab".repeat(32)}` as const;
    await writeJournal(repo.root, {
      ...newJournal(digest, [{ path: "a.txt", op: "create", done: false }]),
      phase: "committing",
    });
    const r = await runDoctor(base());
    expect(r.ok).toBe(false);
    const j = byId(r, "journal");
    expect(j?.status).toBe("fail");
    expect(j?.hint).toContain(`axiom rollback ${digest}`);
  });

  it("p95 latency above 80 % of the hook timeout fails; a denied probe warns", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    let n = 0;
    const slow = await runDoctor(
      base({ probe: async () => ({ ms: n++ === 0 ? 10 : GATE_P95_FAIL_MS + 1, exit: 0 }) }),
    );
    expect(byId(slow, "gate.latency")?.status).toBe("fail");
    expect(n).toBe(GATE_PROBE_RUNS);
    const denied = await runDoctor(base({ probe: async () => ({ ms: 5, exit: 2 }) }));
    expect(byId(denied, "gate.latency")?.status).toBe("warn");
    expect(denied.ok).toBe(true);
    const deniedJson = await runDoctor(
      base({ probe: async () => ({ ms: 5, exit: 0, denied: true }) }),
    );
    expect(byId(deniedJson, "gate.latency")?.status).toBe("warn");
    expect(byId(deniedJson, "gate.latency")?.message).toMatch(/deny JSON/);
    const broken = await runDoctor(
      base({
        probe: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(byId(broken, "gate.latency")?.status).toBe("fail");
  });

  it("missing bin / version skew / missing hooks / no .gitignore are warnings, not failures", async () => {
    const r = await runDoctor(base({ locateBin: async () => undefined }));
    expect(byId(r, "bin")?.status).toBe("warn");
    expect(byId(r, "hook")?.status).toBe("warn");
    expect(byId(r, "gitignore")?.status).toBe("warn");
    expect(byId(r, "profile")?.status).toBe("warn");
    expect(r.ok).toBe(true);
    const skew = await runDoctor(base({ version: "1.0.0" }));
    expect(byId(skew, "bin")?.status).toBe("warn");
  });

  it("unparseable hook / invalid profile / invalid gate profile fail", async () => {
    await mkdir(join(repo.root, ".github", "hooks"), { recursive: true });
    await writeFile(join(repo.root, ".github", "hooks", "axiom-gate.json"), "{nope");
    await mkdir(join(repo.root, ".axiom", "profiles"), { recursive: true });
    await writeFile(join(repo.root, ".axiom", "profiles", "bad.json"), '{"kind":"Profile"}');
    await writeFile(join(repo.root, ".axiom", "gate-profile.json"), '{"deny":"x"}');
    const r = await runDoctor(base());
    expect(byId(r, "hook.copilot")?.status).toBe("fail");
    expect(byId(r, "profile.bad")?.status).toBe("fail");
    expect(byId(r, "profile.bad")?.message).toContain("ERR_INVALID_PROFILE");
    expect(byId(r, "gate.profile")?.status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("an npx hook does not count as wired (it would time out and fail open)", async () => {
    await mkdir(join(repo.root, ".github", "hooks"), { recursive: true });
    await writeFile(
      join(repo.root, ".github", "hooks", "axiom-gate.json"),
      JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ type: "command", bash: "npx -y @codai/axiom-mcp gate --stdin" }] },
      }),
    );
    expect(byId(await runDoctor(base()), "hook.copilot")?.status).toBe("warn");
  });

  it("a JSONC .vscode/mcp.json (comments, trailing commas) is read, not reported as invalid", async () => {
    // brivio's mcp.json carries // comments; strict JSON.parse flagged it "not valid JSON".
    await runInit({ root: repo.root, profileName: "demo" });
    await writeFile(
      join(repo.root, ".vscode", "mcp.json"),
      [
        "{",
        '  "servers": {',
        "    // local db, see infra/docker-compose.yml",
        '    "pg": { "command": "npx", "args": ["postgresql://u:p@h:1/db"] },',
        "    /* the gate */",
        '    "axiom": { "command": "npx", "args": ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "/w"] },',
        "  },",
        "}",
      ].join("\n"),
    );
    const r = await runDoctor(base());
    expect(byId(r, "mcp.vscode")?.status).toBe("ok");
    // `//` inside a string (the postgres URL) must survive stripping.
    expect(JSON.parse(stripJsonc('{"u": "http://x//y", // c\n "b": [1,],}'))).toEqual({
      u: "http://x//y",
      b: [1],
    });
  });

  it("a broken journal chain fails", async () => {
    await mkdir(join(repo.root, ".axiom", "journal"), { recursive: true });
    await writeFile(join(repo.root, ".axiom", "journal", "chain.jsonl"), "garbage\n");
    const r = await runDoctor(base());
    expect(byId(r, "chain")?.status).toBe("fail");
    expect(byId(r, "chain")?.message).toContain("ERR_JOURNAL_CHAIN");
  });

  it("a root that is not a directory fails immediately", async () => {
    const r = await runDoctor(base({ root: join(repo.root, "missing") }));
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([expect.objectContaining({ id: "root", status: "fail" })]);
  });
});

const put = async (rel: string, v: unknown) => {
  const abs = join(repo.root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, typeof v === "string" ? v : JSON.stringify(v));
};
const statusOf = async (id: string, over: Partial<DoctorOptions> = {}) =>
  byId(await runDoctor(base(over)), id)?.status;

describe("axiom doctor — every harness", () => {
  it("init for each harness yields an ok hook check (and --daemon too)", async () => {
    const cases = [
      ["cursor", "hook.cursor"],
      ["windsurf", "hook.windsurf"],
      ["codex", "hook.codex"],
      ["gemini", "hook.gemini"],
      ["cline", "hook.cline"],
      ["claude", "hook.claude"],
    ] as const;
    for (const daemon of [false, true]) {
      for (const [harness, id] of cases) {
        await runInit({ root: repo.root, harness, profileName: "demo", daemon, force: true });
        const r = await runDoctor(base());
        const hits = r.checks.filter((c) => c.id === id);
        expect(hits.length, `${harness} daemon=${daemon}`).toBeGreaterThan(0);
        expect(
          hits.every((c) => c.status === "ok"),
          `${harness} daemon=${daemon}`,
        ).toBe(true);
      }
    }
  });

  it("npx or foreign entries never count; cursor without failClosed warns", async () => {
    await put(".cursor/hooks.json", {
      version: 1,
      hooks: { preToolUse: [{ command: "npx -y @codai/axiom-mcp gate --stdin" }] },
    });
    expect(await statusOf("hook.cursor")).toBe("warn");
    const noFc = cursorHooks() as { hooks: { preToolUse: Record<string, unknown>[] } };
    noFc.hooks.preToolUse = noFc.hooks.preToolUse.map(({ failClosed: _f, ...rest }) => rest);
    await put(".cursor/hooks.json", noFc);
    const r = await runDoctor(base());
    const cursor = r.checks.filter((c) => c.id === "hook.cursor").map((c) => c.status);
    expect(cursor).toEqual(["ok", "warn"]);

    await put(".gemini/settings.json", { hooks: { BeforeTool: [{ hooks: [{ command: "x" }] }] } });
    expect(await statusOf("hook.gemini")).toBe("warn");
    await put(".codex/hooks.json", "{broken");
    expect(await statusOf("hook.codex")).toBe("fail");
    await put(".windsurf/hooks.json", { hooks: { pre_write_code: [{ command: "lint.sh" }] } });
    expect(await statusOf("hook.windsurf")).toBe("warn");
  });

  it("windsurf: .devin/hooks.json wins over the legacy file unless it is empty", async () => {
    await put(".windsurf/hooks.json", {
      hooks: { pre_write_code: [{ command: "axiom gate --stdin --format windsurf" }] },
    });
    await put(".devin/hooks.json", {});
    expect(byId(await runDoctor(base()), "hook.windsurf")?.message).toContain(".windsurf/");
    await put(".devin/hooks.json", { hooks: { pre_run_command: [{ command: "lint.sh" }] } });
    const r = await runDoctor(base());
    expect(byId(r, "hook.windsurf")?.status).toBe("warn");
    expect(byId(r, "hook.windsurf")?.message).toContain(".devin/");
  });

  it("cline: a hook without the cancel fallback or not calling axiom warns", async () => {
    await put(".clinerules/hooks/PreToolUse.ps1", "axiom gate --stdin --format cline\n");
    expect(await statusOf("hook.cline")).toBe("warn");
    await put(".clinerules/hooks/PreToolUse.ps1", 'npx axiom gate --stdin {"cancel":true}\n');
    expect(await statusOf("hook.cline")).toBe("warn");
  });

  it("junie: reads ~/.junie/config.json read-only; absent → no check", async () => {
    expect(await statusOf("hook.junie")).toBeUndefined();
    await mkdir(join(home.root, ".junie"));
    await writeFile(
      join(home.root, ".junie", "config.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ command: "axiom-hook gate --stdin --format junie" }] },
          ],
        },
      }),
    );
    expect(await statusOf("hook.junie")).toBe("ok");
    await writeFile(join(home.root, ".junie", "config.json"), JSON.stringify({ hooks: {} }));
    expect(await statusOf("hook.junie")).toBeUndefined();
    await mkdir(join(repo.root, ".junie"));
    expect(await statusOf("hook.junie")).toBe("warn");
  });
});

describe("axiom doctor — gate profile vs global bin", () => {
  it("steer keys with a global bin < 2.5.0 fail; ≥ 2.5.0 ok; no steer keys → no check", async () => {
    await put(".axiom/gate-profile.json", { deny: [], steer: "hint" });
    const old = await runDoctor(
      base({ locateBin: async () => ({ path: "/a", version: "2.4.1" }) }),
    );
    expect(byId(old, "bin.profile")?.status).toBe("fail");
    expect(byId(old, "bin.profile")?.hint).toContain("@codai/axiom-mcp@latest");
    expect(old.ok).toBe(false);
    expect(
      await statusOf("bin.profile", { locateBin: async () => ({ path: "/a", version: "2.5.0" }) }),
    ).toBe("ok");
    await put(".axiom/gate-profile.json", { deny: [] });
    expect(await statusOf("bin.profile")).toBeUndefined();
  });

  it("ask globs need a global bin ≥ ASK_MIN_VERSION", async () => {
    await put(".axiom/gate-profile.json", { deny: [], ask: [".github/**"] });
    const old = await runDoctor(
      base({ locateBin: async () => ({ path: "/a", version: "2.6.1" }) }),
    );
    expect(byId(old, "bin.profile")?.status).toBe("fail");
    expect(byId(old, "bin.profile")?.message).toContain(`< ${ASK_MIN_VERSION}`);
    expect(
      await statusOf("bin.profile", {
        locateBin: async () => ({ path: "/a", version: ASK_MIN_VERSION }),
      }),
    ).toBe("ok");
  });

  it("compareVersions orders semver triples", () => {
    expect(compareVersions("2.4.9", "2.5.0")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.5.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.5.0", "2.5.0")).toBe(0);
  });
});

describe("axiom doctor — resident daemon", () => {
  it("health probe refuses a non-loopback host from daemon.json (token never sent)", async () => {
    await expect(
      defaultHealthFetch(200)({
        protocol: 1,
        pid: 1,
        host: "example.com",
        port: 80,
        version: "9.9.9",
        roots: [],
        startedAt: "2026-10-14T00:00:00Z",
        token: "t",
      }),
    ).rejects.toThrow(/not loopback/);
  });

  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const writeState = async (port: number, roots: string[], token?: string, protocol: 1 | 2 = 2) => {
    await mkdir(join(home.root, ".axiom"), { recursive: true });
    await writeFile(
      join(home.root, ".axiom", "daemon.json"),
      JSON.stringify({
        protocol,
        pid: 4242,
        host: "127.0.0.1",
        port,
        version: "9.9.9",
        roots,
        startedAt: "2026-10-14T00:00:00Z",
        ...(protocol === 2 ? { key: "ab".repeat(32) } : {}),
        ...(token === undefined ? {} : { token }),
      }),
      { mode: 0o600 },
    );
  };

  const listen = async (roots: string[], seen: Record<string, string | undefined>[]) => {
    server = createServer((req, res) => {
      seen.push({
        url: req.url,
        protocol: req.headers["x-axiom-protocol"] as string | undefined,
        auth: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ protocol: 1, version: "9.9.9", pid: 4242, roots }));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  };

  it.runIf(process.platform !== "win32")(
    // POSIX only: Windows has no mode bits (the daemon sets an ACL instead).
    "a group-readable daemon.json warns instead of looking like no daemon",
    async () => {
      await mkdir(join(home.root, ".axiom"), { recursive: true });
      await writeFile(
        join(home.root, ".axiom", "daemon.json"),
        JSON.stringify({ protocol: 2, pid: 1, host: "127.0.0.1", port: 1, key: "ab".repeat(32) }),
        { mode: 0o644 },
      );
      const d = byId(await runDoctor(base()), "daemon");
      expect(d?.status).toBe("warn");
      expect(d?.hint).toMatch(/chmod 600/);
    },
  );

  it("no daemon.json → ok (in-process)", async () => {
    expect(await statusOf("daemon")).toBe("ok");
  });

  it("a live daemon serving the parent dir → ok; protocol 2 header, no bearer sent", async () => {
    const seen: Record<string, string | undefined>[] = [];
    const parent = join(repo.root, "..");
    const port = await listen([parent], seen);
    await writeState(port, [parent], "tok");
    const d = byId(await runDoctor(base()), "daemon");
    expect(d?.status).toBe("ok");
    expect(d?.message).toContain("4242");
    expect(seen).toEqual([{ url: "/v1/health", protocol: "2", auth: undefined }]);
  });

  it("a daemon that does not serve this root warns", async () => {
    const port = await listen([join(home.root, "elsewhere")], []);
    await writeState(port, [join(home.root, "elsewhere")]);
    expect(await statusOf("daemon")).toBe("warn");
  });

  it("a daemon root given as an alias of the parent (macOS /var, Windows 8.3) still counts", async () => {
    const alias = join(home.root, "alias-parent");
    await symlink(join(repo.root, ".."), alias, process.platform === "win32" ? "junction" : "dir");
    const port = await listen([alias], []);
    await writeState(port, [alias]);
    expect(await statusOf("daemon")).toBe("ok");
  });

  it("a daemon that serves nothing relevant warns (sanity)", async () => {
    const port = await listen([join(home.root, "elsewhere")], []);
    await writeState(port, [join(home.root, "elsewhere")]);
    expect(await statusOf("daemon")).toBe("warn");
  });

  it("an unreachable daemon → warn stale daemon.json", async () => {
    const port = await listen([], []);
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    await writeState(port, [repo.root]);
    const d = byId(await runDoctor(base()), "daemon");
    expect(d?.status).toBe("warn");
    expect(d?.message).toMatch(/^stale daemon\.json/);
  });
});

describe("axiom doctor — VS Code hook log", () => {
  const line = (id: number, kind: string, rest: string) =>
    `2026-10-14 01:43:28.080 [info] [#${id}] [PreToolUse] ${kind}: ${rest}`;
  const run = (id: number, ms: number, outcome = "Success") => [
    line(id, "Running", '{"command":"& ./.github/hooks/axiom-gate.ps1","timeout":10}'),
    `2026-10-14 01:43:29.156 [info] [#${id}] [PreToolUse] Completed (${outcome}) in ${ms}ms`,
  ];
  const writeLog = async (lines: string[]) => {
    const f = join(home.root, "hooks.log");
    await writeFile(f, `${lines.join("\n")}\n`);
    return [f];
  };

  it("no log files or no axiom runs → no check", async () => {
    expect(await statusOf("hook.log.vscode")).toBeUndefined();
    const hookLogs = await writeLog([line(1, "Running", '{"command":"guard.ps1"}')]);
    expect(await statusOf("hook.log.vscode", { hookLogs })).toBeUndefined();
  });

  it("fast clean runs → ok; NonBlockingError → warn; slow p95 → warn", async () => {
    expect(await statusOf("hook.log.vscode", { hookLogs: await writeLog(run(1, 90)) })).toBe("ok");
    const nbe = byId(
      await runDoctor(
        base({ hookLogs: await writeLog([...run(1, 90), ...run(2, 12692, "NonBlockingError")]) }),
      ),
      "hook.log.vscode",
    );
    expect(nbe?.status).toBe("warn");
    expect(nbe?.message).toMatch(/^1 axiom gate runs ended NonBlockingError/);
    expect(await statusOf("hook.log.vscode", { hookLogs: await writeLog([...run(1, 4500)]) })).toBe(
      "warn",
    );
  });

  it("finds the newest session's log via home/appData/platform", async () => {
    const logs = join(home.root, "AppData", "Roaming", "Code - Insiders", "logs");
    for (const [session, ms] of [
      ["20261013T090000", 9000],
      ["20261014T010000", 80],
    ] as const) {
      const dir = join(logs, session, "window1", "exthost", "GitHub.copilot-chat");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "GitHub Copilot Chat Hooks.log"), run(1, ms).join("\n"));
    }
    const r = await runDoctor(base({ hookLogs: undefined, platform: "win32" }));
    expect(byId(r, "hook.log.vscode")?.status).toBe("ok");
    expect(byId(r, "hook.log.vscode")?.message).toContain("p95 80 ms");
  });

  const foreignRun = (id: number, cwd: string) =>
    line(
      id,
      "Running",
      JSON.stringify({ command: "C:/u/.copilot/hooks/hook-pre.ps1", cwd: { fsPath: cwd } }),
    );

  it("hooks fire for this workspace but the gate never runs → fail (VS Code skipped the file)", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const lines = Array.from({ length: 25 }, (_, i) => foreignRun(i + 1, repo.root));
    const c = byId(await runDoctor(base({ hookLogs: await writeLog(lines) })), "hook.log.vscode");
    expect(c?.status).toBe("fail");
    expect(c?.message).toMatch(
      /^25 PreToolUse hook runs for this workspace .* 0 of them the axiom gate/,
    );
  });

  it("runs from OTHER workspaces do not trigger the silent-gate failure", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const lines = Array.from({ length: 25 }, (_, i) => foreignRun(i + 1, home.root));
    expect(await statusOf("hook.log.vscode", { hookLogs: await writeLog(lines) })).toBeUndefined();
  });

  it("a log cwd that is an alias of the root (macOS /var, Windows 8.3, junction) still counts", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const alias = join(home.root, "alias-root");
    await symlink(repo.root, alias, process.platform === "win32" ? "junction" : "dir");
    const lines = Array.from({ length: 25 }, (_, i) => foreignRun(i + 1, alias));
    expect(await statusOf("hook.log.vscode", { hookLogs: await writeLog(lines) })).toBe("fail");
  });
});

describe("axiom doctor — copilot hook shape", () => {
  it("an exec-only axiom-gate.json fails: VS Code never runs it", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    await writeFile(
      join(repo.root, ".github", "hooks", "axiom-gate.json"),
      JSON.stringify({
        version: 1,
        hooks: { preToolUse: [{ type: "command", exec: "axiom", args: ["gate", "--stdin"] }] },
      }),
    );
    const c = byId(await runDoctor(base()), "hook.copilot");
    expect(c?.status).toBe("fail");
    expect(c?.message).toMatch(/only via exec\/args/);
  });
});

describe("axiom doctor — fail-open audit (S-1203) and post-write wiring (S-1205)", () => {
  const idsWith = (r: Awaited<ReturnType<typeof runDoctor>>, prefix: string) =>
    r.checks.filter((c) => c.id.startsWith(prefix)).map((c) => [c.id, c.status]);
  const binAt =
    (version: string): NonNullable<DoctorOptions["locateBin"]> =>
    async () => ({
      path: "/a",
      version,
    });

  it("claude with onFailure: block → no failopen.claude; without it → warn", async () => {
    await runInit({ root: repo.root, harness: "claude", profileName: "demo" });
    const ok = await runDoctor(base());
    expect(byId(ok, "failopen.claude")).toBeUndefined();
    const { onFailure: _o, ...noKnob } = CLAUDE_HOOK_ENTRY.hooks[0] ?? {};
    await put(".claude/settings.json", {
      hooks: {
        PreToolUse: [{ matcher: "Write", hooks: [noKnob] }],
        PostToolUse: [CLAUDE_POST_HOOK_ENTRY],
      },
    });
    expect(await statusOf("failopen.claude")).toBe("warn");
  });

  it("cursor with failClosed has no failopen check (hook.cursor warns without it, unchanged)", async () => {
    await runInit({ root: repo.root, harness: "cursor", profileName: "demo" });
    expect(idsWith(await runDoctor(base()), "failopen.")).toEqual([]);
  });

  it("harnesses without a fail-closed knob warn failopen.<harness> when wired", async () => {
    for (const harness of ["copilot", "codex", "gemini", "windsurf"] as const) {
      await runInit({ root: repo.root, harness, profileName: "demo", force: true });
    }
    const r = await runDoctor(base());
    // copilot: info-level ("ok") while the gate p95 stays within 50 % of the hook timeout.
    expect(idsWith(r, "failopen.")).toEqual([
      ["failopen.copilot", "ok"],
      ["failopen.windsurf", "warn"],
      ["failopen.codex", "warn"],
      ["failopen.gemini", "warn"],
    ]);
    expect(r.ok).toBe(true);
    // A missing timeout is called out in the hint.
    await put(".codex/hooks.json", {
      hooks: { PreToolUse: [{ ...codexHookEntry(), hooks: [{ command: "axiom gate --stdin" }] }] },
    });
    expect(byId(await runDoctor(base()), "failopen.codex")?.hint).toMatch(/"timeout"/);
  });

  it("hook.post.<harness>: ok when wired (bin ≥ 2.6.0), warn when missing or bin too old", async () => {
    for (const d of [".github", ".claude", ".codex"]) await mkdir(join(repo.root, d));
    await runInit({ root: repo.root, profileName: "demo" });
    const ok = await runDoctor(base());
    expect(idsWith(ok, "hook.post.")).toEqual([
      ["hook.post.copilot", "ok"],
      ["hook.post.claude", "ok"],
      ["hook.post.codex", "ok"],
    ]);
    const old = await runDoctor(base({ locateBin: binAt("2.5.2") }));
    expect(byId(old, "hook.post.claude")?.status).toBe("warn");
    await put(".claude/settings.json", { hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] } });
    const missing = byId(await runDoctor(base()), "hook.post.claude");
    expect(missing?.status).toBe("warn");
    expect(missing?.hint).toBe("axiom init --upgrade");
  });
});

describe("axiom doctor — 3.0 refinements (D-45)", () => {
  const copilotWith = (timeoutSec: number | undefined) =>
    put(".github/hooks/axiom-gate.json", {
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            command: "axiom gate --stdin --format auto",
            ...(timeoutSec === undefined ? {} : { timeoutSec }),
          },
        ],
      },
    });

  it("reports the hook file's real timeout and judges latency against it", async () => {
    await copilotWith(2);
    const r = await runDoctor(base({ probe: async () => ({ ms: 1700, exit: 0 }) }));
    const lat = byId(r, "gate.latency");
    expect(lat?.message).toContain("hook timeout 2000 ms");
    // 1700 > 80 % of 2000 → fail even though it is far below the old 4 s budget.
    expect(lat?.status).toBe("fail");
    await copilotWith(undefined);
    const def = byId(await runDoctor(base()), "gate.latency");
    expect(def?.message).toContain("hook timeout 30000 ms");
    expect(def?.status).toBe("ok");
  });

  it("failopen.copilot: ok (info) under 50 % of the timeout, warn above it", async () => {
    await copilotWith(1);
    expect(await statusOf("failopen.copilot", { probe: async () => ({ ms: 400, exit: 0 }) })).toBe(
      "ok",
    );
    expect(await statusOf("failopen.copilot", { probe: async () => ({ ms: 600, exit: 0 }) })).toBe(
      "warn",
    );
  });

  it("a denied probe is not blamed on globs when gate.profile already failed", async () => {
    await put(".axiom/gate-profile.json", '{"deny":"x"}');
    const r = await runDoctor(base({ probe: async () => ({ ms: 5, exit: 0, denied: true }) }));
    expect(byId(r, "gate.profile")?.status).toBe("fail");
    expect(byId(r, "gate.latency")?.status).toBe("ok");
    expect(byId(r, "gate.latency")?.hint).toBeUndefined();
  });

  it("node.onPath: fail when a shim hook runs and node is missing; ok with node or a native exe", async () => {
    await copilotWith(15);
    expect(await statusOf("node.onPath", { locateNode: async () => undefined })).toBe("fail");
    expect(await statusOf("node.onPath")).toBe("ok");
    expect(
      await statusOf("node.onPath", {
        locateNode: async () => undefined,
        locateBin: async () => ({ path: "C:/bin/axiom.exe", version: "9.9.9" }),
      }),
    ).toBe("ok");
    // axiom-hook (native thin client) is not the shim → no check.
    await put(".github/hooks/axiom-gate.json", {
      version: 1,
      hooks: { preToolUse: [{ type: "command", command: "axiom-hook gate --stdin" }] },
    });
    expect(await statusOf("node.onPath", { locateNode: async () => undefined })).toBeUndefined();
  });

  it("a protocol-1 or keyless daemon.json warns: restart the daemon (protocol 2)", async () => {
    await mkdir(join(home.root, ".axiom"), { recursive: true });
    const state = {
      pid: 1,
      host: "127.0.0.1",
      port: 1,
      version: "2.6.0",
      roots: [repo.root],
      startedAt: "2026-10-14T00:00:00Z",
    };
    await writeFile(
      join(home.root, ".axiom", "daemon.json"),
      JSON.stringify({ ...state, protocol: 1, token: "t" }),
      { mode: 0o600 },
    );
    const d = byId(
      await runDoctor(
        base({
          healthFetch: async () => {
            throw new Error("must not be called");
          },
        }),
      ),
      "daemon",
    );
    expect(d?.status).toBe("warn");
    expect(d?.hint).toMatch(/protocol 2/);
  });
});
