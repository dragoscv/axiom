/**
 * `axiom stats` (v2.6, S-1211): what did the gate decide for this root, how fast, per harness —
 * and is it silent somewhere it should be running? Read-only: the decision journal
 * (`.axiom/decisions.jsonl`), the newest VS Code hook log session and the Copilot CLI session
 * event logs. Never throws for missing files; never writes to stdout (the CLI prints the lines).
 *
 * Claude Code is deliberately absent from `logs`: its transcripts
 * (`~/.claude/projects/<encoded-cwd>/*.jsonl`) carry no verifiable hook-run records on the
 * machines this was built on, so there is nothing honest to parse. Its gate decisions still show
 * up under `decisions.byHarness.claude` when the profile records.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { type DecisionRecord, readDecisions } from "./decisions.js";
import {
  type CliHookRun,
  copilotCliSessionDir,
  findCopilotCliEventLogs,
  findHookLogs,
  GATE_SILENT_MIN_RUNS,
  type HookRun,
  parseCopilotCliHookRuns,
  parseHookRuns,
  readTail,
  runsForRoot,
  samePathLoose,
  summarizeRuns,
} from "./hooklog.js";

export interface StatsBucket {
  total: number;
  allow: number;
  deny: number;
  ask: number;
  shadowDiffs: number;
  /** 2.7: allowed although a check fired (`warn` mode or an agent override). */
  relaxed: number;
  p50: number | null;
  p95: number | null;
  codes: Record<string, number>;
}

export interface HarnessLogStats {
  harness: string;
  files: string[];
  hookRuns: number;
  gateRuns: number;
  silent: boolean;
  nonBlockingErrors?: number;
  p50?: number;
  p95?: number;
}

export type StatsAlarmId = "gate.silent" | "gate.nonBlocking" | "gate.slow" | "decisions.empty";

export interface StatsResult {
  root: string;
  since?: string;
  decisions: StatsBucket & {
    byHarness: Record<string, StatsBucket>;
    byTool: Record<string, StatsBucket>;
    post: StatsBucket;
  };
  logs: HarnessLogStats[];
  alarms: { id: StatsAlarmId; harness?: string; message: string }[];
}

export interface CollectStatsOptions {
  root: string;
  since?: string;
  home?: string;
  appData?: string;
  platform?: NodeJS.Platform;
  /** VS Code hook log files (default: the newest VS Code log session). */
  hookLogs?: readonly string[];
  /** Reserved: Claude Code transcripts carry no verifiable hook-run records (see module doc). */
  claudeProjectsDir?: string;
  /** Copilot CLI `session-state` dir (default `<home>/.copilot/session-state`). */
  copilotLogsDir?: string;
}

/** gate.slow threshold on a harness log's gate p95. */
export const GATE_SLOW_P95_MS = 4000;

/** Nearest-rank on sorted samples at index `floor((n-1)*q)` (scripts/check-gate-latency.mjs). */
function rank(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * q)] ?? null;
}

function emptyBucket(): StatsBucket {
  return {
    total: 0,
    allow: 0,
    deny: 0,
    ask: 0,
    shadowDiffs: 0,
    relaxed: 0,
    p50: null,
    p95: null,
    codes: {},
  };
}

/** One bucket over records: only allow/deny/ask decisions count; unknown decisions are ignored. */
export function summarizeDecisions(records: readonly DecisionRecord[]): StatsBucket {
  const b = emptyBucket();
  const ms: number[] = [];
  for (const r of records) {
    const decision: string = r.decision;
    if (decision !== "allow" && decision !== "deny" && decision !== "ask") continue;
    b.total++;
    b[decision]++;
    if (r.shadow === true && decision !== "allow") b.shadowDiffs++;
    if (r.relaxed !== undefined && decision === "allow") b.relaxed++;
    if (r.code !== undefined) b.codes[r.code] = (b.codes[r.code] ?? 0) + 1;
    if (typeof r.ms === "number" && Number.isFinite(r.ms)) ms.push(r.ms);
  }
  ms.sort((a, c) => a - c);
  b.p50 = rank(ms, 0.5);
  b.p95 = rank(ms, 0.95);
  return b;
}

function groupBy(
  records: readonly DecisionRecord[],
  key: (r: DecisionRecord) => string,
): Record<string, StatsBucket> {
  const groups = new Map<string, DecisionRecord[]>();
  for (const r of records) {
    const k = key(r);
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [r]);
    else g.push(r);
  }
  const out: Record<string, StatsBucket> = {};
  for (const k of [...groups.keys()].sort()) out[k] = summarizeDecisions(groups.get(k) ?? []);
  return out;
}

/** `agent_id` is `<harness>:<session>`; the harness is everything before the first `:`. */
export function harnessOf(agentId: string): string {
  const i = agentId.indexOf(":");
  const h = i < 0 ? agentId : agentId.slice(0, i);
  return h === "" ? "unknown" : h;
}

const SINCE_REL_RE = /^(\d+)([dhm])$/;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** ISO passthrough (normalised), or `7d` / `12h` / `30m` before `now` → ISO. Invalid → throws. */
export function parseSince(v: string, now: number = Date.now()): string {
  const s = v.trim();
  const rel = SINCE_REL_RE.exec(s);
  if (rel !== null) {
    const n = Number(rel[1]);
    const unit = UNIT_MS[rel[2] ?? ""] ?? 0;
    return new Date(now - n * unit).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  throw new Error(`invalid --since "${v}": expected an ISO date or <n>d / <n>h / <n>m`);
}

async function rootAliases(root: string): Promise<string[]> {
  const out = [path.resolve(root)];
  const real = await realpath(root).catch(() => undefined);
  if (real !== undefined && !out.some((p) => samePathLoose(p, real))) out.push(real);
  return out;
}

async function vscodeLogStats(
  o: CollectStatsOptions,
  aliases: readonly string[],
): Promise<HarnessLogStats | undefined> {
  const files =
    o.hookLogs ??
    (await findHookLogs({
      ...(o.home === undefined ? {} : { home: o.home }),
      ...(o.appData === undefined ? {} : { appData: o.appData }),
      ...(o.platform === undefined ? {} : { platform: o.platform }),
    }));
  if (files.length === 0) return undefined;
  const all: HookRun[] = [];
  for (const f of files) {
    try {
      all.push(...parseHookRuns(await readTail(f)));
    } catch {
      // rotated / locked — skip
    }
  }
  const mine = all.filter((r) => aliases.some((a) => runsForRoot([r], a).length === 1));
  const s = summarizeRuns(mine);
  return {
    harness: "vscode",
    files: [...files],
    hookRuns: s.preToolUseRuns,
    gateRuns: s.runs,
    silent: s.runs === 0 && s.preToolUseRuns >= GATE_SILENT_MIN_RUNS,
    nonBlockingErrors: s.nonBlockingErrors,
    ...(s.runs > 0 ? { p50: s.p50, p95: s.p95 } : {}),
  };
}

async function copilotCliLogStats(
  o: CollectStatsOptions,
  aliases: readonly string[],
): Promise<HarnessLogStats | undefined> {
  const dir = o.copilotLogsDir ?? copilotCliSessionDir(o.home ?? homedir());
  const sinceMs = o.since === undefined ? undefined : Date.parse(o.since);
  const okSince = sinceMs !== undefined && !Number.isNaN(sinceMs) ? sinceMs : undefined;
  const files = await findCopilotCliEventLogs(
    dir,
    okSince === undefined ? {} : { sinceMs: okSince },
  );
  if (files.length === 0) return undefined;
  const used: string[] = [];
  const mine: CliHookRun[] = [];
  for (const f of files) {
    let runs: CliHookRun[];
    try {
      runs = parseCopilotCliHookRuns(await readTail(f));
    } catch {
      continue;
    }
    const hits = runs.filter(
      (r) =>
        r.hookType === "preToolUse" &&
        r.cwd !== undefined &&
        aliases.some((a) => samePathLoose(r.cwd ?? "", a)) &&
        (okSince === undefined || r.at === undefined || Date.parse(r.at) >= okSince),
    );
    if (hits.length === 0) continue;
    used.push(f);
    mine.push(...hits);
  }
  if (mine.length === 0) return undefined;
  const gate = mine.filter((r) => r.gate);
  // A successful Copilot CLI invocation names no hook file, so 0 gate runs is NOT evidence of a
  // silent gate here: only gate errors are attributable.
  return {
    harness: "copilot-cli",
    files: used,
    hookRuns: mine.length,
    gateRuns: gate.length,
    silent: false,
    nonBlockingErrors: gate.length,
  };
}

async function profileRecords(root: string): Promise<boolean> {
  try {
    const doc = JSON.parse(await readFile(path.join(root, ".axiom", "gate-profile.json"), "utf8"));
    return typeof doc === "object" && doc !== null && (doc as { record?: unknown }).record === true;
  } catch {
    return false;
  }
}

export async function collectStats(o: CollectStatsOptions): Promise<StatsResult> {
  const root = path.resolve(o.root);
  let records: DecisionRecord[];
  try {
    records = await readDecisions(root, o.since === undefined ? {} : { since: o.since });
  } catch {
    records = [];
  }
  const post = records.filter((r) => r.phase === "post");
  const decisions = {
    ...summarizeDecisions(records),
    byHarness: groupBy(records, (r) => harnessOf(r.agent_id)),
    byTool: groupBy(records, (r) => r.tool),
    post: summarizeDecisions(post),
  };

  const aliases = await rootAliases(root);
  const logs: HarnessLogStats[] = [];
  for (const l of [await vscodeLogStats(o, aliases), await copilotCliLogStats(o, aliases)]) {
    if (l !== undefined) logs.push(l);
  }

  const alarms: StatsResult["alarms"] = [];
  for (const l of logs) {
    if (l.silent) {
      alarms.push({
        id: "gate.silent",
        harness: l.harness,
        message: `${l.hookRuns} PreToolUse hook runs for this root, 0 of them the axiom gate - run \`axiom setup init\`, trust the workspace, reload the window`,
      });
    }
    if ((l.nonBlockingErrors ?? 0) > 0) {
      alarms.push({
        id: "gate.nonBlocking",
        harness: l.harness,
        message: `${l.nonBlockingErrors} gate run(s) errored instead of deciding - check the hook command resolves (\`axiom setup doctor\`)`,
      });
    }
    if (l.p95 !== undefined && l.p95 > GATE_SLOW_P95_MS) {
      alarms.push({
        id: "gate.slow",
        harness: l.harness,
        message: `gate p95 ${l.p95} ms > ${GATE_SLOW_P95_MS} ms - consider \`axiom setup init --daemon\` or check machine load`,
      });
    }
  }
  if (records.length === 0 && (await profileRecords(root))) {
    alarms.push({
      id: "decisions.empty",
      message:
        "gate profile has record: true but no decisions were journaled in the window - the gate is not running for this root",
    });
  }

  return { root, ...(o.since === undefined ? {} : { since: o.since }), decisions, logs, alarms };
}

function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : `${v} ms`;
}

function bucketLine(label: string, b: StatsBucket): string {
  const extra = [
    b.ask > 0 ? ` ask ${b.ask}` : "",
    b.shadowDiffs > 0 ? ` shadow ${b.shadowDiffs}` : "",
  ];
  return `${label}: ${b.total} (allow ${b.allow}, deny ${b.deny}${extra.join("")}) p50 ${ms(b.p50)} p95 ${ms(b.p95)}`;
}

/** Human lines for the CLI (no trailing newlines). */
export function renderStats(s: StatsResult): string[] {
  const d = s.decisions;
  const lines = [`axiom stats - ${s.root}${s.since === undefined ? "" : ` since ${s.since}`}`];
  lines.push(bucketLine("decisions", d));
  const codes = Object.entries(d.codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (codes.length > 0) lines.push(`  codes: ${codes.map(([c, n]) => `${c} ${n}`).join(", ")}`);
  for (const [h, b] of Object.entries(d.byHarness)) lines.push(bucketLine(`  harness ${h}`, b));
  for (const [t, b] of Object.entries(d.byTool)) lines.push(bucketLine(`  tool ${t}`, b));
  if (d.post.total > 0) lines.push(bucketLine("  post-tool checks", d.post));
  if (s.logs.length === 0) lines.push("harness logs: none found");
  for (const l of s.logs) {
    const lat = l.p95 === undefined ? "" : ` p50 ${ms(l.p50)} p95 ${ms(l.p95)}`;
    const err = l.nonBlockingErrors ? ` errors ${l.nonBlockingErrors}` : "";
    lines.push(
      `log ${l.harness}: ${l.hookRuns} PreToolUse hook runs, ${l.gateRuns} gate runs${err}${lat} (${l.files.length} file(s))`,
    );
  }
  if (s.alarms.length === 0) lines.push("alarms: none");
  for (const a of s.alarms) {
    lines.push(`ALARM ${a.id}${a.harness === undefined ? "" : ` [${a.harness}]`}: ${a.message}`);
  }
  return lines;
}
