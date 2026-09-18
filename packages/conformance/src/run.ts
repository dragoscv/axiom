/**
 * Conformance harness (v2-architecture §7): start `axiom mcp --http 127.0.0.1:0 --root <tmp>`
 * from the BUILT `packages/mcp/dist/cli.js`, wait for the `http listening` stderr JSON line,
 * run `@modelcontextprotocol/conformance server --url <url> --expected-failures baseline.yml`
 * (resolved from node_modules — no npx, no network beyond loopback), collect its `checks.json`
 * files, and report. Exit 0 only when every failure is baselined and every baselined check
 * still fails (the CLI enforces stale entries itself).
 *
 * Usage: `pnpm --filter @codai/axiom-conformance conformance [--out <dir>] [--suite active|all|pending]`
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const PKG_ROOT: string = resolve(here, "..");
export const BASELINE: string = join(PKG_ROOT, "baseline.yml");
export const MCP_CLI: string = resolve(PKG_ROOT, "..", "mcp", "dist", "cli.js");

/** `dist/index.js` of the installed conformance CLI (its `bin`). */
export function conformanceBin(): string {
  const pkgJson = require.resolve("@modelcontextprotocol/conformance/package.json");
  const pkg = require(pkgJson) as { bin: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.conformance ?? "dist/index.js");
  return join(dirname(pkgJson), rel);
}

export interface ServerHandle {
  url: string;
  root: string;
  stderr: string[];
  stop(): Promise<void>;
}

/** Spawn the built CLI over HTTP on a random loopback port; resolve once it logs its URL. */
export async function startServer(
  opts: { cli?: string; timeoutMs?: number } = {},
): Promise<ServerHandle> {
  const cli = opts.cli ?? MCP_CLI;
  const root = await mkdtemp(join(tmpdir(), "axiom-conformance-"));
  const child = spawn(
    process.execPath,
    [cli, "mcp", "--root", root, "--http", "127.0.0.1:0", "--log-level", "info"],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const stderr: string[] = [];
  const url = await new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not log "http listening" in time\n${stderr.join("\n")}`)),
      opts.timeoutMs ?? 20_000,
    );
    let buf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        stderr.push(line);
        try {
          const j = JSON.parse(line) as { msg?: string; url?: string };
          if (j.msg === "http listening" && typeof j.url === "string") {
            clearTimeout(timer);
            resolvePromise(j.url);
          }
        } catch {
          // non-JSON stderr noise is kept for diagnostics only
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stderr.join("\n")}`));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return {
    url,
    root,
    stderr,
    stop: async () => {
      await killTree(child);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    // stdin end is the CLI's graceful stop signal (SIGINT/SIGTERM are not delivered on Windows).
    child.stdin?.end();
    const t = setTimeout(() => child.kill(), 3_000);
    child.once("exit", () => clearTimeout(t));
  });
}

export interface Check {
  id: string;
  status: "SUCCESS" | "FAILURE" | "WARNING" | "INFO" | "SKIPPED" | string;
  errorMessage?: string;
}

export interface ScenarioResult {
  scenario: string;
  checks: Check[];
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  scenarios: ScenarioResult[];
  /** From the CLI's `Total: N passed, M failed` line. */
  passed: number;
  failed: number;
  /** Scenarios that failed AND are listed in the baseline. */
  expectedFailures: string[];
  /** Failures not in the baseline (a regression) — computed here as a cross-check of the CLI exit code. */
  unexpectedFailures: string[];
}

/** Minimal parser for the baseline's `server:` list (`- name` / `- name:check-id` / `# comment`). */
export function parseBaseline(yaml: string): string[] {
  const out: string[] = [];
  let inServer = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      inServer = line === "server:";
      continue;
    }
    const m = /^\s*-\s+(\S+)\s*$/.exec(line);
    if (inServer && m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

export interface RunOptions {
  url: string;
  outDir: string;
  baseline?: string;
  suite?: "active" | "all" | "pending";
  timeoutMs?: number;
}

export async function runConformance(opts: RunOptions): Promise<RunResult> {
  const baselineFile = opts.baseline ?? BASELINE;
  const args = [
    conformanceBin(),
    "server",
    "--url",
    opts.url,
    "--expected-failures",
    baselineFile,
    "--output-dir",
    opts.outDir,
    "--suite",
    opts.suite ?? "active",
  ];
  const { code, stdout, stderr } = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let so = "";
    let se = "";
    child.stdout.on("data", (c: Buffer) => {
      so += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      se += c.toString("utf8");
    });
    const t = setTimeout(() => {
      child.kill();
      reject(new Error("conformance CLI timed out"));
    }, opts.timeoutMs ?? 240_000);
    child.once("error", reject);
    child.once("exit", (c) => {
      clearTimeout(t);
      resolvePromise({ code: c ?? 1, stdout: so, stderr: se });
    });
  });

  const scenarios = await collectChecks(opts.outDir);
  const total = /Total:\s+(\d+)\s+passed,\s+(\d+)\s+failed/.exec(stdout);
  const baseline = new Set(parseBaseline(await readFile(baselineFile, "utf8")));
  const failing = scenarios
    .filter((s) => s.checks.some((c) => c.status === "FAILURE"))
    .map((s) => s.scenario);
  const isBaselined = (s: ScenarioResult) =>
    baseline.has(s.scenario) ||
    s.checks
      .filter((c) => c.status === "FAILURE")
      .every((c) => baseline.has(`${s.scenario}:${c.id}`));
  return {
    exitCode: code,
    stdout,
    stderr,
    scenarios,
    passed: Number(total?.[1] ?? 0),
    failed: Number(total?.[2] ?? failing.length),
    expectedFailures: failing.filter((n) =>
      isBaselined(scenarios.find((s) => s.scenario === n) as ScenarioResult),
    ),
    unexpectedFailures: failing.filter(
      (n) => !isBaselined(scenarios.find((s) => s.scenario === n) as ScenarioResult),
    ),
  };
}

/** `<outDir>/server-<scenario>-<timestamp>/checks.json` → per-scenario checks. */
export async function collectChecks(outDir: string): Promise<ScenarioResult[]> {
  const dirs = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const out: ScenarioResult[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const m = /^server-(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z$/.exec(d.name);
    if (m?.[1] === undefined) continue;
    const text = await readFile(join(outDir, d.name, "checks.json"), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    out.push({ scenario: m[1], checks: JSON.parse(text) as Check[] });
  }
  return out.sort((a, b) => a.scenario.localeCompare(b.scenario));
}

export function summarize(r: RunResult): string {
  const lines = [
    `conformance: ${r.passed} passed, ${r.failed} failed ` +
      `(${r.expectedFailures.length} expected, ${r.unexpectedFailures.length} unexpected), cli exit ${r.exitCode}`,
  ];
  for (const s of r.scenarios) {
    for (const c of s.checks) {
      if (c.status === "FAILURE") {
        const tag = r.unexpectedFailures.includes(s.scenario) ? "UNEXPECTED" : "expected";
        lines.push(`  ✗ ${s.scenario}:${c.id} [${tag}] ${c.errorMessage ?? ""}`.trimEnd());
      }
    }
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, suite: { type: "string" } },
    strict: true,
  });
  const suite = values.suite ?? "active";
  if (suite !== "active" && suite !== "all" && suite !== "pending") {
    console.error("--suite must be active|all|pending");
    return 2;
  }
  const outDir = resolve(values.out ?? join(PKG_ROOT, "results"));
  await rm(outDir, { recursive: true, force: true });
  const server = await startServer();
  try {
    const r = await runConformance({ url: server.url, outDir, suite });
    console.error(summarize(r));
    console.error(`report: ${outDir}`);
    return r.exitCode;
  } finally {
    await server.stop();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
