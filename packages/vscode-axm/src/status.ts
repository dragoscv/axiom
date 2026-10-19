/**
 * Pure logic of the AXIOM extension (no `vscode` import, unit-tested with vitest):
 * doctor JSON → status bar state, CLI invocation resolution without a shell, version compare.
 */
import { dirname, extname, join } from "node:path";

export type GateLevel = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  message?: string;
  hint?: string;
}

export interface GateStatus {
  level: GateLevel;
  /** Status bar text, e.g. `AXIOM ok`. */
  text: string;
  /** Tooltip: the failing / warning check ids, or the reason the state is unknown. */
  tooltip: string;
  /** Ids of checks with status `fail`, then `warn`. */
  problems: string[];
  /** ThemeColor id for the item background, when any. */
  background?: "statusBarItem.warningBackground" | "statusBarItem.errorBackground";
}

const ICON: Record<GateLevel, string> = {
  ok: "$(shield)",
  warn: "$(warning)",
  fail: "$(error)",
  unknown: "$(question)",
};

function isCheck(v: unknown): v is DoctorCheck {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "string" && (c.status === "ok" || c.status === "warn" || c.status === "fail")
  );
}

/** First JSON object in `stdout` (the CLI may print a banner line before it). */
export function extractJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export function unknownStatus(reason: string): GateStatus {
  return { level: "unknown", text: `${ICON.unknown} AXIOM ?`, tooltip: reason, problems: [] };
}

/**
 * `axiom setup doctor --json` / `axiom doctor --json` output → status bar state. Any `fail`
 * check → fail; else any `warn` → warn; else ok. Unparseable output → unknown.
 */
export function statusFromDoctor(doc: unknown): GateStatus {
  if (
    typeof doc !== "object" ||
    doc === null ||
    !Array.isArray((doc as { checks?: unknown }).checks)
  ) {
    return unknownStatus("axiom doctor did not return a JSON report");
  }
  const checks = (doc as { checks: unknown[] }).checks.filter(isCheck);
  const fails = checks.filter((c) => c.status === "fail").map((c) => c.id);
  const warns = checks.filter((c) => c.status === "warn").map((c) => c.id);
  const level: GateLevel = fails.length > 0 ? "fail" : warns.length > 0 ? "warn" : "ok";
  const problems = [...fails, ...warns];
  const lines = [
    level === "ok"
      ? `AXIOM gate: all ${checks.length} doctor checks ok`
      : `AXIOM gate: ${fails.length} failing, ${warns.length} warning`,
    ...fails.map((id) => `✗ ${id}`),
    ...warns.map((id) => `⚠ ${id}`),
    "Click to run AXIOM: Doctor",
  ];
  const out: GateStatus = {
    level,
    text: `${ICON[level]} AXIOM ${level}`,
    tooltip: lines.join("\n"),
    problems,
  };
  if (level === "warn") out.background = "statusBarItem.warningBackground";
  if (level === "fail") out.background = "statusBarItem.errorBackground";
  return out;
}

/** Human report for the output channel. */
export function renderDoctor(doc: unknown): string {
  if (typeof doc !== "object" || doc === null) return String(doc);
  const d = doc as { root?: unknown; checks?: unknown };
  const checks = Array.isArray(d.checks) ? d.checks.filter(isCheck) : [];
  const mark = { ok: "ok  ", warn: "WARN", fail: "FAIL" } as const;
  return [
    `axiom doctor — ${typeof d.root === "string" ? d.root : "?"}`,
    ...checks.map(
      (c) =>
        `${mark[c.status]} ${c.id}${c.message ? `: ${c.message}` : ""}${c.hint ? `\n       → ${c.hint}` : ""}`,
    ),
  ].join("\n");
}

/** True when the CLI rejected the verb itself (older axiom without `setup` / `explain`). */
export function isUnknownCommand(stderr: string, stdout = ""): boolean {
  return /unknown (command|verb|subcommand)|not a command|ERR_USAGE/i.test(`${stderr}\n${stdout}`);
}

/** Numeric `a.b.c` compare (pre-release tags ignored); -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      ?.split(".")
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Pick the workspace LSP only when trusted AND not older than the bundled one. */
export function pickServerModule(opts: {
  trusted: boolean;
  bundled: string;
  bundledVersion: string;
  workspace?: { module: string; version: string } | undefined;
}): { module: string; source: "workspace" | "bundled" } {
  const w = opts.workspace;
  if (opts.trusted && w !== undefined && compareVersions(w.version, opts.bundledVersion) >= 0) {
    return { module: w.module, source: "workspace" };
  }
  return { module: opts.bundled, source: "bundled" };
}

export interface Invocation {
  file: string;
  /** Arguments that precede the CLI arguments (e.g. the cli.js path when running through node). */
  prefix: string[];
}

export interface ResolveEnv {
  platform: NodeJS.Platform;
  /** PATH value. */
  path: string;
  exists: (file: string) => boolean;
}

const MCP_CLI = ["node_modules", "@codai", "axiom-mcp", "dist", "cli.js"];

/** An npm `.cmd` shim cannot be execFile'd without a shell (CVE-2024-27980) → run its cli.js via node. */
function throughNode(shim: string, env: ResolveEnv): Invocation | undefined {
  const cli = join(dirname(shim), ...MCP_CLI);
  if (!env.exists(cli)) return undefined;
  const localNode = join(dirname(shim), "node.exe");
  return { file: env.exists(localNode) ? localNode : "node", prefix: [cli] };
}

function asInvocation(file: string, env: ResolveEnv): Invocation | undefined {
  const ext = extname(file).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { file: "node", prefix: [file] };
  if (env.platform === "win32" && (ext === ".cmd" || ext === ".bat")) return throughNode(file, env);
  return { file, prefix: [] };
}

/**
 * Setting `axiom.path` (default `axiom`) → how to execFile it, with NO shell. A path with a
 * separator is used as given; a bare name is searched on PATH (win32: `.exe`, then `.cmd` whose
 * npm layout is translated to `node <cli.js>`). `undefined` = not found.
 */
export function resolveInvocation(setting: string, env: ResolveEnv): Invocation | undefined {
  const bin = setting.trim() === "" ? "axiom" : setting.trim();
  const sep = env.platform === "win32" ? /[\\/]/ : /\//;
  if (sep.test(bin)) {
    if (env.platform === "win32" && extname(bin) === "") {
      for (const ext of [".exe", ".cmd"])
        if (env.exists(bin + ext)) return asInvocation(bin + ext, env);
    }
    return env.exists(bin) ? asInvocation(bin, env) : undefined;
  }
  const names =
    env.platform === "win32" && extname(bin) === "" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
  const dirs = env.path.split(env.platform === "win32" ? ";" : ":").filter((d) => d !== "");
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir, name);
      if (!env.exists(file)) continue;
      const inv = asInvocation(file, env);
      if (inv !== undefined) return inv;
    }
  }
  return undefined;
}
