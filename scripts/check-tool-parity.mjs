#!/usr/bin/env node
/**
 * check-tool-parity — the MCP tool registry (`packages/mcp/spec/tools.json`)
 * must be mirrored in `packages/mcp/README.md` and `docs/reference/mcp-tools.md`
 * (PLAN.md S-111: "check-tool-parity links docs ↔ registry"). A tool that
 * exists in code but not in docs is invisible to every integrator.
 *
 * Skips with a note while packages/mcp/spec/tools.json does not exist yet.
 * Accepts either `{ tools: [{ name }] }` or a bare array of tools.
 *
 * D-43 toolsets: every entry carries `toolset: "core" | "full"`; `spec/codai-tools.json` must
 * agree tool by tool; both docs must mention the core set. Counts come from the spec, never a
 * hard-coded number.
 */
import { join } from "node:path";
import { exists, REPO_ROOT, readJson, readText, report, STRICT } from "./_guard-lib.mjs";

const SPEC = join(REPO_ROOT, "packages", "mcp", "spec", "tools.json");
const CODAI_SPEC = join(REPO_ROOT, "packages", "mcp", "spec", "codai-tools.json");
const TOOLSETS = ["core", "full"];
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

const toolsetOf = new Map();
for (const t of list) {
  if (typeof t !== "object" || t === null) continue;
  if (!TOOLSETS.includes(t.toolset)) {
    problems.push(
      `tools.json: "${t.name}" has toolset ${JSON.stringify(t.toolset)} (want core|full)`,
    );
  } else toolsetOf.set(t.name, t.toolset);
}
const core = names.filter((n) => toolsetOf.get(n) === "core");
if (core.length === 0) problems.push('tools.json marks no tool `toolset: "core"`');

if (exists(CODAI_SPEC)) {
  const codai = readJson(CODAI_SPEC);
  const ctools = Array.isArray(codai?.tools) ? codai.tools : [];
  const cnames = ctools.map((t) => t?.name);
  if (cnames.join(",") !== names.join(",")) {
    problems.push(
      `codai-tools.json lists ${cnames.length} tools, tools.json ${names.length} (names/order differ)`,
    );
  }
  for (const t of ctools) {
    if (toolsetOf.has(t?.name) && t.toolset !== toolsetOf.get(t.name)) {
      problems.push(
        `codai-tools.json: "${t.name}" toolset ${JSON.stringify(t.toolset)} ≠ tools.json "${toolsetOf.get(t.name)}"`,
      );
    }
  }
} else problems.push("packages/mcp/spec/codai-tools.json missing");

for (const [label, path] of DOCS) {
  if (!exists(path)) {
    problems.push(`${label} missing — every tool must be documented there`);
    continue;
  }
  const text = readText(path);
  for (const n of names) {
    if (!text.includes(n)) problems.push(`${label}: tool "${n}" not mentioned`);
  }
  if (!text.includes("--tools full")) {
    problems.push(`${label}: does not document the \`--tools full\` toolset switch (D-43)`);
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
  notes: [
    `${names.length} tools (${core.length} core, ${names.length - core.length} full-only) cross-checked against ${DOCS.length} docs + codai-tools.json`,
  ],
  stats: { tools: names, core },
});
