import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { apply, readHistory, rollback, verifyChain } from "@codai/axiom-apply";
import { AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE } from "@codai/axiom-canon";
import {
  type GuardOptions,
  KEYLESS_BUNDLE_FIELD,
  keylessPayload,
  loadProfile,
  runChecks,
  signManifestKeyless,
} from "@codai/axiom-checks";
import { compilePlan, diffManifests, isYamlPath, verifyBundle } from "@codai/axiom-plan";
import {
  AxiomError,
  isAxiomError,
  ManifestBundleSchema,
  RepoSnapshotSchema,
} from "@codai/axiom-schema";
import {
  checkOptions,
  commandName,
  findGroup,
  flagsOf,
  groupCommands,
  oneLineUsage,
  renderCommandHelp,
  renderGroupHelp,
  renderOverview,
  resolveCommand,
  suggest,
  topLevelCandidates,
  wantsHelp,
} from "./cli-commands.js";
import { emitterCatalogue, loadEmitters, withEmitterHint } from "./emitters.js";
import type { GcOptions } from "./gc.js";
import { isSchemaKind, jsonSchemaFor, SCHEMA_KINDS } from "./jsonschema.js";
import {
  advanceTrustState,
  keygen,
  loadTrustStore,
  parsePublicEntry,
  profileWantsAntiRollback,
  signBundle,
  trustAdd,
  trustRemove,
  trustSetRootId,
  verifyBundleAgainstRoot,
} from "./keys.js";
import { createLogger, isLogLevel, LOG_LEVELS, type Logger } from "./log.js";
import { createRootsPolicy, resolveRoot } from "./roots.js";
import { diffSnapshots, snapshotRoot } from "./snapshot.js";
import { collectStatus, renderStatus } from "./status.js";
import { saveManifest, saveReport, toDigestRef } from "./store.js";
import { TaskStore } from "./tasks.js";
import { parseToolset, type Toolset } from "./toolset.js";
import { isWireMode, WIRE_MODES, type WireMode } from "./wire.js";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function readJson(file: string): Promise<unknown> {
  const text = await readInput(file);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AxiomError("ERR_INVALID_PLAN", `${file}: not valid JSON`, {
      details: { path: path.resolve(file), format: "json", ...jsonErrorPosition(text, err) },
    });
  }
}

/** A user-named input file; absent -> ERR_NOT_FOUND with details.path (never ERR_INTERNAL). */
async function readInput(file: string): Promise<string> {
  const abs = path.resolve(file);
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new AxiomError("ERR_NOT_FOUND", `input file not found: ${file}`, {
        details: { path: abs },
      });
    if (code === "EISDIR")
      throw new AxiomError("ERR_TARGET_TYPE", `expected a file, found a directory: ${file}`, {
        details: { path: abs },
      });
    throw err;
  }
}

/**
 * 1-based line/column of a JSON.parse failure. Current V8 messages carry no position
 * ("Unexpected token 'P', ..."), so the offset comes from a minimal grammar scan.
 */
function jsonErrorPosition(
  text: string,
  err: unknown,
): { line?: number; column?: number; reason: string } {
  const reason = err instanceof Error ? err.message : String(err);
  const at = jsonErrorOffset(text);
  if (at === undefined) return { reason };
  const before = text.slice(0, at);
  return { line: before.split("\n").length, column: at - before.lastIndexOf("\n"), reason };
}

/** Offset of the first JSON syntax error in `text`, or undefined when it scans clean. */
function jsonErrorOffset(text: string): number | undefined {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const lit = (word: string) => {
    for (const ch of word) {
      if (text[i] !== ch) fail();
      i++;
    }
  };
  const str = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text.charCodeAt(i) < 0x20) fail();
      i += text[i] === "\\" ? 2 : 1;
    }
    if (text[i] !== '"') fail();
    i++;
  };
  const num = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (m === null) fail();
    i += (m as RegExpExecArray)[0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        str();
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return;
        } else fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') str();
    else if (c === "t") lit("true");
    else if (c === "f") lit("false");
    else if (c === "n") lit("null");
    else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) num();
    else fail();
  };
  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    value();
    ws();
    return i < text.length ? i : undefined;
  } catch (at) {
    return typeof at === "number" ? Math.min(at, text.length) : undefined;
  }
}

class AxmDiagnosticsError extends Error {
  readonly diagnostics: unknown[];
  constructor(diagnostics: unknown[]) {
    super("axm: source has errors");
    this.diagnostics = diagnostics;
  }
}

async function readPlan(file: string): Promise<unknown> {
  if (isYamlPath(file)) {
    const text = await readInput(file);
    const { parsePlanYaml } = await import("./yaml-lazy.js");
    return parsePlanYaml(text);
  }
  if (path.extname(file).toLowerCase() !== ".axm") return readJson(file);
  const text = await readInput(file);
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

const GUARD_FLAGS = {
  "allow-guards": { type: "boolean" },
  "guard-allowlist": { type: "string", multiple: true },
} as const;

function guardOptions(values: {
  "allow-guards"?: boolean;
  "guard-allowlist"?: string[];
}): GuardOptions {
  const allowlist = (values["guard-allowlist"] ?? []).map((p) => {
    if (!path.isAbsolute(p)) throw new UsageError(`--guard-allowlist must be absolute: ${p}`);
    return path.resolve(p);
  });
  return { allowGuards: values["allow-guards"] === true, guardAllowlist: allowlist };
}

export async function cmdMcp(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string", multiple: true },
    "log-level": { type: "string" },
    http: { type: "string" },
    "http-token-env": { type: "string" },
    wire: { type: "string" },
    "require-human": { type: "boolean" },
    tools: { type: "string" },
    emitter: { type: "string", multiple: true },
    ...GUARD_FLAGS,
  });
  const level = values["log-level"] ?? "warn";
  if (!isLogLevel(level))
    throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join("|")}`);
  let toolset: Toolset;
  try {
    toolset = parseToolset(values.tools);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  // D-19: 2026-07-28 is the default wire; `2025` keeps serving legacy clients from the same
  // entry (the SDK pins the era per connection), `2026-only` refuses them.
  const { serveStdio, serverFactory } = await import("./mcp-lazy.js");
  const wireArg = values.wire ?? "2026";
  if (!isWireMode(wireArg)) throw new UsageError(`--wire must be one of ${WIRE_MODES.join("|")}`);
  const wire: WireMode = wireArg;
  const log: Logger = createLogger({ level });
  const rootArgs = (values.root ?? []).map((r) => path.resolve(r));
  const policy = await createRootsPolicy(rootArgs);
  if (policy.roots.size === 0)
    log.warn("no --root given; every root-taking tool will fail with ERR_ROOT_REQUIRED");
  const guards = guardOptions(values);
  if (guards.allowGuards)
    log.warn("external guards ENABLED (--allow-guards)", { allowlist: guards.guardAllowlist });
  // One task store per process: a stop (stdin end / signal) kills every guard tree still running
  // so no orphaned children survive the server (S-406).
  const tasks = new TaskStore();
  const requireHuman = values["require-human"] === true;
  const emitterSpecs = values.emitter ?? [];
  const emitters =
    emitterSpecs.length === 0
      ? undefined
      : await withEmitterHint(loadEmitters(emitterSpecs, process.cwd()));
  const factory = serverFactory(policy, {
    log,
    guards,
    tasks,
    toolset,
    ...(emitters === undefined ? {} : { emitters }),
    ...(requireHuman ? { requireHuman } : {}),
  });
  if (values.http !== undefined) {
    const { parseHostPort, startHttp, HTTP_TOKEN_ENV_DEFAULT } = await import("./http-lazy.js");
    const { host, port } = parseHostPort(values.http);
    const tokenEnv = values["http-token-env"] ?? HTTP_TOKEN_ENV_DEFAULT;
    const token = process.env[tokenEnv];
    const httpOpts: Parameters<typeof startHttp>[1] = { host, port, log, wire };
    if (token !== undefined && token.length > 0) httpOpts.token = token;
    const handle = await startHttp(factory, httpOpts);
    await new Promise<void>((resolve) => {
      const stop = () => {
        tasks.abortAll();
        void handle.close().then(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stdin.on("end", stop);
      process.stdin.resume();
    });
    return EXIT_OK;
  }
  const handle = serveStdio(factory, wire, (err) =>
    log.warn("stdio transport error", { error: err.message }),
  );
  log.info("mcp stdio ready", { wire, roots: [...policy.roots] });
  await new Promise<void>((resolve) => {
    const stop = () => {
      tasks.abortAll();
      void handle.close().then(resolve, resolve);
    };
    process.stdin.once("end", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT_OK;
}

export async function cmdCompile(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    out: { type: "string", short: "o" },
    store: { type: "string" },
    root: { type: "string" },
    "allow-net": { type: "boolean" },
    "net-allow": { type: "string", multiple: true },
    "allow-file": { type: "boolean" },
    emitter: { type: "string", multiple: true },
  });
  const file = positionals[0];
  if (file === undefined)
    throw new UsageError("compile: <plan.json|plan.yaml|plan.axm> is required");
  const store = values.store ?? "inline";
  if (store !== "inline" && store !== "cas") throw new UsageError("--store must be inline|cas");
  const allowNet = values["allow-net"] === true;
  const allowlist = (values["net-allow"] ?? [])
    .flatMap((s) => s.split(","))
    .filter((s) => s !== "");
  if (!allowNet && allowlist.length > 0) throw new UsageError("--net-allow requires --allow-net");
  const net: NonNullable<Parameters<typeof compilePlan>[1]>["net"] = { allowNet };
  if (allowlist.length > 0) net.allowlist = allowlist;
  if (values["allow-file"] === true) net.allowFile = true;
  let rootReal: string | undefined;
  if (values.root !== undefined || store === "cas" || allowNet || net.allowFile === true) {
    rootReal = await realRootArg(values.root ?? ".");
  }
  const emitters = await withEmitterHint(
    loadEmitters(values.emitter ?? [], rootReal ?? process.cwd()),
  );
  const compileOpts: Parameters<typeof compilePlan>[1] = { store, emitters, net };
  if (rootReal !== undefined) compileOpts.root = rootReal;
  const { bundle } = await withEmitterHint(compilePlan(await readPlan(file), compileOpts));
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

export async function cmdVerify(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    root: { type: "string" },
    tree: { type: "string" },
    pre: { type: "boolean" },
    attest: { type: "string" },
    journal: { type: "boolean" },
  });
  if (values.journal === true) {
    if (positionals.length > 0 || values.tree !== undefined || values.attest !== undefined)
      throw new UsageError("verify --journal takes only --root <dir>");
    return cmdVerifyJournal(await realRootArg(values.root));
  }
  const file = positionals[0];
  if (file === undefined) throw new UsageError("verify: <bundle.json> is required");
  const raw = await readJson(file);
  if (values.tree !== undefined)
    return cmdVerifyTree(raw, values.tree, values.pre === true, values.attest);
  if (values.attest !== undefined) throw new UsageError("verify: --attest requires --tree <dir>");
  const r = verifyBundle(raw);
  if (values.root === undefined || !r.ok) {
    out(r);
    return r.ok ? EXIT_OK : EXIT_FAIL;
  }
  const rootReal = await realRootArg(values.root);
  const sig = await verifyBundleAgainstRoot(rootReal, parseBundleFile(raw));
  if (sig === undefined) {
    out({ ...r, signatures: null, note: "no .axiom/trust/keys.json under root" });
    return EXIT_OK;
  }
  out({ ...r, signed: sig.keyids.length > 0, signatures: sig });
  return sig.ok ? EXIT_OK : EXIT_FAIL;
}

/** `axiom verify --journal --root <dir>` (S-706): the journal hash chain. */
async function cmdVerifyJournal(rootReal: string): Promise<number> {
  const r = await verifyChain(rootReal);
  if (r.ok) {
    out(r);
    return EXIT_OK;
  }
  out({ ...r, code: "ERR_JOURNAL_CHAIN" });
  return EXIT_FAIL;
}

/** `axiom verify <bundle> --tree <root> [--pre] [--attest <out>]` (S-403, D-20/D-21). */
async function cmdVerifyTree(
  raw: unknown,
  treeRoot: string,
  pre: boolean,
  attestOut: string | undefined,
): Promise<number> {
  // Structural verification first: a tree cannot match a bundle that is not self-consistent.
  const structural = verifyBundle(raw);
  if (!structural.ok) {
    out({
      ...structural,
      tree: null,
      note: "bundle failed structural verification; tree not checked",
    });
    return EXIT_FAIL;
  }
  const bundle = parseBundleFile(raw);
  const { verifyTreeCli } = await import("./verify-tree-lazy.js");
  const { ok, result } = await verifyTreeCli(
    bundle,
    treeRoot,
    pre,
    attestOut,
    structural.canonical,
    process.env,
  );
  out(result);
  return ok ? EXIT_OK : EXIT_FAIL;
}

async function loadProfileFor(rootReal: string, name: string) {
  return loadProfile(name, { searchDirs: [path.join(rootReal, ".axiom", "profiles")] });
}

export async function cmdCheck(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    root: { type: "string" },
    profile: { type: "string" },
    json: { type: "boolean" },
    format: { type: "string" },
    ...GUARD_FLAGS,
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("check: <bundle.json> is required");
  const format = values.format ?? (values.json === true ? "json" : "text");
  if (format !== "text" && format !== "json" && format !== "sarif")
    throw new UsageError("--format must be text|json|sarif");
  const rootReal = await realRootArg(values.root);
  const bundle = parseBundleFile(await readJson(file));
  const profile = await loadProfileFor(rootReal, values.profile ?? bundle.manifest.profile);
  const report = await runChecks({
    bundle,
    profile,
    checks: bundle.manifest.checks,
    root: rootReal,
    casDir: path.join(rootReal, ".axiom", "cas"),
    ...guardOptions(values),
  });
  await saveReport(rootReal, report);
  if (format === "sarif") {
    const { reportToSarif } = await import("./ops-lazy.js");
    out(
      reportToSarif(report, {
        toolVersion: MIGRATE_VERSION,
        root: rootReal,
        bundlePath: path.resolve(file),
      }),
    );
  } else if (format === "json") {
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

export async function cmdApply(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    root: { type: "string" },
    profile: { type: "string" },
    confirm: { type: "string" },
    "dry-run": { type: "boolean" },
    pr: { type: "boolean" },
    branch: { type: "string" },
    message: { type: "string" },
    "lock-timeout": { type: "string" },
    "keep-backups": { type: "string" },
    ...GUARD_FLAGS,
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("apply: <bundle.json> is required");
  const lockTimeoutMs = intFlag(values["lock-timeout"], "--lock-timeout", 0, LOCK_TIMEOUT_MAX_MS);
  const keepBackups = intFlag(values["keep-backups"], "--keep-backups", 0, KEEP_BACKUPS_MAX);
  const rootReal = await realRootArg(values.root);
  const bundle = parseBundleFile(await readJson(file));
  const dryRun = values["dry-run"] === true;
  if (!dryRun && values.confirm === undefined) {
    throw new AxiomError(
      "ERR_CONFIRM_DIGEST_MISMATCH",
      `apply needs --confirm <digest>: run 'axiom plan apply ${file} --root <dir> --dry-run' first and pass its manifestDigest`,
      { details: { confirm: null, manifestDigest: bundle.manifestDigest } },
    );
  }
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
  const guards = guardOptions(values);
  const applyOpts: Parameters<typeof apply>[0] = {
    bundle,
    root: rootReal,
    mode: dryRun ? "dry-run" : values.pr === true ? "pr" : "fs",
    preChecks: async () => {
      const report = await runChecks({
        bundle,
        profile,
        checks: bundle.manifest.checks,
        root: rootReal,
        casDir: path.join(rootReal, ".axiom", "cas"),
        ...guards,
      });
      await saveReport(rootReal, report);
      return report;
    },
  };
  if (!dryRun && values.confirm !== undefined) applyOpts.confirmDigest = values.confirm;
  if (values.branch !== undefined) applyOpts.branch = values.branch;
  if (values.message !== undefined) applyOpts.commitMessage = values.message;
  if (lockTimeoutMs !== undefined) applyOpts.lockTimeoutMs = lockTimeoutMs;
  if (keepBackups !== undefined) applyOpts.keepBackups = keepBackups;
  const result = await apply(applyOpts);
  if (result.status === "applied" || result.status === "noop") await saveManifest(rootReal, bundle);
  if (
    result.status === "applied" &&
    !dryRun &&
    profileWantsAntiRollback([...profile.checks, ...bundle.manifest.checks])
  ) {
    await advanceTrustState(rootReal, bundle);
  }
  out(result);
  return result.status === "failed" || result.status === "rolled-back" ? EXIT_FAIL : EXIT_OK;
}

/** Same bounds as the `axiom_apply` MCP input (tools.ts). */
const LOCK_TIMEOUT_MAX_MS = 600_000;
const KEEP_BACKUPS_MAX = 1000;

function intFlag(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new UsageError(`${flag} must be an integer in ${min}..${max}`);
  return n;
}

export async function cmdRollback(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { root: { type: "string" } });
  const digest = positionals[0];
  if (digest === undefined) throw new UsageError("rollback: <digest> is required");
  const rootReal = await realRootArg(values.root);
  const journal = await rollback(rootReal, toDigestRef(digest));
  out(journal);
  return EXIT_OK;
}

export async function cmdGc(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string" },
    "dry-run": { type: "boolean" },
    "older-than": { type: "string" },
    keep: { type: "string" },
    "undo-ttl": { type: "string" },
    "decisions-older-than": { type: "string" },
  });
  const rootReal = await realRootArg(values.root);
  const keep = values.keep ?? "all-manifests";
  if (keep !== "all-manifests" && keep !== "journal") {
    throw new UsageError("--keep must be all-manifests|journal");
  }
  const gcOpts: GcOptions = { keep, dryRun: values["dry-run"] === true };
  // CLI-only and rare, like `migrate`: loaded on demand to keep the eager bundle small.
  const { collectGarbage, parseDuration } = await import("./gc-lazy.js");
  if (values["older-than"] !== undefined) {
    const ms = parseDuration(values["older-than"]);
    if (ms === undefined) throw new UsageError("--older-than must be <n>(ms|s|m|h|d)");
    gcOpts.olderThanMs = ms;
  }
  if (values["undo-ttl"] !== undefined) {
    const ms = parseDuration(values["undo-ttl"]);
    if (ms === undefined) throw new UsageError("--undo-ttl must be <n>(ms|s|m|h|d)");
    gcOpts.undoTtlMs = ms;
  }
  if (values["decisions-older-than"] !== undefined) {
    const days = Number(values["decisions-older-than"]);
    if (!Number.isInteger(days) || days < 1)
      throw new UsageError("--decisions-older-than must be a whole number of days >= 1");
    gcOpts.decisionsOlderThanDays = days;
  }
  out(await collectGarbage(rootReal, gcOpts));
  return EXIT_OK;
}

/** Console-backed io for the 3.0 command modules (this file may write stdout). */
const cliIo = {
  stdout: (s: string) => console.log(s),
  stderr: (s: string) => console.error(s),
};

export async function cmdExplain(argv: string[]): Promise<number> {
  return (await import("./v3-lazy.js")).explainMain(argv, cliIo);
}

export async function cmdSuggestProfile(argv: string[]): Promise<number> {
  return (await import("./v3-lazy.js")).suggestMain(argv, cliIo);
}

export async function cmdReplay(argv: string[]): Promise<number> {
  return (await import("./v3-lazy.js")).replayMain(argv, cliIo);
}

export async function cmdReport(argv: string[]): Promise<number> {
  return (await import("./v3-lazy.js")).reportMain(argv, cliIo);
}

export async function cmdPin(argv: string[]): Promise<number> {
  return (await import("./v3-lazy.js")).pinMain(argv, cliIo);
}

export async function cmdAcpProxy(argv: string[]): Promise<number> {
  const dd = argv.indexOf("--");
  if (dd === -1) throw new UsageError("acp-proxy: the agent command goes after --");
  const { values } = opts(argv.slice(0, dd), { root: { type: "string" } });
  const root = await realRootArg(values.root);
  const { runAcpProxyWithAgent } = await import("./v3-lazy.js");
  return runAcpProxyWithAgent(argv.slice(dd + 1), {
    clientIn: process.stdin,
    clientOut: process.stdout,
    root,
    onDeny: (d) => console.error(`AXIOM ACP DENY ${d.code ?? ""}: ${d.reason ?? "denied"}`),
  });
}

export async function cmdDiff(argv: string[]): Promise<number> {
  const { positionals } = opts(argv, {});
  const [a, b] = positionals;
  if (a === undefined || b === undefined)
    throw new UsageError("diff: <a.json> <b.json> are required");
  const [ba, bb] = await Promise.all([readJson(a), readJson(b)]);
  out(diffManifests(parseBundleFile(ba).manifest, parseBundleFile(bb).manifest));
  return EXIT_OK;
}

export async function cmdSchema(argv: string[]): Promise<number> {
  const { positionals } = opts(argv, {});
  const kind = positionals[0];
  if (!isSchemaKind(kind))
    throw new UsageError(`schema: kind must be one of ${SCHEMA_KINDS.join("|")}`);
  out(jsonSchemaFor(kind));
  return EXIT_OK;
}

export async function cmdEmitters(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    json: { type: "boolean" },
    emitter: { type: "string", multiple: true },
  });
  const rows = emitterCatalogue(
    await withEmitterHint(loadEmitters(values.emitter ?? [], process.cwd())),
  );
  if (values.json) {
    out(rows);
    return EXIT_OK;
  }
  for (const r of rows) console.log(`${r.emitter}@${r.version}: ${r.template} - ${r.description}`);
  return EXIT_OK;
}

/** Reachable when `main()` is called as a library; `cli.ts` short-circuits `gate` to the lazy chunk. */
export async function cmdKeygen(argv: string[]): Promise<number> {
  const { values } = opts(argv, { out: { type: "string" }, name: { type: "string" } });
  const r = await keygen(path.resolve(values.out ?? "."), values.name);
  // The private key NEVER reaches stdout; only its location does.
  out({ publicEntry: r.publicEntry, privateKeyFile: r.privateKeyFile });
  return EXIT_OK;
}

export async function cmdSign(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    "key-file": { type: "string" },
    out: { type: "string", short: "o" },
    "root-id": { type: "string" },
    keyless: { type: "boolean" },
    bound: { type: "boolean" },
    root: { type: "string" },
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("sign: <bundle.json> is required");
  if (values.keyless === true) {
    if (values["key-file"] !== undefined)
      throw new UsageError("sign --keyless does not take --key-file");
    return cmdSignKeyless(file, values);
  }
  if (values.bound === true || values.root !== undefined)
    throw new UsageError("sign: --bound / --root are only valid with --keyless");
  const bundle = parseBundleFile(await readJson(file));
  const src: Parameters<typeof signBundle>[1] = {};
  if (values["key-file"] !== undefined) src.keyFile = values["key-file"];
  const { bundle: signed, keyid } = await signBundle(bundle, src, values["root-id"]);
  const target = values.out ?? file;
  await writeFile(path.resolve(target), `${JSON.stringify(signed, null, 2)}\n`, "utf8");
  out({
    manifestDigest: signed.manifestDigest,
    keyid,
    signatures: signed.signatures?.length ?? 0,
    ...(values["root-id"] === undefined ? {} : { rootId: values["root-id"], bound: true }),
    out: target,
  });
  return EXIT_OK;
}

/**
 * `axiom sign <bundle> --keyless [--bound --root <dir> | --root-id <id>]` (S-705). Signs the SAME
 * payload bytes as the Ed25519 path (`JCS(manifest)`, or `JCS({manifest, rootId})` under the
 * bound type) as a Sigstore bundle and appends it to `bundle.keylessSignatures`. `--bound` takes
 * the root id from `--root-id`, else from the root's trust store (`axiom trust root-id`).
 */
async function cmdSignKeyless(
  file: string,
  values: { out?: string; "root-id"?: string; bound?: boolean; root?: string },
): Promise<number> {
  const bundle = parseBundleFile(await readJson(file));
  let rootId = values["root-id"];
  if (values.bound === true && rootId === undefined) {
    const rootReal = await realRootArg(values.root);
    rootId = (await loadTrustStore(rootReal))?.rootId;
    if (rootId === undefined)
      throw new UsageError(
        "sign --keyless --bound: the root's trust store has no rootId (axiom keys trust root-id <id>) - or pass --root-id",
      );
  } else if (values.bound !== true && values.root !== undefined) {
    throw new UsageError("sign --keyless: --root requires --bound");
  }
  const payload =
    rootId === undefined
      ? keylessPayload(bundle.manifest)
      : keylessPayload({ manifest: bundle.manifest, rootId });
  let sig: Awaited<ReturnType<typeof signManifestKeyless>>;
  try {
    sig = await signManifestKeyless(
      payload,
      rootId === undefined ? {} : { payloadType: AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE },
    );
  } catch (err) {
    if (isAxiomError(err) && err.code === "ERR_KEYLESS_UNAVAILABLE") {
      out(err.toJSON());
      return EXIT_FAIL;
    }
    throw err;
  }
  const signed = parseBundleFile({
    ...bundle,
    [KEYLESS_BUNDLE_FIELD]: [...(bundle.keylessSignatures ?? []), sig],
  });
  const target = values.out ?? file;
  await writeFile(path.resolve(target), `${JSON.stringify(signed, null, 2)}\n`, "utf8");
  out({
    manifestDigest: signed.manifestDigest,
    keyless: true,
    keylessSignatures: signed.keylessSignatures?.length ?? 0,
    ...(rootId === undefined ? {} : { rootId, bound: true }),
    out: target,
  });
  return EXIT_OK;
}

/** `--root` for the read-only/setup verbs: explicit dir, else the current directory. */
async function localRoot(root: string | undefined): Promise<string> {
  return realRootArg(root ?? ".");
}

export async function cmdInit(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string" },
    harness: { type: "string" },
    "profile-name": { type: "string" },
    force: { type: "boolean" },
    daemon: { type: "boolean" },
    upgrade: { type: "boolean" },
    managed: { type: "boolean" },
    out: { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  });
  const { runInit, isHarnessArg, HARNESSES } = await import("./ops-lazy.js");
  const harness = values.harness ?? "auto";
  if (!isHarnessArg(harness)) throw new UsageError(`--harness must be auto|${HARNESSES.join("|")}`);
  const rootReal = await localRoot(values.root);
  const initOpts: Parameters<typeof runInit>[0] = { root: rootReal, harness };
  if (values["profile-name"] !== undefined) initOpts.profileName = values["profile-name"];
  if (values.force === true) initOpts.force = true;
  if (values.daemon === true) initOpts.daemon = true;
  if (values.upgrade === true) initOpts.upgrade = true;
  if (values["dry-run"] === true) initOpts.dryRun = true;
  if (values.managed === true) {
    if (values.out === undefined) throw new UsageError("init --managed needs --out <dir>");
    initOpts.managed = { out: path.resolve(values.out) };
  } else if (values.out !== undefined) {
    throw new UsageError("--out is only valid with --managed");
  }
  const r = await runInit(initOpts);
  if (values.json) {
    out(r);
    return EXIT_OK;
  }
  console.log(`axiom init ${r.root} (harness: ${r.harnesses.join("+")}, profile: ${r.profile})`);
  for (const f of r.files) {
    console.log(
      `  ${f.action.padEnd(8)} ${f.path}${f.reason === undefined ? "" : ` (${f.reason})`}`,
    );
  }
  for (const n of r.notes) console.log(`  note: ${n}`);
  if (r.diff !== undefined && r.diff !== "") console.log(r.diff);
  return EXIT_OK;
}

/** Set by `main()`: argv[1] of this process, so `doctor` can time this very CLI's gate. */
let CLI_ENTRY: string | undefined;

export async function cmdDoctor(argv: string[]): Promise<number> {
  if (argv.includes("--fleet")) {
    return (await import("./v3-lazy.js")).fleetMain(
      argv.filter((a) => a !== "--fleet"),
      cliIo,
    );
  }
  const { values } = opts(argv, { root: { type: "string" }, json: { type: "boolean" } });
  const { runDoctor } = await import("./ops-lazy.js");
  const root = path.resolve(values.root ?? ".");
  const doctorOpts: Parameters<typeof runDoctor>[0] = { root, version: MIGRATE_VERSION };
  // Inside a single executable (D-27) argv[1] is the binary itself: run it directly.
  if (CLI_ENTRY !== undefined)
    doctorOpts.gateCommand =
      path.resolve(CLI_ENTRY) === path.resolve(process.execPath)
        ? [process.execPath]
        : [process.execPath, CLI_ENTRY];
  const r = await runDoctor(doctorOpts);
  if (values.json) out(r);
  else {
    for (const c of r.checks) {
      console.log(`${c.status.toUpperCase().padEnd(4)} ${c.id}: ${c.message}`);
      if (c.hint !== undefined && c.status !== "ok") console.log(`     fix: ${c.hint}`);
    }
  }
  return r.ok ? EXIT_OK : EXIT_USAGE;
}

export async function cmdStatus(argv: string[]): Promise<number> {
  const { values } = opts(argv, { root: { type: "string" }, json: { type: "boolean" } });
  const s = await collectStatus(await localRoot(values.root));
  if (values.json) out(s);
  else for (const line of renderStatus(s)) console.log(line);
  return EXIT_OK;
}

const LOG_LIMIT_DEFAULT = 20;
const LOG_LIMIT_MAX = 100_000;

export async function cmdLog(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string" },
    limit: { type: "string", short: "n" },
    json: { type: "boolean" },
  });
  const limit = intFlag(values.limit, "--limit", 1, LOG_LIMIT_MAX) ?? LOG_LIMIT_DEFAULT;
  const rootReal = await localRoot(values.root);
  const entries = await readHistory(rootReal, { limit });
  if (values.json) {
    out({ root: rootReal, entries });
    return EXIT_OK;
  }
  for (const e of entries) {
    console.log(
      `#${e.seq} ${e.at} ${e.state.padEnd(11)} ${e.manifestDigest}${e.name === undefined ? "" : ` ${e.name}`} (${e.files} files)${e.code === undefined ? "" : ` ${e.code}`}`,
    );
  }
  return EXIT_OK;
}

export async function cmdTrust(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = opts(rest, {
    root: { type: "string" },
    clear: { type: "boolean" },
  });
  const rootReal = await realRootArg(values.root);
  switch (sub) {
    case "list": {
      const store = await loadTrustStore(rootReal);
      out(store ?? { version: 1, keys: [] });
      return EXIT_OK;
    }
    case "root-id": {
      // S-409: `trust root-id <id> --root .` binds the store; `--clear` removes the binding.
      const id = positionals[0];
      if (values.clear === true) {
        const store = await trustSetRootId(rootReal, undefined);
        out({ rootId: null, keys: store.keys.length });
        return EXIT_OK;
      }
      if (id === undefined) {
        const store = await loadTrustStore(rootReal);
        out({ rootId: store?.rootId ?? null });
        return EXIT_OK;
      }
      const store = await trustSetRootId(rootReal, id);
      out({ rootId: store.rootId, keys: store.keys.length });
      return EXIT_OK;
    }
    case "add": {
      const file = positionals[0];
      if (file === undefined) throw new UsageError("trust add: <pubkey.json> is required");
      const entry = parsePublicEntry(await readJson(file));
      const store = await trustAdd(rootReal, entry);
      out({ added: entry.keyid, keys: store.keys.length });
      return EXIT_OK;
    }
    case "remove": {
      const keyid = positionals[0];
      if (keyid === undefined) throw new UsageError("trust remove: <keyid> is required");
      const store = await trustRemove(rootReal, keyid);
      out({ removed: keyid, keys: store.keys.length });
      return EXIT_OK;
    }
    default:
      throw new UsageError("trust: subcommand must be add|remove|list|root-id");
  }
}

export async function cmdGate(argv: string[]): Promise<number> {
  const { gateMain } = await import("./gate-lazy.js");
  const r = await gateMain(argv);
  for (const line of r.stderr) console.error(line);
  if (r.stdout !== undefined && r.stdout !== "") console.log(r.stdout);
  return r.exitCode;
}

/** `axiom serve --hook` (S-901): resident gate daemon; runs until SIGINT/SIGTERM. */
export async function cmdServe(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    hook: { type: "boolean" },
    root: { type: "string", multiple: true },
    host: { type: "string" },
    port: { type: "string" },
    "token-env": { type: "string" },
    otel: { type: "boolean" },
  });
  if (values.hook !== true) throw new UsageError("serve: only --hook is supported");
  const rootArgs = (values.root ?? []).map((r) => path.resolve(r));
  if (rootArgs.length === 0)
    throw new UsageError("serve --hook: at least one --root <abs> is required");
  const policy = await createRootsPolicy(rootArgs);
  const port = intFlag(values.port, "--port", 0, 65_535);
  let token: string | undefined;
  if (values["token-env"] !== undefined) {
    token = process.env[values["token-env"]];
    if (token === undefined || token === "")
      throw new UsageError(`serve --hook: env var ${values["token-env"]} is empty`);
  }
  const { startDaemon, createOtelExporter, otelFromEnv } = await import("./serve-lazy.js");
  let otel: ReturnType<typeof createOtelExporter> | undefined;
  if (values.otel === true) {
    const o = otelFromEnv(process.env);
    if (o === undefined)
      throw new UsageError(
        "serve --otel: set AXIOM_OTEL_ENDPOINT or OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT to an http(s) URL",
      );
    otel = createOtelExporter(o);
  }
  const d = await startDaemon({
    roots: [...policy.roots],
    version: MIGRATE_VERSION,
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    ...(otel === undefined ? {} : { otel }),
  });
  console.error(
    JSON.stringify({
      msg: "axiom serve --hook listening",
      url: d.url,
      pid: process.pid,
      roots: d.state.roots,
    }),
  );
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await d.close();
  return EXIT_OK;
}

/** `axiom attest decisions` (S-904): decision journal -> in-toto agent-decision JSON Lines. */
export async function cmdAttest(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "decisions") throw new UsageError("attest: subcommand must be decisions");
  const { values } = opts(rest, {
    root: { type: "string" },
    since: { type: "string" },
    limit: { type: "string", short: "n" },
    sign: { type: "boolean" },
    "key-file": { type: "string" },
  });
  if (values.since !== undefined && Number.isNaN(Date.parse(values.since)))
    throw new UsageError("--since must be an ISO 8601 timestamp");
  const limit = intFlag(values.limit, "--limit", 1, LOG_LIMIT_MAX);
  const { attestDecisions } = await import("./serve-lazy.js");
  const rows = await attestDecisions({
    root: await localRoot(values.root),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(limit === undefined ? {} : { limit }),
    ...(values.sign === true
      ? { sign: values["key-file"] === undefined ? {} : { keyFile: values["key-file"] } }
      : {}),
  });
  for (const r of rows) console.log(JSON.stringify(r));
  return EXIT_OK;
}

/** `axiom undo --session <agent>` (S-1210): restore what one agent session wrote. */
export async function cmdUndo(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string" },
    session: { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    since: { type: "string" },
  });
  if (values.session === undefined) throw new UsageError("undo: --session <agent> is required");
  const { undoSession } = await import("./ops-lazy.js");
  const r = await undoSession(await localRoot(values.root), {
    agent: values.session,
    ...(values["dry-run"] === true ? { dryRun: true } : {}),
    ...(values.force === true ? { force: true } : {}),
    ...(values.since === undefined ? {} : { since: values.since }),
  });
  out(r);
  return r.conflicts > 0 ? EXIT_FAIL : EXIT_OK;
}

/** `axiom stats` (S-1211): gate decisions + harness hook logs + silent-gate alarms. */
export async function cmdStats(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string" },
    since: { type: "string" },
    json: { type: "boolean" },
  });
  const { collectStats, parseSince, renderStats } = await import("./ops-lazy.js");
  let since: string | undefined;
  if (values.since !== undefined) {
    try {
      since = parseSince(values.since);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
  }
  const s = await collectStats({
    root: await localRoot(values.root),
    ...(since === undefined ? {} : { since }),
  });
  if (values.json === true) out(s);
  else for (const line of renderStats(s)) console.log(line);
  return EXIT_OK;
}

/** `axiom import-guard <guard.ps1>` (S-1216): PowerShell guard tables -> gate profile `commands`. */
export async function cmdImportGuard(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { out: { type: "string", short: "o" } });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("import-guard: <guard.ps1> is required");
  const { importGuardProfile } = await import("./ops-lazy.js");
  const r = importGuardProfile(await readInput(file));
  for (const s of r.skipped) console.error(`skipped line ${s.line}: ${s.why}`);
  if (values.out !== undefined) {
    await writeFile(
      path.resolve(values.out),
      `${JSON.stringify({ commands: r.commands }, null, 2)}\n`,
    );
    out({
      written: path.resolve(values.out),
      rules: r.commands.deny.length,
      skipped: r.skipped.length,
    });
  } else {
    out({ commands: r.commands, skipped: r.skipped });
  }
  return EXIT_OK;
}

export async function cmdMigrate(argv: string[]): Promise<number> {
  if (argv[0] === "--profile" || (argv.includes("--profile") && argv[0] !== "v1")) {
    const { values } = opts(argv, {
      profile: { type: "boolean" },
      root: { type: "string" },
      "dry-run": { type: "boolean" },
      name: { type: "string" },
    });
    const root = await localRoot(values.root);
    const { migrateProfile } = await import("./v3-lazy.js");
    const r = await migrateProfile(root, {
      dryRun: values["dry-run"] === true,
      ...(values.name === undefined ? {} : { profileName: values.name }),
    });
    if (values["dry-run"] === true) console.log(r.json);
    else for (const n of r.notes) console.log(n);
    return EXIT_OK;
  }
  const [from, ...rest] = argv;
  if (from !== "v1") throw new UsageError("migrate: source format must be v1");
  const { values, positionals } = opts(rest, {
    out: { type: "string", short: "o" },
    profile: { type: "string" },
    cas: { type: "string" },
    content: { type: "string" },
    name: { type: "string" },
    overwrite: { type: "boolean" },
  });
  const file = positionals[0];
  if (file === undefined) throw new UsageError("migrate v1: <manifest.json> is required");
  const { migrateV1 } = await import("./migrate-lazy.js");
  const contentDir = path.resolve(values.content ?? path.dirname(path.resolve(file)));
  const migrateOpts: Parameters<typeof migrateV1>[1] = {
    version: MIGRATE_VERSION,
    resolveContent: async (rel) => {
      try {
        return new Uint8Array(await readFile(path.join(contentDir, rel)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
  };
  if (values.profile !== undefined) migrateOpts.profile = values.profile;
  if (values.name !== undefined) migrateOpts.name = values.name;
  if (values.overwrite === true) migrateOpts.overwrite = true;
  if (values.cas !== undefined) migrateOpts.casRoot = await realRootArg(values.cas);
  const { plan, report } = await migrateV1(await readJson(file), migrateOpts);
  if (values.out !== undefined) {
    await writeFile(path.resolve(values.out), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    out({ ...report, out: values.out });
  } else {
    out({ plan, report });
  }
  return report.ok ? EXIT_OK : EXIT_FAIL;
}

/** Set by `main()` so lazily-loaded verbs can record the CLI version without importing package.json. */
let MIGRATE_VERSION = "0.0.0";

export async function cmdSnapshot(argv: string[]): Promise<number> {
  const { values } = opts(argv, {
    root: { type: "string" },
    out: { type: "string", short: "o" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    "max-files": { type: "string" },
    "max-bytes": { type: "string" },
    "no-gitignore": { type: "boolean" },
    "no-digest": { type: "boolean" },
  });
  const rootReal = await realRootArg(values.root);
  const snapOpts: Parameters<typeof snapshotRoot>[1] = {
    respectGitignore: values["no-gitignore"] !== true,
    withContentDigest: values["no-digest"] !== true,
  };
  if (values.include !== undefined) snapOpts.include = values.include;
  if (values.exclude !== undefined) snapOpts.exclude = values.exclude;
  for (const [flag, key] of [
    ["max-files", "maxFiles"],
    ["max-bytes", "maxBytes"],
  ] as const) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      throw new UsageError(`--${flag} must be a non-negative integer`);
    snapOpts[key] = n;
  }
  const snap = await snapshotRoot(rootReal, snapOpts);
  if (values.out !== undefined) {
    await writeFile(path.resolve(values.out), `${JSON.stringify(snap, null, 2)}\n`, "utf8");
    out({
      snapshotDigest: snap.snapshotDigest,
      ...snap.body.counts,
      truncated: snap.body.truncated,
      out: values.out,
    });
  } else {
    out(snap);
  }
  return EXIT_OK;
}

function parseSnapshotFile(raw: unknown, label: string) {
  const parsed = RepoSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_MANIFEST", `${label} does not match RepoSnapshotSchema`, {
      details: {
        issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

export async function cmdSnapshotDiff(argv: string[]): Promise<number> {
  const { positionals } = opts(argv, {});
  const [a, b] = positionals;
  if (a === undefined || b === undefined)
    throw new UsageError("snapshot-diff: <a.json> <b.json> are required");
  const [sa, sb] = await Promise.all([readJson(a), readJson(b)]);
  out(diffSnapshots(parseSnapshotFile(sa, a), parseSnapshotFile(sb, b)));
  return EXIT_OK;
}

/** A usage error tied to the command it happened in (for the one-line usage + help hint). */
function usageFail(
  message: string,
  json: boolean,
  usage: string | undefined,
  helpCmd: string,
): number {
  const help = `axiom ${helpCmd} --help`.replace(/\s+/g, " ");
  if (json) {
    console.error(
      JSON.stringify({
        code: "ERR_USAGE",
        message,
        details: { ...(usage === undefined ? {} : { usage }), help },
      }),
    );
  } else {
    const lines = [`error: ${message}`];
    if (usage !== undefined) lines.push(`usage: ${usage}`);
    lines.push(`Run '${help}' for usage, options and examples.`);
    console.error(lines.join("\n"));
  }
  return EXIT_USAGE;
}

function didYouMean(near: string[]): string {
  return near.length === 0 ? "" : ` (did you mean ${near.map((n) => `'${n}'`).join(" or ")}?)`;
}

/** `axiom help [words...]` / `axiom <words> --help`: the narrowest help that matches. */
function printHelp(words: readonly string[], version: string): number {
  const r = resolveCommand(words);
  if (r?.rest.every((w) => w.startsWith("-"))) {
    process.stdout.write(renderCommandHelp(r.cmd));
    return EXIT_OK;
  }
  const g = findGroup(words[0]);
  if (g !== undefined) {
    process.stdout.write(renderGroupHelp(g));
    return EXIT_OK;
  }
  process.stdout.write(renderOverview(version));
  return EXIT_OK;
}

/** Errors a user caused (missing file, malformed JSON) must never surface as ERR_INTERNAL. */
function fsErrorToAxiom(err: unknown): AxiomError | undefined {
  const e = err as NodeJS.ErrnoException;
  if (e === null || typeof e !== "object") return undefined;
  if (e.code === "ENOENT")
    return new AxiomError("ERR_NOT_FOUND", `no such file or directory: ${e.path ?? "?"}`, {
      details: { path: e.path ?? null },
    });
  if (e.code === "EISDIR")
    return new AxiomError(
      "ERR_TARGET_TYPE",
      `expected a file, found a directory: ${e.path ?? "?"}`,
      {
        details: { path: e.path ?? null },
      },
    );
  return undefined;
}

export async function main(argv: readonly string[], version: string): Promise<number> {
  MIGRATE_VERSION = version;
  CLI_ENTRY = process.argv[1];
  const json = flagsOf(argv).includes("--json");
  const [first] = argv;
  if (first === undefined) {
    process.stdout.write(renderOverview(version));
    return EXIT_USAGE;
  }
  if (first === "--help" || first === "-h") {
    process.stdout.write(renderOverview(version));
    return EXIT_OK;
  }
  if (first === "help") return printHelp(argv.slice(1), version);
  if (first === "--version" || first === "-v") {
    console.log(version);
    return EXIT_OK;
  }
  const resolved = resolveCommand(argv);
  if (resolved === undefined) {
    const group = findGroup(first);
    if (group !== undefined) {
      const sub = argv[1];
      if (sub === undefined || sub.startsWith("-")) {
        process.stdout.write(renderGroupHelp(group));
        return sub === undefined ? EXIT_USAGE : EXIT_OK;
      }
      const near = suggest(
        sub,
        groupCommands(group.name).map((c) => ({
          word: c.path[1] ?? "",
          show: `${group.name} ${c.path[1] ?? ""}`,
        })),
      );
      return usageFail(
        `unknown command 'axiom ${group.name} ${sub}'${didYouMean(near)}`,
        json,
        undefined,
        group.name,
      );
    }
    if (first.startsWith("-")) return usageFail(`unknown option '${first}'`, json, undefined, "");
    const near = suggest(first, topLevelCandidates());
    return usageFail(`unknown command '${first}'${didYouMean(near)}`, json, undefined, "");
  }
  const { cmd, rest } = resolved;
  const name = commandName(cmd);
  // `axiom <cmd> --help` used to reach the verb's strict parseArgs -> "Unknown option '--help'".
  // No option of any verb is `-h`, so either flag before a `--` separator means "show usage".
  if (wantsHelp(rest)) {
    process.stdout.write(renderCommandHelp(cmd));
    return EXIT_OK;
  }
  if (cmd.passthrough !== true) {
    const bad = checkOptions(cmd, rest);
    if (bad !== undefined) return usageFail(bad, json, oneLineUsage(cmd), name);
  }
  try {
    return await cmd.run(rest);
  } catch (err) {
    if (err instanceof AxmDiagnosticsError) {
      out({ code: "ERR_INVALID_PLAN", diagnostics: err.diagnostics });
      return EXIT_USAGE;
    }
    if (err instanceof UsageError) return usageFail(err.message, json, oneLineUsage(cmd), name);
    if (err instanceof Error && (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS"))
      return usageFail(err.message, json, oneLineUsage(cmd), name);
    // Duck-typed: lazy chunks (`migrate-lazy`, ...) carry their own bundled AxiomError class.
    if (isAxiomError(err)) {
      console.error(JSON.stringify(err.toJSON()));
      return EXIT_USAGE;
    }
    const mapped = fsErrorToAxiom(err);
    if (mapped !== undefined) {
      console.error(JSON.stringify(mapped.toJSON()));
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

/** For `scripts/gen-cli-doc.mjs` / `check-cli-doc.mjs`, which import the built `dist/cli-main.js`. */
export { CLI_DOC_MARKER, COMMANDS, extractNotes, renderCliMarkdown } from "./cli-commands.js";
