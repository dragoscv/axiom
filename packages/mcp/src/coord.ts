/**
 * Coordination adapter (v2.6, S-1212, D-39): a generic FILE protocol through which the gate
 * honours an external coordinator — the house tool `agentq` is the reference mapping
 * (`AGENTQ_EXAMPLE`, docs/integration/agentq.md). Three rules:
 *
 * - `coord.frozen` — a mark (`<marksDir>/*.json`, `{resource, state, reason, at, session}`) in
 *   state `frozen`/`blocked` refuses commands of its resource class (`build|install|commit|deploy`)
 *   for this repo (or `machine` = every repo). `deploy:<repo>:<target>` only refuses commands
 *   naming `<target>` unless the target is `any`.
 * - `coord.leased` — a lease (`<leasesDir>/<repo>/<slot>.json`, `{path, leaseId, session,
 *   purpose}`) protects its slot root: a delete-class command naming it, or a recursive delete of
 *   its parent / `slotsRoot`, is refused unless it goes through the sanctioned tools.
 * - `coord.queueRequired` — commands of a class must go through a wrapper (`via` regex).
 *
 * Mirrors `guard-tooluse.ps1` (leases ~L85-135, marks ~L215-250). Never spawns, never throws.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { RuleVerdict } from "./gate-verdict.js";
import { gitDirs } from "./gitfacts.js";

export type CommandClass = "build" | "install" | "commit" | "deploy";

const COMMAND_CLASSES = ["build", "install", "commit", "deploy"] as const;

// ------------------------------------------------------------ command classes --

const BUILD_RE: RegExp[] = [
  /\b(?:pnpm|npm|yarn|turbo|next|tsc|cargo|gradlew?)\b[^;|&\n]*\b(?:build|typecheck|test)\b/i,
  /run-build\.ps1/i,
];
const COMMIT_RE = /(?:^|[;&|({]\s*)git(?:\.exe)?\b[^;|&\n]*\s(?:commit|push)\b/i;
const INSTALL_RE = /\b(?:pnpm|npm|yarn)\s+(?:install|i|ci|add|remove)\b/i;
/** The guard's mark-class deploy regex plus its whole `$isDeploy` list. */
const DEPLOY_RE: RegExp[] = [
  /deploy-clean\.ps1|deploy-[a-z0-9-]+\.(?:ps1|mjs)|scripts[\\/]deploy\.mjs/i,
  /\bgcloud\s+(?:run|builds)\b/i,
  /\bgcloud\s+run\s+(?:services\s+(?:replace|update|deploy)|deploy)\b/i,
  /\bgcloud\s+builds\s+submit\b/i,
  /\bgcloud\s+run\s+jobs\s+(?:deploy|update|replace|create)\b/i,
  /\bvercel\b/i,
  /\bterraform\s+apply\b/i,
  /\bdocker\s+(?:build|buildx\s+build|push)\b/i,
  /\bfly\s+deploy\b/i,
  /\bwrangler\s+(?:deploy|publish)\b/i,
  /\bpulumi\s+up\b/i,
  /\bcargo\s+(?:tauri\s+build|publish)\b/i,
  /\b(?:npm|pnpm)\s+publish\b/i,
  /\btwine\s+upload\b|\bhatch\s+publish\b/i,
  /\bgradlew?\b[^;|&\n]*\b(?:assembleRelease|bundleRelease|publish)\b/i,
  /scripts[\\/]ops[\\/]deploy-[a-z0-9-]+\.ps1/i,
];

/** Resource classes `command` belongs to (a command can be several, e.g. build + deploy). */
export function commandClasses(command: string): CommandClass[] {
  const out: CommandClass[] = [];
  if (BUILD_RE.some((r) => r.test(command))) out.push("build");
  if (COMMIT_RE.test(command)) out.push("commit");
  if (INSTALL_RE.test(command)) out.push("install");
  if (DEPLOY_RE.some((r) => r.test(command))) out.push("deploy");
  return out;
}

// --------------------------------------------------------------------- schema --

function validRegex(source: string): boolean {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

const RegexSource = z.string().min(1).max(500).refine(validRegex, { message: "invalid regex" });

export const CoordinationSchema = z.strictObject({
  /** Directory of mark files (`*.json`). `~` and `${env:NAME}` are expanded. */
  marksDir: z.string().min(1).optional(),
  /** Directory of lease files (`<repo>/<slot>.json`). */
  leasesDir: z.string().min(1).optional(),
  /** Root of the worktree slots (`<slotsRoot>/<repo>/<slot>`); a lease without `path` uses it. */
  slotsRoot: z.string().min(1).optional(),
  /** Regex sources: a command matching any is exempt from marks, leases and the queue rule. */
  exemptVia: z.array(RegexSource).default(["agentq\\.ps1"]),
  /** Commands of `class` must match `via` (the sanctioned wrapper); `fix` is shown on refusal. */
  queueRequired: z
    .array(
      z.strictObject({
        class: z.enum(COMMAND_CLASSES),
        via: RegexSource,
        fix: z.string().min(1),
      }),
    )
    .default([]),
  /** Repo name override (default: leaf of the parent of the git common dir, lowercased). */
  repo: z.string().min(1).optional(),
});

export type CoordinationConfig = z.infer<typeof CoordinationSchema>;

/** The house mapping for agentq (`~/.copilot/bin/agentq.ps1`). */
export const AGENTQ_EXAMPLE: CoordinationConfig = {
  marksDir: "~/.codai/coord/marks",
  leasesDir: "~/.codai/coord/leases",
  // agentq honours CODAI_WT_ROOT; without it the slots live in E:/gh/.wt (see the docs).
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a ${env:} placeholder for expandPath
  slotsRoot: "${env:CODAI_WT_ROOT:-E:/gh/.wt}",
  exemptVia: ["agentq\\.ps1"],
  queueRequired: [
    {
      class: "build",
      via: "run-build\\.ps1|agentq\\.ps1",
      fix: "pwsh -NoProfile -File \"$env:USERPROFILE\\.copilot\\hooks\\run-build.ps1\" -Purpose '<why>' -Command '<build command>'",
    },
    {
      class: "install",
      via: "agentq\\.ps1",
      fix: "pwsh -NoProfile -File \"$env:USERPROFILE\\.copilot\\bin\\agentq.ps1\" run -Resource install -Purpose '<why>' -- pnpm install",
    },
    {
      class: "commit",
      via: "agentq\\.ps1[^;|&\\n]*\\scommit\\b",
      fix: "pwsh -NoProfile -File \"$env:USERPROFILE\\.copilot\\bin\\agentq.ps1\" commit -Purpose '<why>' -Message '<type(scope): msg>' -Paths a.ts,b.ts",
    },
  ],
};

// ---------------------------------------------------------------------- paths --

/** `~` → home, `${env:NAME}` → value (unset/empty → `""`), `${env:NAME:-fallback}` → fallback. */
export function expandPath(p: string, home: string, env: NodeJS.ProcessEnv): string {
  let out = p.replace(
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_m, name: string, fallback: string | undefined) => {
      const v = env[name];
      return v !== undefined && v !== "" ? v : (fallback ?? "");
    },
  );
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) out = home + out.slice(1);
  return out;
}

/** Comparable form: forward slashes, no trailing slash, lowercased on Windows-style paths. */
function normPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s.toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `p` named as a whole path (followed by an optional slash, then a quote, space or end). */
function mentions(segment: string, p: string): boolean {
  return new RegExp(`${escapeRe(p)}/?(?:['"\\s]|$)`).test(segment);
}

// ---------------------------------------------------------------------- state --

class StateError extends Error {}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw new StateError(`cannot stat ${dir}`);
  }
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new StateError(`cannot read ${file}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StateError(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

async function repoName(root: string, cfg: CoordinationConfig): Promise<string | undefined> {
  if (cfg.repo !== undefined) return cfg.repo.toLowerCase();
  const d = await gitDirs(root).catch(() => undefined);
  if (d === undefined) return undefined;
  return path.basename(path.dirname(path.resolve(d.commonDir))).toLowerCase();
}

function failClosed(id: string, what: string): RuleVerdict {
  return {
    id,
    reason: `The coordination state (${what}) could not be read, so the command is refused (fail closed).`,
    fix: "Repair or remove the unreadable coordination file, then retry.",
  };
}

// ---------------------------------------------------------------------- marks --

async function evaluateMarks(
  command: string,
  classes: readonly CommandClass[],
  dir: string,
  root: string,
  cfg: CoordinationConfig,
): Promise<RuleVerdict | undefined> {
  if (!(await dirExists(dir))) return undefined;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".json")).sort();
  } catch {
    throw new StateError(`cannot list ${dir}`);
  }
  if (names.length === 0 || classes.length === 0) return undefined;
  const repo = await repoName(root, cfg);
  for (const name of names) {
    const m = await readJsonFile(path.join(dir, name));
    const resource = str(m.resource);
    if (resource === undefined) throw new StateError(`${name} has no resource`);
    const state = (str(m.state) ?? "").toLowerCase();
    if (state !== "frozen" && state !== "blocked") continue;
    const [kind, mRepo, target] = resource.split(":");
    const repoOk =
      mRepo === undefined ||
      mRepo === "" ||
      mRepo === "machine" ||
      (repo !== undefined && mRepo.toLowerCase() === repo);
    if (!repoOk || !classes.includes(kind as CommandClass)) continue;
    if (kind === "deploy" && target !== undefined && target !== "any") {
      if (!command.toLowerCase().includes(target.toLowerCase())) continue;
    }
    const since = str(m.at) ?? "?";
    const by = str(m.session) ?? "?";
    return {
      id: "coord.frozen",
      reason: `${resource} is ${state.toUpperCase()} since ${since} by ${by}: ${str(m.reason) ?? "(no reason)"}. Do not bypass a freeze.`,
      fix: `Check the coordinator status; clear the mark only if the reason no longer holds (resource ${resource}).`,
    };
  }
  return undefined;
}

// --------------------------------------------------------------------- leases --

const DELETE_WORD = /\b(?:Remove-Item|rm|rmdir|rd|del|ri|erase)\b/i;
const DELETE_ANY = [
  DELETE_WORD,
  /\bgit\b[^;|&\n]*\bworktree\s+(?:remove|move|prune)\b/i,
  /\[IO\.Directory\]::Delete|Directory\.Delete|rmSync|rimraf/i,
];
const DELETE_SEGMENT =
  /\b(?:Remove-Item|rm|rmdir|rd|del|ri|erase)\b|worktree\s+(?:remove|move|prune)|Directory\.Delete|rmSync|rimraf/i;
const RECURSIVE = /-Recurse|-r\b|\/s\b|-rf?\b|recursive/i;
const LEASE_TOOLS = /(?:worktree|agentq|deploy-clean)\.ps1/i;

interface Lease {
  path: string;
  who: string;
}

async function readLeases(dir: string, slotsRoot: string | undefined): Promise<Lease[]> {
  let repos: string[];
  try {
    repos = await readdir(dir);
  } catch {
    throw new StateError(`cannot list ${dir}`);
  }
  const out: Lease[] = [];
  for (const repo of repos.sort()) {
    const repoDir = path.join(dir, repo);
    const st = await stat(repoDir).catch(() => undefined);
    if (st?.isDirectory() !== true) continue;
    let files: string[];
    try {
      files = (await readdir(repoDir)).filter((f) => f.toLowerCase().endsWith(".json"));
    } catch {
      throw new StateError(`cannot list ${repoDir}`);
    }
    for (const f of files.sort()) {
      const j = await readJsonFile(path.join(repoDir, f));
      const slot = f.slice(0, -".json".length);
      const p =
        str(j.path) ??
        (slotsRoot !== undefined && slotsRoot !== ""
          ? path.join(slotsRoot, repo, slot)
          : undefined);
      if (p === undefined) throw new StateError(`${repo}/${f} has no path and no slotsRoot is set`);
      out.push({
        path: p,
        who: `${str(j.session) ?? "?"} (${str(j.leaseId) ?? "?"}) '${str(j.purpose) ?? ""}'`,
      });
    }
  }
  return out;
}

async function evaluateLeases(
  command: string,
  dir: string,
  slotsRoot: string | undefined,
): Promise<RuleVerdict | undefined> {
  if (!DELETE_ANY.some((r) => r.test(command)) || LEASE_TOOLS.test(command)) return undefined;
  if (!(await dirExists(dir))) return undefined;
  const leases = await readLeases(dir, slotsRoot);
  if (leases.length === 0) return undefined;
  // Judge each statement on its own (`rmdir /s X; ls <slotsRoot>` is not a delete of slotsRoot).
  const segments = command
    .replace(/\\/g, "/")
    .toLowerCase()
    .split(/;|&&|\|\||\r?\n/)
    .filter((s) => DELETE_SEGMENT.test(s));
  const rootN = slotsRoot !== undefined && slotsRoot !== "" ? normPath(slotsRoot) : undefined;
  for (const l of leases) {
    const lp = normPath(l.path);
    const parent = normPath(path.dirname(l.path.replace(/\\/g, "/")));
    for (const seg of segments) {
      const hitsSlot = mentions(seg, lp);
      const hitsParent =
        (mentions(seg, parent) || (rootN !== undefined && mentions(seg, rootN))) &&
        RECURSIVE.test(seg);
      if (hitsSlot || hitsParent) {
        return {
          id: "coord.leased",
          reason: `'${l.path}' is a LEASED worktree slot held by ${l.who}; deleting it destroys another agent's live work.`,
          path: l.path.replace(/\\/g, "/"),
          fix: "Release your own slot with the coordinator (it backs up, then frees); stale leases expire on their own.",
        };
      }
    }
  }
  return undefined;
}

// --------------------------------------------------------------------- public --

/**
 * Coordination rules for `command` (run in the checkout at `ctx.root`): `coord.leased`, then
 * `coord.frozen`, then `coord.queueRequired`. `undefined` = no opinion (also when a configured
 * dir does not exist). Never throws: any other read failure is a fail-closed verdict.
 */
export async function evaluateCoordination(
  command: string,
  cfg: CoordinationConfig,
  ctx: { root: string; home?: string; env?: NodeJS.ProcessEnv },
): Promise<RuleVerdict | undefined> {
  const home = ctx.home ?? homedir();
  const env = ctx.env ?? process.env;
  const expand = (p: string | undefined): string | undefined =>
    p === undefined ? undefined : expandPath(p, home, env);
  let exempt = false;
  try {
    exempt = (cfg.exemptVia ?? []).some((src) => new RegExp(src, "i").test(command));
  } catch {
    return failClosed("coord.frozen", "exemptVia regex");
  }
  if (exempt) return undefined;
  const slotsRoot = expand(cfg.slotsRoot);

  const leasesDir = expand(cfg.leasesDir);
  if (leasesDir !== undefined && leasesDir !== "") {
    try {
      const v = await evaluateLeases(command, leasesDir, slotsRoot);
      if (v !== undefined) return v;
    } catch {
      return failClosed("coord.leased", "leases");
    }
  }

  const classes = commandClasses(command);
  const marksDir = expand(cfg.marksDir);
  if (marksDir !== undefined && marksDir !== "") {
    try {
      const v = await evaluateMarks(command, classes, marksDir, ctx.root, cfg);
      if (v !== undefined) return v;
    } catch {
      return failClosed("coord.frozen", "marks");
    }
  }

  for (const q of cfg.queueRequired ?? []) {
    if (!classes.includes(q.class)) continue;
    let via: boolean;
    try {
      via = new RegExp(q.via, "i").test(command);
    } catch {
      return failClosed("coord.queueRequired", "queueRequired regex");
    }
    if (!via) {
      return {
        id: "coord.queueRequired",
        reason: `${q.class} commands must go through the coordination queue, not run directly.`,
        fix: q.fix,
      };
    }
  }
  return undefined;
}
