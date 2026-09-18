import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePlan, tmpRepo } from "./test-helpers.js";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const hasDist = existsSync(CLI);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd?: string): Promise<Run> {
  try {
    const opts =
      cwd === undefined ? { maxBuffer: 16 * 1024 * 1024 } : { cwd, maxBuffer: 16 * 1024 * 1024 };
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe.skipIf(!hasDist)("cli (dist/cli.js)", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-cli-");
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("--version prints the package version, exit 0", async () => {
    const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("no verb → help, exit 2; unknown verb → exit 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["--help"])).code).toBe(0);
  });

  it("dist/cli.js is self-contained: no workspace or npm imports remain", async () => {
    const text = await readFile(CLI, "utf8");
    const mainText = await readFile(join(here, "..", "dist", "cli-main.js"), "utf8");
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
    // ESM bundle: every statement-level import must be a node: builtin or a sibling chunk. (Strings
    // `require("ajv/...")` inside ajv's code generator are template text, not module requests.)
    for (const src of [text, mainText]) {
      const imports = [
        ...src.matchAll(/^import\b[^\n]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm),
      ]
        .map((m) => m[1] ?? m[2])
        .filter((s): s is string => s !== undefined);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("./"))).toEqual([]);
    }
    // The eager bundle must not statically pull sibling chunks (the .axm parser is `import()`-only).
    expect(mainText).not.toMatch(/^import\b[^\n]*?from\s+["']\.\//m);
    // Empirical: a copy of the bundle in a directory with no node_modules still runs.
    const alone = join(repo.root, "alone");
    await mkdir(join(alone, "dist"), { recursive: true });
    await writeFile(join(alone, "dist", "cli.js"), text);
    await writeFile(join(alone, "dist", "cli-main.js"), mainText);
    await writeFile(
      join(alone, "package.json"),
      JSON.stringify({ type: "module", version: "0.0.0-test" }),
    );
    const cwdOpt = { cwd: alone };
    const r = await execFileP(
      process.execPath,
      [join(alone, "dist", "cli.js"), "--version"],
      cwdOpt,
    );
    expect(r.stdout.trim()).toBe("0.0.0-test");
    const s = await execFileP(
      process.execPath,
      [join(alone, "dist", "cli.js"), "schema", "Plan"],
      cwdOpt,
    );
    expect((JSON.parse(s.stdout) as { title: string }).title).toBe("Plan");
  });

  it("compile → verify → check → apply --dry-run → apply --confirm → rollback → diff → schema", async () => {
    const planFile = join(repo.root, "plan.json");
    const bundleFile = join(repo.root, "bundle.json");
    await writeFile(
      planFile,
      JSON.stringify(makePlan({ "src/x.ts": "export {};\n" }, { name: "cli" })),
    );

    const c = await run(["compile", planFile, "-o", bundleFile]);
    expect(c.code, c.stderr).toBe(0);
    const { manifestDigest } = JSON.parse(c.stdout) as { manifestDigest: string };
    expect(manifestDigest).toMatch(/^sha256:/);

    expect((await run(["verify", bundleFile])).code).toBe(0);

    const chk = await run(["check", bundleFile, "--root", repo.root, "--json"]);
    expect(chk.code, chk.stderr).toBe(0);
    expect(JSON.parse(chk.stdout).verdict).toBe("pass");

    const dry = await run(["apply", bundleFile, "--root", repo.root, "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).mode).toBe("dry-run");
    await expect(stat(join(repo.root, "src", "x.ts"))).rejects.toThrow();

    const noConfirm = await run(["apply", bundleFile, "--root", repo.root]);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toContain("ERR_CONFIRM_DIGEST_MISMATCH");

    const ap = await run(["apply", bundleFile, "--root", repo.root, "--confirm", manifestDigest]);
    expect(ap.code, ap.stderr).toBe(0);
    expect(JSON.parse(ap.stdout).status).toBe("applied");
    expect(await readFile(join(repo.root, "src", "x.ts"), "utf8")).toBe("export {};\n");

    const rb = await run(["rollback", manifestDigest, "--root", repo.root]);
    expect(rb.code, rb.stderr).toBe(0);
    await expect(stat(join(repo.root, "src", "x.ts"))).rejects.toThrow();

    const d = await run(["diff", bundleFile, bundleFile]);
    expect(d.code).toBe(0);
    expect(JSON.parse(d.stdout)).toEqual({ added: [], removed: [], changed: [] });

    const s = await run(["schema", "Plan"]);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout).title).toBe("Plan");
    expect((await run(["schema", "Nope"])).code).toBe(2);
  });

  it("check exits 1 on a failing verdict", async () => {
    const planFile = join(repo.root, "plan.json");
    const bundleFile = join(repo.root, "bundle.json");
    await writeFile(
      planFile,
      JSON.stringify(
        makePlan({ ".env": "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEabcdefghijklmnopqrstu\n" }),
      ),
    );
    expect((await run(["compile", planFile, "-o", bundleFile])).code).toBe(0);
    const chk = await run(["check", bundleFile, "--root", repo.root]);
    expect(chk.code).toBe(1);
    expect(chk.stdout).toMatch(/^FAIL /);
  });

  it("compile accepts a .axm plan; diagnostics → JSON on stdout, exit 2", async () => {
    const axmFile = join(repo.root, "plan.axm");
    const bundleFile = join(repo.root, "bundle.json");
    await writeFile(
      axmFile,
      'axiom "2"\nplan cli-axm {\n  intent "x"\n  artifact "src/x.ts" {\n    inline <<EOF\nexport {};\n\nEOF\n  }\n}\n',
    );
    const c = await run(["compile", axmFile, "-o", bundleFile]);
    expect(c.code, c.stderr).toBe(0);
    const bundle = JSON.parse(await readFile(bundleFile, "utf8")) as {
      manifest: { name: string; artifacts: { path: string }[] };
    };
    expect(bundle.manifest.name).toBe("cli-axm");
    expect(bundle.manifest.artifacts.map((a) => a.path)).toEqual(["src/x.ts"]);

    await writeFile(axmFile, 'axiom "2"\nplan bad {\n  intent 42\n}\n');
    const bad = await run(["compile", axmFile]);
    expect(bad.code).toBe(2);
    const out = JSON.parse(bad.stdout) as {
      code: string;
      diagnostics: { range: { start: { line: number; column: number } } }[];
    };
    expect(out.code).toBe("ERR_INVALID_PLAN");
    expect(out.diagnostics[0]?.range.start).toEqual({ line: 3, column: 10 });
  });

  it("mcp verb over real stdio keeps stdout clean (framing survives tools/list + a call)", async () => {
    await mkdir(join(repo.root, "sub"), { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--root", repo.root, "--log-level", "debug"],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(10);
      const r = await client.callTool({ name: "axiom_roots_list", arguments: {} });
      expect((r.structuredContent as { roots: unknown[] }).roots).toHaveLength(1);
      const v = await client.callTool({
        name: "axiom_plan_validate",
        arguments: { plan: makePlan({ "a.txt": "a" }) },
      });
      expect((v.structuredContent as { ok: boolean }).ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});
