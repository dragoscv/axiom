import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckRef } from "@codai/axiom-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_POOL_SIZE, runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { guardEnv, parseLegacyText, resolveGuardCommand } from "./guard.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "guards");

let root: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axiom-guard-")));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(FIXTURES, join(root, "scripts"), { recursive: true });
  outside = join(root, "..", "axiom-guard-outside.mjs");
  await writeFile(outside, "process.stdout.write(JSON.stringify({ ok: true }));\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { force: true });
});

const bundle = makeBundle([{ path: "src/a.ts", content: "x" }]);

function guardCheck(id: string, params: Record<string, unknown>): CheckRef {
  return { id, predicate: "guard.external", params: params as never, severity: "error" };
}

async function run(
  params: Record<string, unknown>,
  opts: { allowGuards?: boolean; profileAllows?: boolean; allowlist?: string[] } = {},
) {
  return runChecks({
    bundle,
    root,
    profile: profileWith([guardCheck("g", params)], { allowGuards: opts.profileAllows ?? true }),
    allowGuards: opts.allowGuards ?? true,
    guardAllowlist: opts.allowlist ?? [],
  });
}

const code = (r: Awaited<ReturnType<typeof run>>) => r.findings[0]?.facts.code;

describe("guard.external gating", () => {
  it("is disabled by default: server flag off → error finding, nothing spawned", async () => {
    const r = await run({ command: "ok.mjs" }, { allowGuards: false });
    expect(r.verdict).toBe("error");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.id).toBe("g");
    expect(code(r)).toBe("ERR_FACT_DISABLED");
    expect(r.findings[0]?.message).toMatch(/disabled/);
    expect(r.providers.find((p) => p.name === "guard")?.status).toBe("error");
  });
  it("profile forbids guards → error even when the server allows", async () => {
    const r = await run({ command: "ok.mjs" }, { profileAllows: false });
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_FACT_DISABLED");
    expect(r.providers.find((p) => p.name === "guard")?.status).toBe("error");
  });
  it("no root → disabled", async () => {
    const r = await runChecks({
      bundle,
      profile: profileWith([guardCheck("g", { command: "ok.mjs" })], { allowGuards: true }),
      allowGuards: true,
    });
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_FACT_DISABLED");
  });
  it("no guard checks → provider skipped", async () => {
    const r = await runChecks({ bundle, root, profile: profileWith([]), allowGuards: true });
    expect(r.providers.find((p) => p.name === "guard")?.status).toBe("skipped");
  });
});

describe("guard.external command resolution", () => {
  it("relative with .. is rejected", async () => {
    const r = await run({ command: "../axiom-guard-outside.mjs" });
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_PREDICATE_PARAMS");
    expect(r.findings[0]?.message).toMatch(/\.\./);
  });
  it("relative escaping scripts/ via a sibling dir is rejected", async () => {
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "other", "x.mjs"), "");
    const r = await run({ command: "scripts/../other/x.mjs" });
    expect(code(r)).toBe("ERR_PREDICATE_PARAMS");
  });
  it("absolute path not in the allowlist is rejected", async () => {
    const r = await run({ command: join(root, "scripts", "ok.mjs") });
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_PREDICATE_PARAMS");
    expect(r.findings[0]?.message).toMatch(/allowlist/);
  });
  it("absolute path in the allowlist runs", async () => {
    const abs = join(root, "scripts", "ok.mjs");
    const r = await run({ command: abs }, { allowlist: [abs] });
    expect(r.verdict).toBe("pass");
  });
  it("missing relative file is rejected", async () => {
    const r = await run({ command: "nope.mjs" });
    expect(code(r)).toBe("ERR_PREDICATE_PARAMS");
  });
  it("relative non-script extension is rejected", async () => {
    await writeFile(join(root, "scripts", "x.exe"), "");
    const r = await run({ command: "x.exe" });
    expect(code(r)).toBe("ERR_PREDICATE_PARAMS");
    expect(r.findings[0]?.message).toMatch(/mjs/);
  });
  it("scripts/ prefix is accepted and resolves to node", async () => {
    const res = await resolveGuardCommand("scripts/ok.mjs", ["--x"], root, []);
    expect("file" in res && res.file).toBe(process.execPath);
    expect("argv" in res && res.argv.slice(1)).toEqual(["--x"]);
  });
  it(".ps1 resolves to pwsh -File", async () => {
    await writeFile(join(root, "scripts", "g.ps1"), "");
    const res = await resolveGuardCommand("g.ps1", [], root, []);
    expect("file" in res && res.file).toBe("pwsh");
    expect("argv" in res && res.argv.slice(0, 4)).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
  });
});

describe("guard.external output mapping", () => {
  it("ok.mjs → pass, no findings, guard provider ok", async () => {
    const r = await run({ command: "ok.mjs" });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.providers.find((p) => p.name === "guard")?.status).toBe("ok");
  });
  it("fail.mjs (exit 1 + JSON) → findings mapped, severity from output or check", async () => {
    const r = await run({ command: "fail.mjs" });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => [f.id, f.severity, f.path ?? ""])).toEqual([
      ["lint.note", "error", ""],
      ["lint.todo", "error", "src/a.ts"],
    ]);
    expect(r.findings[0]?.facts.n).toBe(1);
    expect(r.findings[1]?.predicate).toBe("guard.external");
  });
  it("bad-output.mjs (exit 0, non-JSON) → ERR_GUARD_OUTPUT, fail closed", async () => {
    const r = await run({ command: "bad-output.mjs" });
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_GUARD_OUTPUT");
    expect(r.findings[0]?.facts.exitCode).toBe(0);
    expect(r.findings[0]?.facts.stdout).toMatch(/hello/);
  });
  it("exit1-nojson.mjs → ERR_GUARD_OUTPUT with stderr tail", async () => {
    const r = await run({ command: "exit1-nojson.mjs" });
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_GUARD_OUTPUT");
    expect(r.findings[0]?.facts.exitCode).toBe(1);
    expect(r.findings[0]?.facts.stderr).toMatch(/boom: something broke/);
  });
  it("hang.mjs with timeoutMs 500 → ERR_GUARD_TIMEOUT", async () => {
    const t0 = Date.now();
    const r = await run({ command: "hang.mjs", timeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.verdict).toBe("error");
    expect(code(r)).toBe("ERR_GUARD_TIMEOUT");
    expect(r.findings[0]?.facts.timeoutMs).toBe(500);
  });
  it("echo-stdin.mjs receives the JCS bundle and AXIOM_* env", async () => {
    const r = await run({ command: "echo-stdin.mjs" });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toEqual([]);
  });
  it("stdin: none → guard sees empty stdin", async () => {
    const r = await run({ command: "echo-stdin.mjs", stdin: "none" });
    expect(r.verdict).toBe("fail");
    expect(r.findings[0]?.message).toMatch(/not json/);
  });
  it("env is scrubbed (SECRET_X dropped) and params.env passes through", async () => {
    process.env.SECRET_X = "leak";
    try {
      const r = await run({ command: "env-leak.mjs", env: { GUARD_EXTRA: "yes" } });
      expect(r.verdict).toBe("pass");
    } finally {
      delete process.env.SECRET_X;
    }
    const r2 = await run({ command: "env-leak.mjs" });
    expect(r2.verdict).toBe("fail");
    expect(r2.findings[0]?.message).toMatch(/GUARD_EXTRA missing/);
  });
  it("guardEnv keeps only the whitelist, strips NODE_OPTIONS", () => {
    const e = guardEnv({ A: "1" }, "sha256:x", "/r", {
      PATH: "p",
      SECRET: "s",
      NODE_OPTIONS: "--inspect",
      Path: "q",
    });
    expect(e).toEqual({
      PATH: "p",
      Path: "q",
      A: "1",
      AXIOM_MANIFEST_DIGEST: "sha256:x",
      AXIOM_ROOT: "/r",
      NODE_OPTIONS: "",
    });
  });
  it("legacy text is rejected unless legacyText: true", async () => {
    const r = await run({ command: "legacy.mjs" });
    expect(code(r)).toBe("ERR_GUARD_OUTPUT");
    const r2 = await run({ command: "legacy.mjs", legacyText: true });
    expect(r2.verdict).toBe("fail");
    expect(r2.findings).toHaveLength(1);
    expect(r2.findings[0]?.id).toBe("b");
    expect(r2.findings[0]?.message).toBe("reason here");
  });
  it("parseLegacyText: all OK → ok:true; no recognised lines → undefined", () => {
    expect(parseLegacyText("OK    a\nOK    b\n")).toEqual({ ok: true, findings: [] });
    expect(parseLegacyText("random\n")).toBeUndefined();
    expect(parseLegacyText("FAIL  x\n")?.findings[0]?.message).toBe("guard failed");
  });
  it("cwd: staging without a staging dir → params error", async () => {
    const r = await run({ command: "ok.mjs", cwd: "staging" });
    expect(code(r)).toBe("ERR_PREDICATE_PARAMS");
  });
  it("check severity re-labels non-provider findings", async () => {
    const r = await runChecks({
      bundle,
      root,
      allowGuards: true,
      profile: profileWith(
        [
          {
            id: "g",
            predicate: "guard.external",
            params: { command: "fail.mjs" } as never,
            severity: "warn",
          },
        ],
        { allowGuards: true },
      ),
    });
    expect(r.verdict).toBe("pass");
    expect(r.findings.every((f) => f.severity === "warn")).toBe(true);
  });
});

describe("guard.external pool", () => {
  it(`runs 6 guards with at most ${GUARD_POOL_SIZE} concurrent`, async () => {
    const counter = join(root, "counter");
    await rm(counter, { recursive: true, force: true });
    const checks = Array.from({ length: 6 }, (_, i) =>
      guardCheck(`g${i}`, { command: "concurrent.mjs", env: { GUARD_COUNTER_DIR: counter } }),
    );
    const r = await runChecks({
      bundle,
      root,
      allowGuards: true,
      profile: profileWith(checks, { allowGuards: true }),
    });
    expect(r.verdict).toBe("pass");
    const peaks = await Promise.all(
      (await readdir(counter))
        .filter((f) => f.startsWith("peak-"))
        .map(async (f) => Number(await readFile(join(counter, f), "utf8"))),
    );
    expect(peaks).toHaveLength(6);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(GUARD_POOL_SIZE);
    if (GUARD_POOL_SIZE > 1) expect(Math.max(...peaks)).toBeGreaterThan(1);
  });
});
