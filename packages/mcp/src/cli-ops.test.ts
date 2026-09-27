/**
 * S-701/702/705/706/707 CLI verbs against the built `dist/cli.js` (same pattern as cli.test.ts:
 * skipped when dist is absent). Asserts on exit codes, `code` fields and JSON shape only.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chainPath, newJournal, writeJournal } from "@codai/axiom-apply";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePlan, tmpRepo } from "./test-helpers.js";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const hasDist = existsSync(CLI);

/** No ambient OIDC in the child, even on a CI runner with `id-token: write`. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "SIGSTORE_ID_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ])
    delete env[k];
  return env;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      env: cleanEnv(),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const json = <T>(r: Run): T => JSON.parse(r.stdout) as T;

describe.skipIf(!hasDist)("cli ops verbs (dist/cli.js)", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-cli-ops-");
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  async function compileApply(files: Record<string, string>, name: string) {
    const planFile = join(repo.root, `${name}.plan.json`);
    const bundleFile = join(repo.root, `${name}.bundle.json`);
    await writeFile(planFile, JSON.stringify(makePlan(files, { name })));
    const c = await run(["compile", planFile, "-o", bundleFile]);
    expect(c.code, c.stderr).toBe(0);
    const { manifestDigest } = json<{ manifestDigest: string }>(c);
    const ap = await run(["apply", bundleFile, "--root", repo.root, "--confirm", manifestDigest]);
    expect(ap.code, ap.stderr).toBe(0);
    return { manifestDigest, bundleFile };
  }

  it("init --json creates all files; second run skips all; --force updates owned files", async () => {
    const a = await run(["init", "--root", repo.root, "--profile-name", "demo", "--json"]);
    expect(a.code, a.stderr).toBe(0);
    const first = json<{ files: { path: string; action: string }[] }>(a).files;
    expect(first.map((f) => f.action)).toEqual(Array(5).fill("created"));
    const b = json<{ files: { action: string }[] }>(
      await run(["init", "--root", repo.root, "--profile-name", "demo", "--json"]),
    ).files;
    expect(b.map((f) => f.action)).toEqual(Array(5).fill("skipped"));
    await writeFile(join(repo.root, ".axiom", "gate-profile.json"), "{}\n");
    const c = json<{ files: { path: string; action: string }[] }>(
      await run(["init", "--root", repo.root, "--profile-name", "demo", "--force", "--json"]),
    ).files;
    expect(c.find((f) => f.path === ".axiom/gate-profile.json")?.action).toBe("updated");
    expect((await run(["init", "--root", repo.root, "--harness", "emacs"])).code).toBe(2);
  });

  it("doctor --json on an init'ed root has no fail (exit 0); an interrupted journal → exit 2", async () => {
    await run(["init", "--root", repo.root, "--profile-name", "demo"]);
    const ok = await run(["doctor", "--root", repo.root, "--json"]);
    expect(ok.code, ok.stdout).toBe(0);
    const checks = json<{ checks: { id: string; status: string }[] }>(ok).checks;
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.id === "gate.latency")?.status).toBe("ok");
    const digest = `sha256:${"ab".repeat(32)}` as const;
    await writeJournal(repo.root, {
      ...newJournal(digest, [{ path: "a.txt", op: "create", done: false }]),
      phase: "committing",
    });
    const bad = await run(["doctor", "--root", repo.root, "--json"]);
    expect(bad.code).toBe(2);
    const j = json<{ ok: boolean; checks: { id: string; status: string }[] }>(bad);
    expect(j.ok).toBe(false);
    expect(j.checks.find((c) => c.id === "journal")?.status).toBe("fail");
  }, 120_000);

  it("status / log after two applies: lastApplied = newest, log newest-first, --limit", async () => {
    const one = await compileApply({ "a.txt": "a\n" }, "one");
    const two = await compileApply({ "b.txt": "b\n" }, "two");
    const st = await run(["status", "--root", repo.root, "--json"]);
    expect(st.code, st.stderr).toBe(0);
    const s = json<{
      lock: { held: boolean };
      lastApplied: { manifestDigest: string; seq: number };
      chain: { ok: boolean; entries: number };
    }>(st);
    expect(s.lock.held).toBe(false);
    expect(s.lastApplied).toMatchObject({ manifestDigest: two.manifestDigest, seq: 2 });
    expect(s.chain).toMatchObject({ ok: true, entries: 2 });
    const lg = json<{ entries: { manifestDigest: string; name?: string; state: string }[] }>(
      await run(["log", "--root", repo.root, "--json"]),
    );
    expect(lg.entries.map((e) => e.manifestDigest)).toEqual([
      two.manifestDigest,
      one.manifestDigest,
    ]);
    expect(lg.entries.map((e) => e.name)).toEqual(["two", "one"]);
    expect(lg.entries.every((e) => e.state === "committed")).toBe(true);
    const lim = json<{ entries: unknown[] }>(
      await run(["log", "--root", repo.root, "--limit", "1", "--json"]),
    );
    expect(lim.entries).toHaveLength(1);
    expect((await run(["log", "--root", repo.root, "--limit", "0"])).code).toBe(2);
  });

  it("verify --journal: ok → exit 0; an edited chain.jsonl → exit 1 with ERR_JOURNAL_CHAIN", async () => {
    await compileApply({ "a.txt": "a\n" }, "one");
    await compileApply({ "b.txt": "b\n" }, "two");
    const ok = await run(["verify", "--journal", "--root", repo.root]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(json<{ ok: boolean; entries: number }>(ok)).toMatchObject({ ok: true, entries: 2 });
    const file = chainPath(repo.root);
    const lines = (await readFile(file, "utf8")).split("\n");
    lines[0] = (lines[0] ?? "").replace('"files":1', '"files":7');
    await writeFile(file, lines.join("\n"));
    const bad = await run(["verify", "--journal", "--root", repo.root]);
    expect(bad.code).toBe(1);
    const b = json<{ ok: boolean; code: string; firstBad: { seq: number; reason: string } }>(bad);
    expect(b.code).toBe("ERR_JOURNAL_CHAIN");
    expect(b.ok).toBe(false);
    expect(b.firstBad).toEqual({ seq: 2, reason: "prev-mismatch" });
    expect((await run(["verify", "--journal"])).code).toBe(2); // --root required
  });

  it("compile of a YAML plan gives the same manifestDigest as its JSON twin", async () => {
    const plan = makePlan({ "src/x.ts": "export {};\n", "README.md": "# y\n" }, { name: "twin" });
    const jsonFile = join(repo.root, "p.json");
    const yamlFile = join(repo.root, "p.yaml");
    await writeFile(jsonFile, JSON.stringify(plan));
    // JSON is valid YAML 1.2 flow syntax; add a comment + block style header to make it real YAML.
    await writeFile(
      yamlFile,
      `# yaml-language-server: $schema=../schemas/plan.json\napiVersion: axiom.dev/v2\nkind: Plan\nname: twin\nintent: ${JSON.stringify(plan.intent)}\nartifacts: ${JSON.stringify(plan.artifacts)}\n`,
    );
    const a = await run(["compile", jsonFile, "-o", join(repo.root, "a.json")]);
    const b = await run(["compile", yamlFile, "-o", join(repo.root, "b.json")]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(json<{ manifestDigest: string }>(b).manifestDigest).toBe(
      json<{ manifestDigest: string }>(a).manifestDigest,
    );
    await writeFile(join(repo.root, "bad.yml"), "a: 1\n---\nb: 2\n");
    const bad = await run(["compile", join(repo.root, "bad.yml")]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("ERR_INVALID_PLAN");
  });

  it("apply --lock-timeout / --keep-backups validate integers (usage error, exit 2)", async () => {
    const planFile = join(repo.root, "p.json");
    const bundleFile = join(repo.root, "b.json");
    await writeFile(planFile, JSON.stringify(makePlan({ "a.txt": "a" })));
    const c = await run(["compile", planFile, "-o", bundleFile]);
    const { manifestDigest } = json<{ manifestDigest: string }>(c);
    for (const bad of [
      ["--lock-timeout", "-5"],
      ["--lock-timeout", "abc"],
      ["--lock-timeout", "600001"],
      ["--keep-backups", "1.5"],
    ]) {
      const r = await run([
        "apply",
        bundleFile,
        "--root",
        repo.root,
        "--confirm",
        manifestDigest,
        ...bad,
      ]);
      expect(r.code, bad.join(" ")).toBe(2);
      expect(r.stderr).toContain(bad[0] as string);
    }
    const ok = await run([
      "apply",
      bundleFile,
      "--root",
      repo.root,
      "--confirm",
      manifestDigest,
      "--lock-timeout",
      "2000",
      "--keep-backups",
      "0",
    ]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(json<{ status: string }>(ok).status).toBe("applied");
  });

  it("sign --keyless without ambient OIDC → exit 1, ERR_KEYLESS_UNAVAILABLE, bundle untouched", async () => {
    const planFile = join(repo.root, "p.json");
    const bundleFile = join(repo.root, "b.json");
    await writeFile(planFile, JSON.stringify(makePlan({ "a.txt": "a" })));
    expect((await run(["compile", planFile, "-o", bundleFile])).code).toBe(0);
    const before = await readFile(bundleFile, "utf8");
    const r = await run(["sign", bundleFile, "--keyless"]);
    expect(r.code).toBe(1);
    expect(json<{ code: string; details: { reason: string } }>(r)).toMatchObject({
      code: "ERR_KEYLESS_UNAVAILABLE",
      details: { reason: "NO_OIDC" },
    });
    expect(await readFile(bundleFile, "utf8")).toBe(before);
    // --bound without a trust-store rootId (and no --root-id) is a usage error.
    expect(
      (await run(["sign", bundleFile, "--keyless", "--bound", "--root", repo.root])).code,
    ).toBe(2);
    // Ed25519-only flags stay Ed25519-only.
    expect((await run(["sign", bundleFile, "--bound"])).code).toBe(2);
  });
});
