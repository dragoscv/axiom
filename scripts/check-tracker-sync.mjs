#!/usr/bin/env node
/**
 * check-tracker-sync — PLAN.md and TRACKER.csv are the canonical tracker and
 * must stay in lockstep (PLAN.md header: "Update both files in the same
 * commit"). Checks:
 *   - TRACKER.csv parses with header id,type,phase,title,status,…
 *   - every status ∈ {todo,doing,done,blocked,dropped,open}
 *   - ids are unique and match /^(S|D)-\d+$/
 *   - every id in TRACKER.csv appears in PLAN.md and vice versa
 */
import { join } from "node:path";
import { REPO_ROOT, readText, report } from "./_guard-lib.mjs";

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

const counts = {};
for (const r of rows) counts[r[4]] = (counts[r[4]] ?? 0) + 1;

report("tracker-sync", problems, {
  notes: [
    `${csvIds.size} ids; ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  ],
  stats: { ids: csvIds.size, counts },
});
