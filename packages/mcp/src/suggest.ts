/**
 * `axiom setup suggest-profile [--days 7] [--root <dir>] [--min <n>] [--json]` (3.0, I-3,
 * D-45): read the decision journal and PROPOSE gate-profile changes. Never writes the profile —
 * the output is a JSON-Patch-like list plus a human summary for the owner to apply by hand.
 *
 * Rules (each needs at least `min` occurrences, default 5):
 * - a code relaxed by warn mode and never overridden → keep it at warn (do not harden it);
 * - a code repeatedly overridden with the same reason on the same paths → candidate `ask` glob
 *   (a human decides, instead of the agent waving it through);
 * - PII-class `content.noSecrets.*` hits concentrated (>= 80 %) in tests / fixtures / scratch
 *   → `noSecretsExclude` globs (the profile key lands with S-1313);
 * - a destructive command that was let through (warn / override) → add its code to `hard`.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type DecisionRecord, readDecisions } from "./decisions.js";
import { ascii, type CliIo } from "./fleet.js";
import { isHardCode, loadGateProfileForRoot } from "./gate.js";
import { realDir } from "./roots.js";

export const SUGGEST_MIN_DEFAULT = 5;
export const SUGGEST_DAYS_DEFAULT = 7;
/** Share of a noSecrets code's hits that must sit in test/scratch paths. */
export const SCRATCH_SHARE = 0.8;

/** PII-class noSecrets rules: noisy in fixtures. privateKey/awsKey/token stay everywhere. */
export const PII_CLASS = new Set([
  "content.noSecrets.email",
  "content.noSecrets.cnp",
  "content.noSecrets.phoneRo",
  "content.noSecrets.card",
  "content.noSecrets.credentialAssignment",
]);

/** Codes whose effect cannot be undone: never let them through by warn / override. */
export const DESTRUCTIVE_CODES = new Set([
  "house.resetHard",
  "house.cleanForce",
  "house.forcePush",
  "house.pushDelete",
  "git.destructiveTree",
]);

const SCRATCH_RE =
  /(^|\/)(tests?|__tests__|spec|fixtures?|__fixtures__|testdata|\.copilot-tmp|tmp|scratch)(\/|$)|\.(test|spec)\.[^/]+$/i;

export function isScratchPath(p: string): boolean {
  return SCRATCH_RE.test(p.replace(/\\/g, "/"));
}

/** A directory glob for a root-relative path: `a/b/c.ts` → `a/b/**`, `x.ts` → `x.ts`. */
export function globFor(p: string): string {
  const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segs.length <= 1) return segs[0] ?? p;
  return `${segs.slice(0, Math.min(2, segs.length - 1)).join("/")}/**`;
}

/** The glob covering a scratch path: up to and including its scratch segment. */
export function scratchGlobFor(p: string): string {
  const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
  const i = segs.findIndex((s) =>
    /^(tests?|__tests__|spec|fixtures?|__fixtures__|testdata|\.copilot-tmp|tmp|scratch)$/i.test(s),
  );
  if (i >= 0) return `${i === 0 ? "" : "**/"}${segs[i]}/**`;
  const base = segs[segs.length - 1] ?? p;
  const m = /\.(test|spec)\.([^.]+)$/i.exec(base);
  return m === null ? globFor(p) : `**/*.${m[1]?.toLowerCase()}.${m[2]}`;
}

export interface CodeStats {
  code: string;
  deny: number;
  ask: number;
  warn: number;
  override: number;
  /** Most frequent override reason (normalised) and its count. */
  topReason?: { reason: string; count: number };
  globs: Record<string, number>;
  scratchHits: number;
}

export interface PatchOp {
  op: "add";
  path: "/hard/-" | "/ask/-" | "/noSecretsExclude/-";
  value: string;
  why: string;
}

export interface SuggestResult {
  root: string;
  since: string;
  total: number;
  profile: string;
  codes: CodeStats[];
  keepWarn: string[];
  patch: PatchOp[];
  notes: string[];
}

function norm(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ");
}

export function aggregate(records: readonly DecisionRecord[]): CodeStats[] {
  const by = new Map<string, CodeStats & { reasons: Map<string, number> }>();
  for (const r of records) {
    const code = r.rule ?? r.code;
    if (code === undefined) continue;
    let s = by.get(code);
    if (s === undefined) {
      s = {
        code,
        deny: 0,
        ask: 0,
        warn: 0,
        override: 0,
        globs: {},
        scratchHits: 0,
        reasons: new Map(),
      };
      by.set(code, s);
    }
    if (r.relaxed === "warn") s.warn++;
    else if (r.relaxed === "override") {
      s.override++;
      if (r.override_reason !== undefined) {
        const k = norm(r.override_reason);
        s.reasons.set(k, (s.reasons.get(k) ?? 0) + 1);
      }
    } else if (r.decision === "deny") s.deny++;
    else if (r.decision === "ask") s.ask++;
    else continue;
    for (const p of r.paths) {
      if (p === ".") continue;
      const g = globFor(p);
      s.globs[g] = (s.globs[g] ?? 0) + 1;
    }
    if (r.paths.length > 0 && r.paths.every(isScratchPath)) s.scratchHits++;
  }
  return [...by.values()]
    .map(({ reasons, ...s }) => {
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return top === undefined ? s : { ...s, topReason: { reason: top[0], count: top[1] } };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

export interface ProfileView {
  hard: readonly string[];
  ask: readonly string[];
  noSecretsExclude?: readonly string[];
}

/** Pure proposal from journal records and the current profile. */
export function proposeProfile(
  records: readonly DecisionRecord[],
  current: ProfileView,
  min: number = SUGGEST_MIN_DEFAULT,
): { codes: CodeStats[]; keepWarn: string[]; patch: PatchOp[] } {
  const codes = aggregate(records);
  const patch: PatchOp[] = [];
  const keepWarn: string[] = [];
  const has = (list: readonly string[] | undefined, v: string) => list?.includes(v) === true;
  for (const s of codes) {
    if (
      DESTRUCTIVE_CODES.has(s.code) &&
      s.warn + s.override > 0 &&
      !isHardCode(current.hard, s.code)
    ) {
      patch.push({
        op: "add",
        path: "/hard/-",
        value: s.code,
        why: `${s.code} was let through ${s.warn + s.override} time(s) (warn/override); a destructive command must never be relaxable`,
      });
      continue;
    }
    if (s.warn >= min && s.override === 0) keepWarn.push(s.code);
    if (s.topReason !== undefined && s.topReason.count >= min) {
      for (const [g, n] of Object.entries(s.globs).sort((a, b) => b[1] - a[1])) {
        if (
          n < min ||
          has(current.ask, g) ||
          patch.some((p) => p.path === "/ask/-" && p.value === g)
        )
          continue;
        patch.push({
          op: "add",
          path: "/ask/-",
          value: g,
          why: `${s.code} overridden ${s.topReason.count} time(s) with the same reason ("${s.topReason.reason}"); ${n} hit(s) under ${g} - let a human decide instead`,
        });
      }
    }
    const hits = s.deny + s.ask + s.warn + s.override;
    if (PII_CLASS.has(s.code) && hits >= min && s.scratchHits / hits >= SCRATCH_SHARE) {
      const globs = new Set<string>();
      for (const r of records) {
        if ((r.rule ?? r.code) !== s.code) continue;
        for (const p of r.paths) if (isScratchPath(p)) globs.add(scratchGlobFor(p));
      }
      for (const g of [...globs].sort()) {
        if (
          has(current.noSecretsExclude, g) ||
          patch.some((p) => p.path === "/noSecretsExclude/-" && p.value === g)
        )
          continue;
        patch.push({
          op: "add",
          path: "/noSecretsExclude/-",
          value: g,
          why: `${s.code}: ${s.scratchHits} of ${hits} hit(s) in tests/fixtures/scratch`,
        });
      }
    }
  }
  return { codes, keepWarn, patch };
}

export function renderSuggest(r: SuggestResult): string[] {
  const lines = [
    `axiom suggest-profile: ${r.total} decision(s) since ${r.since} (profile ${r.profile})`,
    "proposal only - nothing was written",
  ];
  if (r.codes.length === 0) lines.push("no deny / ask / warn / override decisions to learn from");
  for (const c of r.codes) {
    lines.push(
      `  ${c.code}: deny ${c.deny}, ask ${c.ask}, warn ${c.warn}, override ${c.override}${c.topReason === undefined ? "" : ` (top reason x${c.topReason.count}: ${c.topReason.reason})`}`,
    );
  }
  for (const k of r.keepWarn) lines.push(`keep warn: ${k} (relaxed often, never overridden)`);
  if (r.patch.length === 0) lines.push("no profile change proposed");
  for (const p of r.patch)
    lines.push(`propose ${p.op} ${p.path} ${JSON.stringify(p.value)} - ${p.why}`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.map(ascii);
}

export const SUGGEST_USAGE =
  "usage: axiom setup suggest-profile [--days 7] [--min 5] [--root <dir>] [--json]";

function intArg(v: string | undefined, def: number, max: number): number | undefined {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= max ? n : undefined;
}

/** `axiom setup suggest-profile`. Exit 0 always on success (a proposal is advice), 2 usage. */
export async function suggestMain(argv: string[], io: CliIo & { now?: number }): Promise<number> {
  let values: { root?: string; days?: string; min?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        days: { type: "string" },
        min: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.stderr(`ERR_USAGE ${err instanceof Error ? err.message : String(err)}\n${SUGGEST_USAGE}`);
    return 2;
  }
  const days = intArg(values.days, SUGGEST_DAYS_DEFAULT, 3650);
  const min = intArg(values.min, SUGGEST_MIN_DEFAULT, 1_000_000);
  if (days === undefined || min === undefined) {
    io.stderr(`ERR_USAGE --days and --min take a positive integer\n${SUGGEST_USAGE}`);
    return 2;
  }
  let root: string;
  try {
    root = await realDir(path.resolve(values.root ?? "."), "ERR_ROOT_NOT_DIR");
  } catch {
    io.stderr(`ERR_ROOT_NOT_DIR ${ascii(path.resolve(values.root ?? "."))}`);
    return 2;
  }
  const since = new Date((io.now ?? Date.now()) - days * 86_400_000).toISOString();
  const records = await readDecisions(root, { since });
  const notes: string[] = [];
  let profileSource = "builtin";
  let view: ProfileView = { hard: [], ask: [] };
  try {
    const loaded = await loadGateProfileForRoot(
      root,
      io.home === undefined ? {} : { home: io.home },
    );
    profileSource = loaded.source;
    const raw = loaded.profile as typeof loaded.profile & { noSecretsExclude?: string[] };
    view = {
      hard: loaded.profile.hard,
      ask: loaded.profile.ask,
      ...(raw.noSecretsExclude === undefined ? {} : { noSecretsExclude: raw.noSecretsExclude }),
    };
  } catch (err) {
    notes.push(
      `current profile unreadable (${(err as { code?: string }).code ?? "ERR_INVALID_PROFILE"}): proposal ignores what it already has`,
    );
  }
  const p = proposeProfile(records, view, min);
  if (p.patch.some((x) => x.path === "/noSecretsExclude/-")) {
    notes.push(
      "noSecretsExclude needs a gate that knows the key (S-1313); older bins ignore it with a warning",
    );
  }
  const r: SuggestResult = {
    root,
    since,
    total: records.length,
    profile: profileSource,
    ...p,
    notes,
  };
  if (values.json === true) io.stdout(JSON.stringify(r, null, 2));
  else for (const l of renderSuggest(r)) io.stdout(l);
  return 0;
}
