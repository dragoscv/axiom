/**
 * `axiom doctor` (S-702): is this machine + root wired correctly? Each check is `ok | warn | fail`
 * with a message and a fix hint. Read-only apart from spawning the gate (which never writes).
 * Exit contract (cli-main): 0 when no check failed, 2 when any did — warnings never fail.
 */
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { journalStatus, lockStatus, verifyChain } from "@codai/axiom-apply";
import { loadProfile } from "@codai/axiom-checks";
import { GateProfileSchema } from "./gate.js";
import { CLAUDE_HOOK_ENTRY, GITIGNORE_LINES, INIT_FILES } from "./init.js";
import { realDir } from "./roots.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DoctorResult {
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
}

/** 80 % of the 5 s hook timeout every harness applies (and then fails OPEN). */
export const GATE_P95_FAIL_MS = 4000;
export const GATE_HOOK_TIMEOUT_MS = 5000;
export const GATE_PROBE_RUNS = 5;

/** Measures one `gate --stdin` round trip; returns wall ms and the exit code. */
export type GateProbe = (root: string, payload: string) => Promise<{ ms: number; exit: number }>;

/** Resolves the global `axiom` bin; `undefined` = not on PATH. */
export type BinLocator = () => Promise<{ path: string; version?: string } | undefined>;

export interface DoctorOptions {
  root: string;
  /** This CLI's version (compared against the global bin). */
  version: string;
  /** Command that runs this CLI's gate: `[execPath, ...args]`. Absent → latency check warns. */
  gateCommand?: readonly string[];
  /** Test seams. */
  probe?: GateProbe;
  locateBin?: BinLocator;
}

function check(id: string, status: CheckStatus, message: string, hint?: string): DoctorCheck {
  return hint === undefined ? { id, status, message } : { id, status, message, hint };
}

function execFileText(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
      err === null ? resolve(String(stdout)) : reject(err),
    );
  });
}

/** `where axiom` / `which axiom` (no shell), then the version from the bin or its package. */
export function defaultBinLocator(): BinLocator {
  return async () => {
    const win = process.platform === "win32";
    let found: string | undefined;
    try {
      const out = await execFileText(win ? "where" : "which", ["axiom"], 5000);
      const lines = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "");
      // `where` also lists npm's extensionless sh shim; the .exe/.cmd is what a hook runs.
      found = (win ? lines.find((l) => /\.(exe|cmd)$/i.test(l)) : undefined) ?? lines[0];
    } catch {
      return undefined;
    }
    if (found === undefined) return undefined;
    // Windows shims (.cmd/.ps1/sh) cannot be execFile'd without a shell: read the package instead.
    if (win && !/\.exe$/i.test(found)) {
      const dir = path.dirname(found);
      for (const pkg of [
        path.join(dir, "node_modules", "@codai", "axiom-mcp", "package.json"),
        path.join(dir, "global", "5", "node_modules", "@codai", "axiom-mcp", "package.json"),
      ]) {
        try {
          const v = (JSON.parse(await readFile(pkg, "utf8")) as { version?: unknown }).version;
          if (typeof v === "string") return { path: found, version: v };
        } catch {
          // try the next layout
        }
      }
      return { path: found };
    }
    try {
      const v = (await execFileText(found, ["--version"], 5000)).trim();
      return v === "" ? { path: found } : { path: found, version: v };
    } catch {
      return { path: found };
    }
  };
}

export function spawnGateProbe(command: readonly string[]): GateProbe {
  const [file, ...args] = command;
  return (root, payload) =>
    new Promise((resolve, reject) => {
      if (file === undefined) {
        reject(new Error("empty gate command"));
        return;
      }
      const t0 = performance.now();
      const child = spawn(file, [...args, "gate", "--stdin"], {
        cwd: root,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), GATE_HOOK_TIMEOUT_MS * 2);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ ms: performance.now() - t0, exit: code ?? -1 });
      });
      child.stdin.end(payload);
    });
}

function p95(samples: readonly number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0;
}

async function readJsonFile(abs: string): Promise<{ doc?: unknown; error?: string } | undefined> {
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { error: (err as Error).message };
  }
  try {
    return { doc: JSON.parse(text) as unknown };
  } catch (err) {
    return { error: `not valid JSON: ${(err as Error).message}` };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function copilotHookWired(doc: unknown): boolean {
  if (!isRecord(doc) || !isRecord(doc.hooks) || !Array.isArray(doc.hooks.preToolUse)) return false;
  return doc.hooks.preToolUse.some((h) => {
    if (!isRecord(h)) return false;
    const cmd = [h.exec, ...(Array.isArray(h.args) ? h.args : []), h.bash, h.powershell, h.command]
      .filter((x): x is string => typeof x === "string")
      .join(" ");
    return /\baxiom\b/.test(cmd) && /\bgate\b/.test(cmd) && !/\bnpx\b/.test(cmd);
  });
}

function claudeHookWired(doc: unknown): boolean {
  if (!isRecord(doc) || !isRecord(doc.hooks) || !Array.isArray(doc.hooks.PreToolUse)) return false;
  return doc.hooks.PreToolUse.some(
    (e) =>
      isRecord(e) &&
      Array.isArray(e.hooks) &&
      e.hooks.some(
        (h) =>
          isRecord(h) &&
          typeof h.command === "string" &&
          /\baxiom\b.*\bgate\b/.test(h.command) &&
          !/\bnpx\b/.test(h.command),
      ),
  );
}

async function checkBin(opts: DoctorOptions): Promise<DoctorCheck> {
  const bin = await (opts.locateBin ?? defaultBinLocator())();
  if (bin === undefined) {
    return check(
      "bin",
      "warn",
      "global `axiom` is not on PATH — hooks calling `axiom gate` will fail (and harnesses fail open)",
      "npm install -g @codai/axiom-mcp",
    );
  }
  if (bin.version === undefined) {
    return check("bin", "warn", `axiom at ${bin.path}; version unknown`);
  }
  if (bin.version !== opts.version) {
    return check(
      "bin",
      "warn",
      `global axiom ${bin.version} (${bin.path}) differs from this CLI ${opts.version}`,
      "npm install -g @codai/axiom-mcp@latest",
    );
  }
  return check("bin", "ok", `axiom ${bin.version} at ${bin.path}`);
}

async function checkHooks(root: string): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let wired = 0;
  const hookFiles: [string, string, (d: unknown) => boolean][] = [
    ["hook.copilot", INIT_FILES.copilotHook, copilotHookWired],
    ["hook.claude", INIT_FILES.claudeSettings, claudeHookWired],
  ];
  for (const [id, rel, wiredFn] of hookFiles) {
    const r = await readJsonFile(path.join(root, rel));
    if (r === undefined) continue;
    if (r.error !== undefined) {
      out.push(
        check(id, "fail", `${rel}: ${r.error}`, "fix the JSON or re-run `axiom init --force`"),
      );
    } else if (wiredFn(r.doc)) {
      wired++;
      out.push(check(id, "ok", `${rel} runs \`axiom gate --stdin\``));
    } else {
      out.push(
        check(
          id,
          "warn",
          `${rel} has no \`axiom gate --stdin\` PreToolUse entry (npx entries do not count: they time out)`,
          id === "hook.claude"
            ? `add ${JSON.stringify(CLAUDE_HOOK_ENTRY)} to hooks.PreToolUse`
            : "axiom init --force",
        ),
      );
    }
  }
  if (wired === 0 && out.length === 0) {
    out.push(
      check("hook", "warn", "no PreToolUse hook config found for any harness", "axiom init"),
    );
  }
  const mcp = await readJsonFile(path.join(root, INIT_FILES.mcp));
  if (mcp !== undefined) {
    if (mcp.error !== undefined) {
      out.push(check("mcp.vscode", "warn", `${INIT_FILES.mcp}: ${mcp.error}`));
    } else {
      const has =
        isRecord(mcp.doc) && isRecord(mcp.doc.servers) && mcp.doc.servers.axiom !== undefined;
      out.push(
        has
          ? check("mcp.vscode", "ok", `${INIT_FILES.mcp} declares servers.axiom`)
          : check("mcp.vscode", "warn", `${INIT_FILES.mcp} has no servers.axiom`, "axiom init"),
      );
    }
  }
  return out;
}

async function checkLatency(opts: DoctorOptions): Promise<DoctorCheck> {
  const probe =
    opts.probe ?? (opts.gateCommand === undefined ? undefined : spawnGateProbe(opts.gateCommand));
  if (probe === undefined) {
    return check("gate.latency", "warn", "cannot locate this CLI's entry; latency not measured");
  }
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "axiom-doctor-probe.txt", content: "probe\n" },
    cwd: opts.root,
  });
  const samples: number[] = [];
  const exits = new Set<number>();
  try {
    for (let i = 0; i < GATE_PROBE_RUNS; i++) {
      const r = await probe(opts.root, payload);
      samples.push(r.ms);
      exits.add(r.exit);
    }
  } catch (err) {
    return check("gate.latency", "fail", `gate probe did not run: ${(err as Error).message}`);
  }
  const p = Math.round(p95(samples));
  const msg = `gate --stdin p95 ${p} ms over ${GATE_PROBE_RUNS} runs (hook timeout ${GATE_HOOK_TIMEOUT_MS} ms)`;
  if (p > GATE_P95_FAIL_MS) {
    return check(
      "gate.latency",
      "fail",
      msg,
      "the harness will kill the hook and fail OPEN; check machine load / antivirus on node",
    );
  }
  if (!exits.has(0)) {
    return check(
      "gate.latency",
      "warn",
      `${msg}; a benign Write was denied (exit ${[...exits].join(",")})`,
      "check .axiom/gate-profile.json deny/allow globs",
    );
  }
  return check("gate.latency", "ok", msg);
}

async function checkProfiles(root: string): Promise<DoctorCheck[]> {
  const dir = path.join(root, ".axiom", "profiles");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    names = [];
  }
  const out: DoctorCheck[] = [];
  if (names.length === 0) {
    out.push(
      check(
        "profile",
        "warn",
        "no .axiom/profiles/*.json — builtin `default` applies",
        "axiom init",
      ),
    );
  }
  for (const f of names.sort()) {
    const name = f.slice(0, -".json".length);
    try {
      const p = await loadProfile(name, { searchDirs: [dir] });
      out.push(check(`profile.${name}`, "ok", `${name}: ${p.checks.length} checks`));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "ERR_INTERNAL";
      out.push(
        check(
          `profile.${name}`,
          "fail",
          `${f}: ${code} ${(err as Error).message}`,
          "fix the profile",
        ),
      );
    }
  }
  const gp = await readJsonFile(path.join(root, INIT_FILES.gateProfile));
  if (gp !== undefined) {
    const parsed = gp.error === undefined ? GateProfileSchema.safeParse(gp.doc) : undefined;
    if (parsed?.success === true) {
      out.push(check("gate.profile", "ok", `${INIT_FILES.gateProfile} valid`));
    } else {
      out.push(
        check(
          "gate.profile",
          "fail",
          `${INIT_FILES.gateProfile} invalid — the gate denies every write (fail-closed)`,
          "fix the file or re-run `axiom init --force`",
        ),
      );
    }
  }
  return out;
}

async function checkGitignore(root: string): Promise<DoctorCheck> {
  let text = "";
  try {
    text = await readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    // absent → not covered
  }
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const covered = [".axiom", ".axiom/", ".axiom/*", ".axiom/**", "/.axiom", "/.axiom/"].some((l) =>
    lines.has(l),
  );
  return covered
    ? check("gitignore", "ok", ".gitignore covers .axiom/")
    : check(
        "gitignore",
        "warn",
        ".gitignore does not ignore .axiom/ (journal, CAS, backups would be committed)",
        `append: ${GITIGNORE_LINES.join(" ")}`,
      );
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const st = await stat(opts.root).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    checks.push(check("root", "fail", `${opts.root} is not a directory`, "pass --root <dir>"));
    return { root: opts.root, ok: false, checks };
  }
  // Canonical root, same as init/apply (CI: /var → /private/var, Windows 8.3 short names).
  const root = await realDir(path.resolve(opts.root), "ERR_ROOT_NOT_DIR");
  checks.push(check("root", "ok", root));
  checks.push(await checkBin(opts));
  checks.push(...(await checkHooks(root)));

  const lock = await lockStatus(root);
  if (!lock.held) checks.push(check("lock", "ok", "lock free"));
  else if (lock.holder?.stale === true) {
    checks.push(
      check(
        "lock",
        "warn",
        `stale lock held by pid ${lock.holder.pid}${lock.holder.host === undefined ? "" : `@${lock.holder.host}`}`,
        "the next apply reclaims a stale lock; `axiom status` shows the holder",
      ),
    );
  } else {
    checks.push(
      check("lock", "ok", `lock held by live pid ${lock.holder?.pid ?? "?"} (apply in progress)`),
    );
  }

  const js = await journalStatus(root);
  if (js.interrupted.length > 0) {
    checks.push(
      check(
        "journal",
        "fail",
        `${js.interrupted.length} interrupted journal(s): ${js.interrupted.map((j) => `${j.manifestDigest} (${j.phase})`).join(", ")}`,
        `axiom rollback ${js.interrupted[0]?.manifestDigest ?? "<digest>"} --root ${root} (the next apply also recovers automatically)`,
      ),
    );
  } else if (js.corrupt.length > 0) {
    checks.push(
      check(
        "journal",
        "fail",
        `corrupt journal file(s): ${js.corrupt.join(", ")}`,
        "inspect .axiom/journal/ (skill debug-apply-journal)",
      ),
    );
  } else {
    checks.push(check("journal", "ok", "no interrupted journals"));
  }

  const chain = await verifyChain(root);
  checks.push(
    chain.ok
      ? check("chain", "ok", `journal chain ok (${chain.entries} entries)`)
      : check(
          "chain",
          "fail",
          `ERR_JOURNAL_CHAIN at #${chain.firstBad?.seq} (${chain.firstBad?.reason})`,
          `axiom verify --journal --root ${root}`,
        ),
  );

  checks.push(...(await checkProfiles(root)));
  checks.push(await checkGitignore(root));
  checks.push(await checkLatency(opts));
  return { root, ok: !checks.some((c) => c.status === "fail"), checks };
}
