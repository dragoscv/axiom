/**
 * Where the native hook client (`axiom-hook`) lives, and whether it can actually answer (4.0,
 * D-51 / S-1412).
 *
 * Reality check #2: `setup init --daemon` wrote hooks that call a bare `axiom-hook`, which an npm
 * install never puts on PATH (the platform packages have no `bin` field; the executable sits at
 * `@codai/axiom-hook-<platform>/bin/axiom-hook[.exe]`) - every tool call was then denied or
 * failed open, and doctor stayed fully green. Init and doctor now ask this module for a command
 * that RESOLVES and run its self-test before they wire or report it.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

export interface HookBin {
  /** Absolute path of the executable (or of the launcher script). */
  path: string;
  /** `native` = the Rust client; `node` = `axiom gate` through node (always available). */
  kind: "native" | "node";
  /** For `node`: the CLI script to run. */
  version?: string;
}

export interface HookSelfTest {
  ok: boolean;
  /** Wall time of one allow decision through the wired command, in ms. */
  ms?: number;
  /** Why it failed (`not-found`, `spawn-failed`, `bad-verdict`, `timeout`). */
  reason?: string;
}

/** Overrides the native client path (tests, and an install whose layout is unusual). */
export const ENV_HOOK_BIN = "AXIOM_HOOK_BIN";
/** Suffixes a Windows shell appends when resolving a bare program name. */
const PATHEXT_WIN = [".exe", ".cmd", ".bat", ".ps1", ".com"];
const SELF_TEST_TIMEOUT_MS = 10_000;

const isFile = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

/**
 * Windows semantics for a `PATH` lookup. An explicit `OS` wins (`Windows_NT` is what cmd.exe and
 * PowerShell set), so a POSIX resolution can be exercised on a Windows box and vice versa.
 */
const isWin = (env: NodeJS.ProcessEnv): boolean => {
  const os = env.OS;
  return os === undefined || os === "" ? process.platform === "win32" : os === "Windows_NT";
};

/**
 * The program as the HARNESS would resolve it: a bare name against `PATH` (with `PATHEXT` on
 * Windows), a path against the filesystem. `undefined` means every PreToolUse call fails (deny,
 * or fail-open where the harness ignores the exit code): the A3-3 case in which `init --daemon`
 * wired a bare `axiom-hook` that npm does not put on PATH while doctor stayed green.
 */
export async function resolveHookProgram(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (program === "") return undefined;
  const win = isWin(env);
  const exts = win ? PATHEXT_WIN : [""];
  // A hook may name the shim explicitly (`axiom.cmd`), so the name itself is a candidate too.
  const candidates = (base: string): string[] => [
    ...new Set([base, ...exts.map((e) => `${base}${e}`)]),
  ];
  if (/[\\/]/.test(program)) {
    for (const c of candidates(program)) if (await isFile(c)) return c;
    return undefined;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : ":")) {
    const d = dir.trim().replace(/^"|"$/g, "");
    if (d === "") continue;
    for (const c of candidates(path.join(d, program))) if (await isFile(c)) return c;
  }
  return undefined;
}

/** Package name of the native client for a platform (`os`/`cpu` are npm's words, not node's). */
export function hookPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `@codai/axiom-hook-${platform}-${arch}`;
}

/** `bin/axiom-hook[.exe]` of the installed platform package, resolved from this module's own path. */
async function resolveInstalledHook(): Promise<string | undefined> {
  const require = createRequire(import.meta.url);
  let pkgJson: string;
  try {
    pkgJson = require.resolve(`${hookPackageName()}/package.json`);
  } catch {
    return undefined;
  }
  const exe = isWin(process.env) ? "axiom-hook.exe" : "axiom-hook";
  const bin = path.join(path.dirname(pkgJson), "bin", exe);
  return (await isFile(bin)) ? bin : undefined;
}

/**
 * The native hook client for this install, or `undefined` when none is usable. `AXIOM_HOOK_BIN`
 * wins; then the installed platform package (the layout npm really produces); then `PATH`.
 */
export async function resolveHookBin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookBin | undefined> {
  const override = env[ENV_HOOK_BIN];
  if (override !== undefined && override !== "" && (await isFile(override))) {
    return { path: override, kind: "native" };
  }
  const installed = await resolveInstalledHook();
  if (installed !== undefined) return { path: installed, kind: "native" };
  const onPath = await resolveHookProgram("axiom-hook", env);
  return onPath === undefined ? undefined : { path: onPath, kind: "native" };
}

/** `node <cli.js>` - the client that is always available, so init can always fall back to it. */
export function nodeHookBin(execPath: string, cli: string): HookBin {
  return { path: execPath, kind: "node", version: cli };
}

export interface RunHookResult {
  exit: number | undefined;
  stdout: string;
  ms: number;
}

/**
 * Run the client once over a payload in `cwd`. Never throws: a missing binary, a crash and a
 * timeout all come back as `exit: undefined`.
 */
export async function runHookOnce(
  bin: HookBin,
  argv: readonly string[],
  payload: string,
  cwd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunHookResult> {
  const args = bin.kind === "node" ? [bin.version ?? "", ...argv] : [...argv];
  const t0 = performance.now();
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(bin.path, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
    const finish = (exit: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit, stdout, ms: performance.now() - t0 });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, opts.timeoutMs ?? SELF_TEST_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < 64 * 1024) stdout += c;
    });
    child.stderr.resume();
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code ?? undefined));
    child.stdin.on("error", () => undefined);
    child.stdin.end(payload);
  });
}

/** Verdict shapes a self-test accepts as "this client really decided". */
export function isVerdictDocument(stdout: string): boolean {
  if (stdout.trim() === "") return true; // allow: exit 0 and nothing printed
  try {
    const doc = JSON.parse(stdout) as Record<string, unknown> | null;
    if (typeof doc !== "object" || doc === null) return false;
    return (
      typeof doc.permissionDecision === "string" ||
      typeof doc.decision === "string" ||
      typeof doc.permission === "string" ||
      doc.cancel === true ||
      typeof doc.hookSpecificOutput === "object"
    );
  } catch {
    return false;
  }
}

/**
 * Self-test (D-51): one canned allow through the WIRED command, and check the answer is a
 * verdict rather than a crash. `init --daemon` wires the native client only where this passes;
 * everywhere else it keeps the node client, so a broken native install cannot turn every tool
 * call into a deny.
 */
export async function selfTestHook(
  bin: HookBin,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<HookSelfTest> {
  const payload = JSON.stringify({
    session_id: "axiom-self-test",
    hook_event_name: "PreToolUse",
    cwd: opts.cwd,
    tool_name: "Write",
    tool_input: { file_path: "src/self-test.ts", content: "export const ok = true;\n" },
  });
  const r = await runHookOnce(bin, ["gate", "--stdin", "--format", "auto"], payload, opts.cwd, {
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (r.exit === undefined) return { ok: false, reason: "spawn-failed", ms: r.ms };
  // 0 (the document carries the decision) and 2 (exit-code-only harnesses) are the verdicts.
  if (r.exit !== 0 && r.exit !== 2) return { ok: false, reason: "bad-verdict", ms: r.ms };
  if (!isVerdictDocument(r.stdout)) return { ok: false, reason: "bad-verdict", ms: r.ms };
  return { ok: true, ms: r.ms };
}
