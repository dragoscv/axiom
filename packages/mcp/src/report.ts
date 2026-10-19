/**
 * `axiom report` (3.0, I-10): one self-contained static HTML page over the decision journal —
 * totals, decisions per day and per code (inline SVG bars with a table fallback), relaxed /
 * override reasons (redacted again at render time, for journals written before 3.0), the most
 * judged paths and gate latency p50/p95. No external assets: inline CSS, system fonts,
 * `prefers-color-scheme` light/dark, colours chosen for WCAG 2.2 AA contrast on both schemes.
 *
 * Read-only on the root; the only write is `--out`. Never writes to stdout except through
 * `io.stdout` (the CLI passes console output; MCP never calls this).
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { isAxiomError } from "@codai/axiom-schema";
import { type DecisionRecord, readDecisions, redactText } from "./decisions.js";
import { createRootsPolicy, resolveRoot } from "./roots.js";
import { harnessOf, type StatsBucket, summarizeDecisions } from "./stats.js";

export interface ReportIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd?: string;
  now?: () => number;
}

export interface ReportData {
  root: string;
  days: number;
  since: string;
  generatedAt: string;
  totals: StatsBucket;
  byDay: { day: string; allow: number; deny: number; ask: number }[];
  byCode: { code: string; count: number }[];
  byHarness: { harness: string; count: number }[];
  relaxed: {
    decided_at: string;
    kind: "warn" | "override";
    code: string;
    reason: string;
    paths: string;
  }[];
  topPaths: { path: string; count: number; deny: number }[];
}

const DAY_MS = 86_400_000;
const RELAXED_MAX = 200;
const TOP_PATHS = 20;

function dayOf(iso: string): string | undefined {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** Aggregate journal records into report data (pure). */
export function buildReport(
  records: readonly DecisionRecord[],
  o: { root: string; days: number; now: number },
): ReportData {
  const sinceMs = o.now - o.days * DAY_MS;
  const inWindow = records.filter((r) => {
    const t = Date.parse(r.decided_at);
    return !Number.isNaN(t) && t >= sinceMs && t <= o.now;
  });
  const days = new Map<string, { allow: number; deny: number; ask: number }>();
  const firstDay = Date.parse(new Date(sinceMs).toISOString().slice(0, 10));
  for (let t = firstDay; t <= o.now; t += DAY_MS) {
    days.set(new Date(t).toISOString().slice(0, 10), { allow: 0, deny: 0, ask: 0 });
  }
  const codes = new Map<string, number>();
  const harnesses = new Map<string, number>();
  const paths = new Map<string, { count: number; deny: number }>();
  const relaxed: ReportData["relaxed"] = [];
  for (const r of inWindow) {
    const d = dayOf(r.decided_at);
    const slot = d === undefined ? undefined : days.get(d);
    if (slot !== undefined) slot[r.decision]++;
    if (r.code !== undefined) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
    const h = harnessOf(r.agent_id);
    harnesses.set(h, (harnesses.get(h) ?? 0) + 1);
    for (const p of new Set(r.paths)) {
      const e = paths.get(p) ?? { count: 0, deny: 0 };
      e.count++;
      if (r.decision === "deny") e.deny++;
      paths.set(p, e);
    }
    if (r.relaxed !== undefined && relaxed.length < RELAXED_MAX) {
      relaxed.push({
        decided_at: r.decided_at,
        kind: r.relaxed,
        code: r.code ?? "-",
        reason: redactText(r.override_reason ?? r.reason ?? ""),
        paths: r.paths.join(", "),
      });
    }
  }
  const byCount = <T extends { count: number }>(a: T, b: T, ka: string, kb: string): number =>
    b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0);
  return {
    root: o.root,
    days: o.days,
    since: new Date(sinceMs).toISOString(),
    generatedAt: new Date(o.now).toISOString(),
    totals: summarizeDecisions(inWindow),
    byDay: [...days.entries()].map(([day, v]) => ({ day, ...v })),
    byCode: [...codes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => byCount(a, b, a.code, b.code)),
    byHarness: [...harnesses.entries()]
      .map(([harness, count]) => ({ harness, count }))
      .sort((a, b) => byCount(a, b, a.harness, b.harness)),
    relaxed: relaxed.sort((a, b) => (a.decided_at < b.decided_at ? 1 : -1)),
    topPaths: [...paths.entries()]
      .map(([p, v]) => ({ path: p, ...v }))
      .sort((a, b) => byCount(a, b, a.path, b.path))
      .slice(0, TOP_PATHS),
  };
}

/** HTML-escape text and attribute values. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1a1a1a;--muted:#4a4a4a;--line:#d0d0d0;--card:#f5f5f5;
--allow:#1d6b35;--deny:#b3261e;--ask:#8a5300;--bar:#2f5d9e}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ededed;--muted:#b8b8b8;--line:#3a3a3a;
--card:#1e1e1e;--allow:#6fcf8a;--deny:#ff8a80;--ask:#ffc266;--bar:#8ab4f8}}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem;background:var(--bg);color:var(--fg);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:72rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}
.muted{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin-top:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.75rem}
.card b{display:block;font-size:1.4rem}
.allow{color:var(--allow)}.deny{color:var(--deny)}.ask{color:var(--ask)}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}
code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.85em;
overflow-wrap:anywhere}
svg{display:block;max-width:100%;height:auto}
svg text{fill:var(--fg);font-size:11px}
.r-allow{fill:var(--allow)}.r-deny{fill:var(--deny)}.r-ask{fill:var(--ask)}.r-bar{fill:var(--bar)}
details{margin-top:.5rem}
`;

function dayChart(byDay: ReportData["byDay"]): string {
  const max = Math.max(1, ...byDay.map((d) => d.allow + d.deny + d.ask));
  const colW = 36;
  const h = 160;
  const w = Math.max(colW * byDay.length + 40, 200);
  const bars = byDay
    .map((d, i) => {
      const x = 30 + i * colW;
      let y = h;
      const seg = (n: number, cls: string): string => {
        if (n === 0) return "";
        const bh = Math.max(1, Math.round((n / max) * (h - 20)));
        y -= bh;
        return `<rect class="${cls}" x="${x}" y="${y}" width="${colW - 8}" height="${bh}"></rect>`;
      };
      const total = d.allow + d.deny + d.ask;
      return `${seg(d.allow, "r-allow")}${seg(d.ask, "r-ask")}${seg(d.deny, "r-deny")}<text x="${x}" y="${h + 14}">${esc(d.day.slice(5))}</text><text x="${x}" y="${Math.max(10, y - 3)}">${total}</text>`;
    })
    .join("");
  const label = byDay.map((d) => `${d.day}: ${d.allow} allow, ${d.deny} deny, ${d.ask} ask`);
  return `<svg role="img" aria-label="${esc(`Decisions per day. ${label.join("; ")}`)}" viewBox="0 0 ${w} ${h + 20}" width="${w}">${bars}</svg>`;
}

function hbarChart(rows: { label: string; count: number }[], aria: string): string {
  if (rows.length === 0) return `<p class="muted">none</p>`;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const rowH = 20;
  const w = 640;
  const labelW = 220;
  const body = rows
    .map((r, i) => {
      const y = i * rowH;
      const bw = Math.max(1, Math.round((r.count / max) * (w - labelW - 50)));
      const label = r.label.length > 34 ? `${r.label.slice(0, 33)}...` : r.label;
      return `<text x="0" y="${y + 14}">${esc(label)}</text><rect class="r-bar" x="${labelW}" y="${y + 3}" width="${bw}" height="${rowH - 6}"></rect><text x="${labelW + bw + 6}" y="${y + 14}">${r.count}</text>`;
    })
    .join("");
  return `<svg role="img" aria-label="${esc(aria)}" viewBox="0 0 ${w} ${rows.length * rowH}" width="${w}">${body}</svg>`;
}

function ms(v: number | null): string {
  return v === null ? "-" : `${v} ms`;
}

/** The whole report as one HTML document (no external references). */
export function renderReportHtml(d: ReportData): string {
  const t = d.totals;
  const card = (label: string, value: string, cls = ""): string =>
    `<div class="card"><span class="muted">${esc(label)}</span><b class="${cls}">${esc(value)}</b></div>`;
  const dayRows = d.byDay
    .map(
      (r) =>
        `<tr><td>${esc(r.day)}</td><td class="n">${r.allow}</td><td class="n">${r.deny}</td><td class="n">${r.ask}</td></tr>`,
    )
    .join("");
  const codeRows = d.byCode
    .map((r) => `<tr><td><code>${esc(r.code)}</code></td><td class="n">${r.count}</td></tr>`)
    .join("");
  const relaxedRows = d.relaxed
    .map(
      (r) =>
        `<tr><td>${esc(r.decided_at)}</td><td>${esc(r.kind)}</td><td><code>${esc(r.code)}</code></td><td>${esc(r.reason)}</td><td><code>${esc(r.paths)}</code></td></tr>`,
    )
    .join("");
  const pathRows = d.topPaths
    .map(
      (r) =>
        `<tr><td><code>${esc(r.path)}</code></td><td class="n">${r.count}</td><td class="n">${r.deny}</td></tr>`,
    )
    .join("");
  const harnessRows = d.byHarness
    .map((r) => `<tr><td>${esc(r.harness)}</td><td class="n">${r.count}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>AXIOM gate report - ${esc(path.basename(d.root))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>AXIOM gate report</h1>
<p class="muted"><code>${esc(d.root)}</code> - last ${d.days} day(s), since ${esc(d.since)}; generated ${esc(d.generatedAt)}</p>
<section aria-labelledby="h-totals">
<h2 id="h-totals">Totals</h2>
<div class="cards">
${card("decisions", String(t.total))}${card("allow", String(t.allow), "allow")}${card("deny", String(t.deny), "deny")}${card("ask", String(t.ask), "ask")}${card("relaxed (warn/override)", String(t.relaxed))}${card("latency p50", ms(t.p50))}${card("latency p95", ms(t.p95))}
</div>
</section>
<section aria-labelledby="h-days">
<h2 id="h-days">Decisions per day</h2>
<p class="muted"><span class="allow">allow</span> / <span class="ask">ask</span> / <span class="deny">deny</span></p>
${dayChart(d.byDay)}
<details><summary>Table</summary>
<table><thead><tr><th scope="col">day</th><th scope="col">allow</th><th scope="col">deny</th><th scope="col">ask</th></tr></thead><tbody>${dayRows}</tbody></table>
</details>
</section>
<section aria-labelledby="h-codes">
<h2 id="h-codes">Decisions by code</h2>
${hbarChart(
  d.byCode.map((r) => ({ label: r.code, count: r.count })),
  `Decisions by code. ${d.byCode.map((r) => `${r.code}: ${r.count}`).join("; ")}`,
)}
<details><summary>Table</summary>
<table><thead><tr><th scope="col">code</th><th scope="col">count</th></tr></thead><tbody>${codeRows}</tbody></table>
</details>
</section>
<section aria-labelledby="h-harness">
<h2 id="h-harness">By harness</h2>
<table><thead><tr><th scope="col">harness</th><th scope="col">decisions</th></tr></thead><tbody>${harnessRows}</tbody></table>
</section>
<section aria-labelledby="h-relaxed">
<h2 id="h-relaxed">Relaxed decisions (warn / override)</h2>
${
  d.relaxed.length === 0
    ? `<p class="muted">none</p>`
    : `<table><thead><tr><th scope="col">decided at</th><th scope="col">kind</th><th scope="col">code</th><th scope="col">reason (redacted)</th><th scope="col">paths</th></tr></thead><tbody>${relaxedRows}</tbody></table>`
}
</section>
<section aria-labelledby="h-paths">
<h2 id="h-paths">Top paths</h2>
${
  d.topPaths.length === 0
    ? `<p class="muted">none</p>`
    : `<table><thead><tr><th scope="col">path</th><th scope="col">judged</th><th scope="col">denied</th></tr></thead><tbody>${pathRows}</tbody></table>`
}
</section>
</main>
</body>
</html>
`;
}

/** `axiom report [--root <dir>] [--days 7] --out <file.html> [--json]`. Exit 0 ok, 1 error, 2 usage. */
export async function reportMain(argv: readonly string[], io: ReportIo): Promise<number> {
  let values: { root?: string; days?: string; out?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        days: { type: "string" },
        out: { type: "string", short: "o" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.stderr(`axiom report: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    io.stderr("axiom report: --days must be an integer 1..3660");
    return 2;
  }
  if (values.out === undefined && values.json !== true) {
    io.stderr("axiom report: --out <file.html> is required (or --json)");
    return 2;
  }
  try {
    const cwd = io.cwd ?? process.cwd();
    const policy = await createRootsPolicy([path.resolve(cwd, values.root ?? ".")]);
    const { rootReal } = await resolveRoot(policy);
    const now = (io.now ?? Date.now)();
    const data = buildReport(await readDecisions(rootReal), { root: rootReal, days, now });
    if (values.out !== undefined) {
      const out = path.resolve(cwd, values.out);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, renderReportHtml(data), "utf8");
      if (values.json !== true) {
        io.stdout(`axiom report: ${data.totals.total} decision(s) in ${days} day(s) -> ${out}`);
      }
    }
    if (values.json === true) io.stdout(JSON.stringify(data, null, 2));
    return 0;
  } catch (err) {
    const code = isAxiomError(err) ? err.code : "ERR_INTERNAL";
    io.stderr(`axiom report: ${code}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
