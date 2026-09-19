import { type ChildProcess, spawn } from "node:child_process";
import { realpath as realpathCb } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { canonicalize } from "@codai/axiom-canon";
import { type Finding, RelPathSchema } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import { finding } from "./util.js";

/** §3.2 params. */
export const GuardExternalParams = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.enum(["root", "staging"]).default("root"),
    timeoutMs: z.int().min(1).max(60_000).default(30_000),
    env: z.record(z.string(), z.string()).optional(),
    stdin: z.enum(["bundle", "manifest", "none"]).default("bundle"),
    /** Accept brivio-style `OK    name` / `FAIL  name: reason` stdout instead of JSON. */
    legacyText: z.boolean().default(false),
  })
  .strict();

export type GuardExternalParamsT = z.infer<typeof GuardExternalParams>;

/** What a guard must print on stdout (JSON, one object). */
export const GuardOutputSchema = z
  .object({
    ok: z.boolean(),
    findings: z
      .array(
        z
          .object({
            id: z.string().min(1),
            severity: z.enum(["error", "warn", "info"]).optional(),
            message: z.string(),
            path: z.string().optional(),
            facts: z.record(z.string(), z.json()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type GuardOutput = z.infer<typeof GuardOutputSchema>;

const PREDICATE = "guard.external" as const;
const STDERR_TAIL = 4 * 1024;
const OUTPUT_MAX = 8 * 1024 * 1024;
const IS_WIN32 = process.platform === "win32";
const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);

/** Environment variables a guard child inherits; everything else (secrets) is dropped. */
const ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "PATHEXT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];

async function realpathSafe(p: string): Promise<string | undefined> {
  try {
    let r = await realpathNative(p);
    if (IS_WIN32 && r.startsWith("\\\\?\\")) r = r.slice(4);
    return r;
  } catch {
    return undefined;
  }
}

function norm(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return IS_WIN32 ? n.toLowerCase() : n;
}

function isInside(parent: string, child: string): boolean {
  const p = norm(parent);
  const c = norm(child);
  return c !== p && c.startsWith(p + path.sep);
}

function providerError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Finding {
  return finding({
    id: PREDICATE,
    predicate: PREDICATE,
    message,
    facts: { code, __provider: true, ...extra },
  });
}

/** Build the scrubbed child environment. */
export function guardEnv(
  extra: Record<string, string> | undefined,
  digest: string,
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (ENV_WHITELIST.includes(k.toUpperCase())) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = v;
  out.AXIOM_MANIFEST_DIGEST = digest;
  out.AXIOM_ROOT = root;
  out.NODE_OPTIONS = "";
  return out;
}

interface Resolved {
  file: string;
  argv: string[];
}

/**
 * Resolve `command` to `{file, argv}` for spawn (no shell, ever):
 * relative → must land inside `<root>/scripts/` after realpath; absolute → must be
 * an exact realpath match in the allowlist. `.mjs/.js/.cjs` run via `process.execPath`,
 * `.ps1` via `pwsh -NoProfile -ExecutionPolicy Bypass -File`, anything else runs as-is.
 */
export async function resolveGuardCommand(
  command: string,
  args: readonly string[],
  root: string,
  allowlist: readonly string[],
): Promise<Resolved | Finding> {
  const segments = command.split(/[\\/]+/);
  if (segments.includes("..")) {
    return providerError(
      "ERR_PREDICATE_PARAMS",
      `guard command must not contain "..": ${command}`,
      {
        command,
      },
    );
  }
  let real: string | undefined;
  if (path.isAbsolute(command)) {
    real = await realpathSafe(command);
    if (real === undefined) {
      return providerError("ERR_PREDICATE_PARAMS", `guard command not found: ${command}`, {
        command,
      });
    }
    const allowed = new Set<string>();
    for (const a of allowlist) {
      const r = await realpathSafe(a);
      if (r !== undefined) allowed.add(norm(r));
    }
    if (!allowed.has(norm(real))) {
      return providerError(
        "ERR_PREDICATE_PARAMS",
        `absolute guard command is not in --guard-allowlist: ${command}`,
        { command },
      );
    }
  } else {
    const scriptsDir = path.join(root, "scripts");
    const candidate =
      segments[0] === "scripts" ? path.resolve(root, command) : path.resolve(scriptsDir, command);
    real = await realpathSafe(candidate);
    const scriptsReal = await realpathSafe(scriptsDir);
    if (real === undefined || scriptsReal === undefined || !isInside(scriptsReal, real)) {
      return providerError(
        "ERR_PREDICATE_PARAMS",
        `relative guard command must resolve inside <root>/scripts/: ${command}`,
        { command },
      );
    }
  }
  const ext = path.extname(real).toLowerCase();
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") {
    return { file: process.execPath, argv: [real, ...args] };
  }
  if (ext === ".ps1") {
    return {
      file: "pwsh",
      argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", real, ...args],
    };
  }
  if (!path.isAbsolute(command)) {
    return providerError(
      "ERR_PREDICATE_PARAMS",
      `relative guard command must be .mjs/.js/.cjs/.ps1: ${command}`,
      { command },
    );
  }
  return { file: real, argv: [...args] };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WIN32) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => undefined);
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runChild(
  resolved: Resolved,
  cwd: string,
  env: Record<string, string>,
  input: string | undefined,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const child = spawn(resolved.file, resolved.argv, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (r: Omit<SpawnResult, "stdout" | "stderr" | "timedOut">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (stdout.length < OUTPUT_MAX) stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr = (stderr + d).slice(-STDERR_TAIL);
    });
    child.on("error", (e) => finish({ code: null, spawnError: e.message }));
    child.on("close", (code) => finish({ code }));
    if (child.stdin !== null) {
      child.stdin.on("error", () => undefined);
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

function parseJsonOutput(stdout: string): GuardOutput | undefined {
  const text = stdout.trim();
  if (text === "" || (text[0] !== "{" && text[0] !== "[")) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = GuardOutputSchema.safeParse(raw);
  return r.success ? r.data : undefined;
}

const LEGACY_FAIL = /^FAIL\s+([^:\n]+?)(?::\s*(.*))?$/;
const LEGACY_OK = /^OK\s+\S/;

/** brivio `run-guards.mjs` contract: `OK    name` / `FAIL  name: reason` lines. */
export function parseLegacyText(stdout: string): GuardOutput | undefined {
  const findings: NonNullable<GuardOutput["findings"]> = [];
  let sawAny = false;
  for (const line of stdout.split(/\r?\n/)) {
    const m = LEGACY_FAIL.exec(line);
    if (m !== null) {
      sawAny = true;
      findings.push({
        id: (m[1] ?? "guard").trim(),
        severity: "error",
        message: (m[2] ?? "").trim() || "guard failed",
      });
    } else if (LEGACY_OK.test(line)) {
      sawAny = true;
    }
  }
  if (!sawAny) return undefined;
  return { ok: findings.length === 0, findings };
}

/**
 * Raw process evidence attached to every guard finding (S-408, red-team B8): a
 * finding that only says "FAIL x" is unauditable; the operator needs the exit code
 * and the tail of what the guard actually printed. Bounded so findings stay small.
 */
export interface GuardEvidence {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const EVIDENCE_TAIL = 2048;

function evidenceOf(r: { code: number | null; stdout: string; stderr: string }): GuardEvidence {
  return {
    exitCode: r.code,
    stdout: r.stdout.slice(-EVIDENCE_TAIL),
    stderr: r.stderr.slice(-EVIDENCE_TAIL),
  };
}

function mapOutput(out: GuardOutput, command: string, evidence: GuardEvidence): Finding[] {
  const findings: Finding[] = [];
  for (const f of out.findings ?? []) {
    const severity = f.severity ?? (out.ok ? "info" : "error");
    const rel = f.path === undefined ? undefined : RelPathSchema.safeParse(f.path);
    const facts: Record<string, unknown> = { ...(f.facts ?? {}), command, evidence };
    if (rel !== undefined && !rel.success) facts.rawPath = f.path;
    const fi = finding({
      id: f.id,
      predicate: PREDICATE,
      message: f.message,
      severity,
      facts,
    });
    if (rel?.success) fi.path = rel.data;
    findings.push(fi);
  }
  if (!out.ok && findings.length === 0) {
    findings.push(
      finding({
        id: PREDICATE,
        predicate: PREDICATE,
        message: `guard reported ok:false without findings: ${command}`,
        facts: { command, evidence },
      }),
    );
  }
  return findings;
}

export async function runGuard(ctx: FactContext, params: GuardExternalParamsT): Promise<Finding[]> {
  const guard = ctx.facts.guard;
  if (guard === undefined || !guard.enabled || !ctx.facts.profile.allowGuards) {
    return [
      providerError(
        "ERR_FACT_DISABLED",
        "external guards disabled (needs profile facts.allowGuards and --allow-guards)",
        { command: params.command },
      ),
    ];
  }
  const resolved = await resolveGuardCommand(
    params.command,
    params.args,
    guard.root,
    guard.allowlist,
  );
  if ("id" in resolved) return [resolved];

  let cwd = guard.root;
  if (params.cwd === "staging") {
    if (guard.stagingDir === undefined) {
      return [
        providerError("ERR_PREDICATE_PARAMS", 'cwd "staging" requested but no staging dir', {
          command: params.command,
        }),
      ];
    }
    cwd = guard.stagingDir;
  }
  const input =
    params.stdin === "none"
      ? undefined
      : canonicalize(params.stdin === "bundle" ? ctx.bundle : ctx.manifest);
  const env = guardEnv(params.env, ctx.bundle.manifestDigest, guard.root);
  const r = await runChild(resolved, cwd, env, input, params.timeoutMs);

  if (r.timedOut) {
    return [
      providerError("ERR_GUARD_TIMEOUT", `guard timed out after ${params.timeoutMs} ms`, {
        command: params.command,
        timeoutMs: params.timeoutMs,
        evidence: evidenceOf(r),
      }),
    ];
  }
  if (r.spawnError !== undefined) {
    return [
      providerError("ERR_GUARD_OUTPUT", `guard could not be spawned: ${r.spawnError}`, {
        command: params.command,
      }),
    ];
  }
  const out =
    parseJsonOutput(r.stdout) ?? (params.legacyText ? parseLegacyText(r.stdout) : undefined);
  if (out === undefined) {
    return [
      providerError(
        "ERR_GUARD_OUTPUT",
        `guard stdout is not a GuardOutput JSON object (exit ${r.code ?? "null"})`,
        {
          command: params.command,
          evidence: evidenceOf(r),
        },
      ),
    ];
  }
  return mapOutput(out, params.command, evidenceOf(r));
}

export const guardExternal = definePredicate<GuardExternalParamsT>({
  id: PREDICATE,
  params: GuardExternalParams,
  requires: ["guard"],
  run: runGuard,
});
