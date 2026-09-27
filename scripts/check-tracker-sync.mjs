#!/usr/bin/env node
/**
 * check-tracker-sync — PLAN.md and TRACKER.csv are the canonical tracker and
 * must stay in lockstep (PLAN.md header: "Update both files in the same
 * commit"). Checks:
 *   - TRACKER.csv parses with header id,type,phase,title,status,…
 *   - every status ∈ {todo,doing,done,blocked,dropped,open}
 *   - ids are unique and match /^(S|D)-\d+$/
 *   - every id in TRACKER.csv appears in PLAN.md and vice versa
 *   - status parity (S-707): for every PLAN.md table row whose first cell is
 *     an id and whose status cell is explicit, the status equals TRACKER.csv's.
 *     Story tables: the `Status` column, leading word (`done (…)`,
 *     `**blocked upstream**` → blocked). Decision tables: the `Chosen` column,
 *     `**decided …**` → done. Rows with no recognisable status are skipped.
 *
 * Usage: node scripts/check-tracker-sync.mjs [--self-test] [--json]
 */
import { join } from "node:path";
import { args, REPO_ROOT, readText, report } from "./_guard-lib.mjs";

const STATUSES = new Set(["todo", "doing", "done", "blocked", "dropped", "open"]);
const ID = /^(S|D)-\d+$/;
const REQUIRED_HEAD = ["id", "type", "phase", "title", "status"];

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

/**
 * Split a GFM table row into trimmed cells. `\|` and pipes inside backtick
 * code spans do not split (PLAN.md cells quote shell pipes and CLI syntax).
 */
export function splitRow(line) {
  const cells = [];
  let cell = "";
  let tick = 0;
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      let run = 0;
      while (s[i] === "`") {
        run++;
        i++;
      }
      i--;
      cell += "`".repeat(run);
      if (tick === 0) tick = run;
      else if (tick === run) tick = 0;
    } else if (c === "|" && tick === 0) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/** Normalise a PLAN.md status cell to a tracker status, or null if not explicit. */
export function planStatus(cell, kind) {
  const t = cell.replace(/\*\*/g, "").trim().toLowerCase();
  if (kind === "decision") return /^decided\b/.test(t) ? "done" : /^open\b/.test(t) ? "open" : null;
  const w = t.match(/^([a-z]+)/)?.[1];
  return w && STATUSES.has(w) ? w : null;
}

/** Map id → { status, line } for every PLAN.md table row with an explicit status. */
export function planStatuses(text) {
  const out = new Map();
  let col = -1;
  let kind = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trimStart().startsWith("|")) {
      col = -1;
      return;
    }
    const cells = splitRow(line);
    if (cells[0] === "ID") {
      const lower = cells.map((c) => c.toLowerCase());
      col = lower.indexOf("chosen");
      kind = col >= 0 ? "decision" : "story";
      if (col < 0) col = lower.indexOf("status");
      return;
    }
    if (col < 0 || !ID.test(cells[0] ?? "")) return;
    const status = planStatus(cells[col] ?? "", kind);
    if (status && !out.has(cells[0])) out.set(cells[0], { status, line: i + 1 });
  });
  return out;
}

function selfTest() {
  const md = [
    "| ID | Story | Status |",
    "|----|-------|--------|",
    "| S-001 | a `x | y` pipe | todo |",
    "| S-002 | esc \\| pipe | **blocked upstream** — why |",
    "| S-003 | b | done (after publish) |",
    "| S-004 | c | see notes |",
    "",
    "| ID | Decision | Options | Chosen | Rationale / status |",
    "|----|----|----|----|----|",
    "| D-01 | d | `a|b` | **decided (2026-09-18): A** | r |",
    "| D-02 | e | o | pending | r |",
  ].join("\n");
  const got = Object.fromEntries([...planStatuses(md)].map(([k, v]) => [k, v.status]));
  const want = { "S-001": "todo", "S-002": "blocked", "S-003": "done", "D-01": "done" };
  const bad =
    JSON.stringify(got) === JSON.stringify(want) ? [] : [`self-test: got ${JSON.stringify(got)}`];
  const csvRow = parseCsv('S-1,story,1,"a, ""b""",done\n')[0] ?? [];
  if (csvRow.length !== 5 || csvRow[3] !== 'a, "b"')
    bad.push(`self-test: csv ${JSON.stringify(csvRow)}`);
  report("tracker-sync", bad, { notes: ["self-test 7 cases"] });
}

if (args.has("--self-test")) selfTest();

const problems = [];
const csv = readText(join(REPO_ROOT, "TRACKER.csv"));
const plan = readText(join(REPO_ROOT, "PLAN.md"));
const rows = parseCsv(csv);
const head = rows.shift() ?? [];

REQUIRED_HEAD.forEach((col, i) => {
  if (head[i] !== col)
    problems.push(`TRACKER.csv header column ${i + 1} must be "${col}", got "${head[i] ?? ""}"`);
});

const csvIds = new Map();
rows.forEach((r, i) => {
  const ln = i + 2;
  const [id, , , title, status] = r;
  if (r.length !== head.length)
    problems.push(`TRACKER.csv:${ln}: ${r.length} fields, header has ${head.length}`);
  if (!ID.test(id ?? "")) problems.push(`TRACKER.csv:${ln}: bad id "${id}"`);
  else if (csvIds.has(id))
    problems.push(`TRACKER.csv:${ln}: duplicate id ${id} (first at line ${csvIds.get(id)})`);
  else csvIds.set(id, ln);
  if (!STATUSES.has(status ?? ""))
    problems.push(
      `TRACKER.csv:${ln}: ${id} status "${status}" not in {${[...STATUSES].join(",")}}`,
    );
  if (!title) problems.push(`TRACKER.csv:${ln}: ${id} has empty title`);
});

const planIds = new Set([...plan.matchAll(/\b([SD]-\d{2,3})\b/g)].map((m) => m[1]));
for (const id of csvIds.keys())
  if (!planIds.has(id)) problems.push(`${id} is in TRACKER.csv but not in PLAN.md`);
for (const id of planIds)
  if (!csvIds.has(id)) problems.push(`${id} is in PLAN.md but not in TRACKER.csv`);

const csvStatus = new Map(rows.map((r) => [r[0], r[4]]));
const planStat = planStatuses(plan);
let compared = 0;
for (const [id, { status, line }] of planStat) {
  const tracked = csvStatus.get(id);
  if (tracked === undefined) continue;
  compared++;
  if (tracked !== status)
    problems.push(`${id}: PLAN=${status} TRACKER=${tracked} (PLAN.md:${line})`);
}

const counts = {};
for (const r of rows) counts[r[4]] = (counts[r[4]] ?? 0) + 1;

report("tracker-sync", problems, {
  notes: [
    `${csvIds.size} ids; ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}; ${compared} statuses compared`,
  ],
  stats: { ids: csvIds.size, counts, statusesCompared: compared },
});
