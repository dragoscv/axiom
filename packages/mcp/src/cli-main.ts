import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { apply, rollback } from "@codai/axiom-apply";
import { loadProfile, runChecks } from "@codai/axiom-checks";
import { compilePlan, diffManifests, verifyBundle } from "@codai/axiom-plan";
import { AxiomError, ManifestBundleSchema } from "@codai/axiom-schema";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isSchemaKind, jsonSchemaFor, SCHEMA_KINDS } from "./jsonschema.js";
import { createLogger, isLogLevel, LOG_LEVELS, type Logger } from "./log.js";
import { createRootsPolicy, resolveRoot } from "./roots.js";
import { createServer } from "./server.js";
import { saveManifest, saveReport, toDigestRef } from "./store.js";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const help = (version: string) => `axiom ${version} — transactional write gate for AI agents

Usage:
	axiom mcp [--root <abs>]... [--log-level ${LOG_LEVELS.join("|")}]
  axiom compile <plan.json|plan.axm> [-o <out.json>] [--store inline|cas] [--root <dir>]
	axiom verify <bundle.json>
	axiom check <bundle.json> --root <dir> [--profile <name>] [--json]
	axiom apply <bundle.json> --root <dir> [--dry-run] [--profile <name>] [--confirm <digest>]
	axiom rollback <digest> --root <dir>
	axiom diff <a.json> <b.json>
	axiom schema <${SCHEMA_KINDS.join("|")}>
	axiom --version | --help

Exit codes: 0 ok · 1 verdict fail / apply failed · 2 usage or error.
The \`mcp\` verb speaks JSON-RPC on stdout and logs JSON lines on stderr; every other verb prints JSON to stdout.
A \`.axm\` plan with errors prints its diagnostics as JSON and exits 2.
`;

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(path.resolve(file), "utf8");
  return JSON.parse(text) as unknown;
}

class AxmDiagnosticsError extends Error {
  readonly diagnostics: unknown[];
  constructor(diagnostics: unknown[]) {
    super("axm: source has errors");
    this.diagnostics = diagnostics;
  }
}

async function readPlan(file: string): Promise<unknown> {
  if (path.extname(file).toLowerCase() !== ".axm") return readJson(file);
  const text = await readFile(path.resolve(file), "utf8");
  const { parseAxm } = await import("./axm-lazy.js");
  const r = parseAxm(text);
  if (r.plan === undefined) throw new AxmDiagnosticsError(r.diagnostics);
  return r.plan;
}

function parseBundleFile(raw: unknown) {
  const parsed = ManifestBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_MANIFEST", "bundle does not match ManifestBundleSchema", {
      details: {
        issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

function opts<
  const T extends Record<
    string,
    { type: "string" | "boolean"; short?: string; multiple?: boolean }
  >,
>(argv: string[], options: T) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

async function realRootArg(root: string | undefined): Promise<string> {
  if (root === undefined) throw new UsageError("--root <dir> is required");
  const policy = await createRootsPolicy([path.resolve(root)]);
  return (await resolveRoot(policy)).rootReal;
}

class UsageError extends Error {}

async function cmdMcp(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string", multiple: true },
    "log-level": { type: "string" },
  });
  const level = values["log-level"] ?? "warn";
  if (!isLogLevel(level))
    throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join("|")}`);
  const log: Logger = createLogger({ level });
  const rootArgs = (values.root ?? []).map((r) => path.resolve(r));
  const policy = await createRootsPolicy(rootArgs);
  if (policy.roots.size === 0)
    log.warn("no --root given; every root-taking tool will fail with ERR_ROOT_REQUIRED");
  const server = createServer(policy, { log });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("mcp stdio ready", { roots: [...policy.roots] });
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
  return EXIT_OK;
}

async function cmdCompile(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    out: { type: "string", short: "o" },
    store: { type: "string" },
    root: { type: "string" },
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("compile: <plan.json|plan.axm> is required");
  const store = values.store ?? "inline";
  if (store !== "inline" && store !== "cas") throw new UsageError("--store must be inline|cas");
  const compileOpts: Parameters<typeof compilePlan>[1] = { store };
  let rootReal: string | undefined;
  if (values.root !== undefined || store === "cas") {
    rootReal = await realRootArg(values.root ?? ".");
    compileOpts.root = rootReal;
  }
  const { bundle } = await compilePlan(await readPlan(file), compileOpts);
  if (rootReal !== undefined) await saveManifest(rootReal, bundle);
  if (values.out !== undefined) {
    await writeFile(path.resolve(values.out), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    out({
      manifestDigest: bundle.manifestDigest,
      artifacts: bundle.manifest.artifacts.length,
      out: values.out,
    });
  } else {
    out(bundle);
  }
  return EXIT_OK;
}

async function cmdVerify(argv: string[]): Promise<number> {
  const { positionals } = opts(argv, {});
  const file = positionals[0];
  if (file === undefined) throw new UsageError("verify: <bundle.json> is required");
  const r = verifyBundle(await readJson(file));
  out(r);
  return r.ok ? EXIT_OK : EXIT_FAIL;
}

async function loadProfileFor(rootReal: string, name: string) {
  return loadProfile(name, { searchDirs: [path.join(rootReal, ".axiom", "profiles")] });
}

async function cmdCheck(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    root: { type: "string" },
    profile: { type: "string" },
    json: { type: "boolean" },
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("check: <bundle.json> is required");
  const rootReal = await realRootArg(values.root);
  const bundle = parseBundleFile(await readJson(file));
  const profile = await loadProfileFor(rootReal, values.profile ?? bundle.manifest.profile);
  const report = await runChecks({
    bundle,
    profile,
    checks: bundle.manifest.checks,
    root: rootReal,
    casDir: path.join(rootReal, ".axiom", "cas"),
  });
  await saveReport(rootReal, report);
  if (values.json) {
    out(report);
  } else {
    console.log(
      `${report.verdict.toUpperCase()} ${report.manifestDigest} (${report.profile}, ${report.durationMs} ms)`,
    );
    for (const f of report.findings) {
      console.log(
        `  ${f.severity.padEnd(5)} ${f.id}${f.path === undefined ? "" : ` ${f.path}`}: ${f.message}`,
      );
    }
  }
  return report.verdict === "pass" ? EXIT_OK : EXIT_FAIL;
}

async function cmdApply(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    root: { type: "string" },
    profile: { type: "string" },
    confirm: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("apply: <bundle.json> is required");
  const rootReal = await realRootArg(values.root);
  const bundle = parseBundleFile(await readJson(file));
  const dryRun = values["dry-run"] === true;
  if (!dryRun && values.confirm !== bundle.manifestDigest) {
    throw new AxiomError(
      "ERR_CONFIRM_DIGEST_MISMATCH",
      "--confirm <digest> must equal bundle.manifestDigest",
      {
        details: { confirm: values.confirm ?? null, manifestDigest: bundle.manifestDigest },
      },
    );
  }
  const profile = await loadProfileFor(rootReal, values.profile ?? bundle.manifest.profile);
  const applyOpts: Parameters<typeof apply>[0] = {
    bundle,
    root: rootReal,
    mode: dryRun ? "dry-run" : "fs",
    preChecks: async () => {
      const report = await runChecks({
        bundle,
        profile,
        checks: bundle.manifest.checks,
        root: rootReal,
        casDir: path.join(rootReal, ".axiom", "cas"),
      });
      await saveReport(rootReal, report);
      return report;
    },
  };
  if (!dryRun && values.confirm !== undefined) applyOpts.confirmDigest = values.confirm;
  const result = await apply(applyOpts);
  if (result.status === "applied" || result.status === "noop") await saveManifest(rootReal, bundle);
  out(result);
  return result.status === "failed" || result.status === "rolled-back" ? EXIT_FAIL : EXIT_OK;
}

async function cmdRollback(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { root: { type: "string" } });
  const digest = positionals[0];
  if (digest === undefined) throw new UsageError("rollback: <digest> is required");
  const rootReal = await realRootArg(values.root);
  const journal = await rollback(rootReal, toDigestRef(digest));
  out(journal);
  return EXIT_OK;
}

async function cmdDiff(argv: string[]): Promise<number> {
  const { positionals } = opts(argv, {});
  const [a, b] = positionals;
  if (a === undefined || b === undefined)
    throw new UsageError("diff: <a.json> <b.json> are required");
  const [ba, bb] = await Promise.all([readJson(a), readJson(b)]);
  out(diffManifests(parseBundleFile(ba).manifest, parseBundleFile(bb).manifest));
  return EXIT_OK;
}

async function cmdSchema(argv: string[]): Promise<number> {
  const { positionals } = opts(argv, {});
  const kind = positionals[0];
  if (!isSchemaKind(kind))
    throw new UsageError(`schema: kind must be one of ${SCHEMA_KINDS.join("|")}`);
  out(jsonSchemaFor(kind));
  return EXIT_OK;
}

const VERBS: Record<string, (argv: string[]) => Promise<number>> = {
  mcp: cmdMcp,
  compile: cmdCompile,
  verify: cmdVerify,
  check: cmdCheck,
  apply: cmdApply,
  rollback: cmdRollback,
  diff: cmdDiff,
  schema: cmdSchema,
};

export async function main(argv: readonly string[], version: string): Promise<number> {
  const HELP = help(version);
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(HELP);
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (verb === "--version" || verb === "-v") {
    console.log(version);
    return EXIT_OK;
  }
  const run = VERBS[verb];
  if (run === undefined) {
    console.error(`unknown verb: ${verb}\n\n${HELP}`);
    return EXIT_USAGE;
  }
  try {
    return await run(rest);
  } catch (err) {
    if (err instanceof AxmDiagnosticsError) {
      out({ code: "ERR_INVALID_PLAN", diagnostics: err.diagnostics });
      return EXIT_USAGE;
    }
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n\n${HELP}`);
      return EXIT_USAGE;
    }
    if (err instanceof AxiomError) {
      console.error(JSON.stringify(err.toJSON()));
      return EXIT_USAGE;
    }
    if (err instanceof Error && (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`error: ${err.message}\n\n${HELP}`);
      return EXIT_USAGE;
    }
    console.error(
      JSON.stringify({
        code: "ERR_INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return EXIT_USAGE;
  }
}
