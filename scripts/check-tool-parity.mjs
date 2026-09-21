#!/usr/bin/env node
/**
 * check-tool-parity — the MCP tool registry (`packages/mcp/spec/tools.json`)
 * must be mirrored in `packages/mcp/README.md` and `docs/reference/mcp-tools.md`
 * (PLAN.md S-111: "check-tool-parity links docs ↔ registry"). A tool that
 * exists in code but not in docs is invisible to every integrator.
 *
 * Skips with a note while packages/mcp/spec/tools.json does not exist yet.
 * Accepts either `{ tools: [{ name }] }` or a bare array of tools.
 */
import { join } from "node:path";
import { exists, REPO_ROOT, readJson, readText, report, STRICT } from "./_guard-lib.mjs";

const SPEC = join(REPO_ROOT, "packages", "mcp", "spec", "tools.json");
const DOCS = [
  ["packages/mcp/README.md", join(REPO_ROOT, "packages", "mcp", "README.md")],
  ["docs/reference/mcp-tools.md", join(REPO_ROOT, "docs", "reference", "mcp-tools.md")],
];

if (!exists(SPEC)) {
  report("tool-parity", STRICT ? ["packages/mcp/spec/tools.json missing"] : [], {
    notes: ["skipped: packages/mcp/spec/tools.json not present yet"],
    skipped: true,
  });
}

const raw = readJson(SPEC);
const list = Array.isArray(raw) ? raw : Array.isArray(raw.tools) ? raw.tools : null;
if (!list) report("tool-parity", ["tools.json must be an array or { tools: [...] }"]);
const names = list.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
const problems = [];
if (names.length === 0) problems.push("tools.json lists zero tools");

for (const [label, path] of DOCS) {
  if (!exists(path)) {
    problems.push(`${label} missing — every tool must be documented there`);
    continue;
  }
  const text = readText(path);
  for (const n of names) {
    if (!text.includes(n)) problems.push(`${label}: tool "${n}" not mentioned`);
  }
}

// Reverse direction: a tool documented but not registered is a stale promise.
const docsMd = DOCS.filter(([, p]) => exists(p))
  .map(([, p]) => readText(p))
  .join("\n");
for (const m of new Set([...docsMd.matchAll(/\baxiom_[a-z_]+\b/g)].map((x) => x[0]))) {
  if (!names.includes(m)) problems.push(`docs mention "${m}" but tools.json does not register it`);
}

report("tool-parity", problems, {
  notes: [`${names.length} tools cross-checked against ${DOCS.length} docs`],
  stats: { tools: names },
});
