import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newJournal, writeJournal } from "@codai/axiom-apply";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DoctorOptions,
  GATE_P95_FAIL_MS,
  GATE_PROBE_RUNS,
  runDoctor,
  stripJsonc,
} from "./doctor.js";
import { runInit } from "./init.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-doctor-");
});
afterEach(async () => {
  await repo.cleanup();
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
