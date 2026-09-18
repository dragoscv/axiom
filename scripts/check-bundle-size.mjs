#!/usr/bin/env node
/**
 * check-bundle-size — the published bin `packages/mcp/dist/cli.js` PLUS the
 * chunk it lazy-loads (`cli-main.js`) must stay ≤ 950 KB together (PLAN.md
 * D-11). Summing both keeps the budget honest: a thin entry alone is not the bin.
 * Measured, not estimated.
 *
 * What is summed = `cli.js` + `cli-main.js` + every chunk reached from them by
 * a STATIC `import … from "./x.js"` (tsdown/rolldown splits shared code such as
 * schema+zod into hashed `dist-*.js` chunks; those load on every invocation and
 * are budgeted). Chunks reached only through a dynamic `import("./x.js")` are
 * NOT budgeted: the `.axm` parser (`@codai/axiom-axm`, chevrotain ≈ 250 KB) is
 * loaded that way by the `axiom_axm_parse` tool and the `compile <file.axm>`
 * verb only, so callers who never touch `.axm` never pay for it. Lazy chunks are
 * listed in the note so a regression to eager loading is visible in the sum.
 *
 * Skips with OK+note when dist is absent (fresh checkout); `--strict` (CI,
 * after build) turns the skip into a failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exists, REPO_ROOT, report, STRICT } from "./_guard-lib.mjs";

const LIMIT_BYTES = 950 * 1024;
const dist = join(REPO_ROOT, "packages", "mcp", "dist");
const target = join(dist, "cli.js");
const entries = ["cli.js", "cli-main.js"];

if (!exists(target)) {
  report("bundle-size", STRICT ? ["packages/mcp/dist/cli.js missing — run pnpm build first"] : [], {
    notes: ["skipped: packages/mcp/dist/cli.js not built"],
    skipped: true,
  });
}

/** Static (eager) imports of sibling chunks; dynamic `import("./…")` is deliberately excluded. */
function staticImports(file) {
  const src = readFileSync(join(dist, file), "utf8");
  return [
    ...src.matchAll(/^import\b[^\n]*?from\s+["']\.\/([^"']+)["']|^import\s+["']\.\/([^"']+)["']/gm),
  ]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);
}

const eager = new Set();
const queue = entries.filter((f) => exists(join(dist, f)));
while (queue.length > 0) {
  const f = queue.shift();
  if (eager.has(f)) continue;
  eager.add(f);
  for (const dep of staticImports(f)) if (exists(join(dist, dep))) queue.push(dep);
}
// `cli.js` lazy-loads `cli-main.js` on purpose (thin --version entry); both are always budgeted.
const chunks = [...eager];
const parts = chunks.map((f) => [f, statSync(join(dist, f)).size]);
const size = parts.reduce((n, [, b]) => n + b, 0);
const kb = (size / 1024).toFixed(1);
const lazy = readdirSync(dist)
  .filter((f) => f.endsWith(".js") && !eager.has(f) && f !== "index.js")
  .map((f) => `${f} ${(statSync(join(dist, f)).size / 1024).toFixed(1)} KB`);
const problems =
  size > LIMIT_BYTES
    ? [
        `packages/mcp/dist/{${chunks.join(",")}} eager total ${kb} KB > ${LIMIT_BYTES / 1024} KB limit`,
      ]
    : [];

report("bundle-size", problems, {
  notes: [
    `${parts.map(([f, b]) => `${f} ${(b / 1024).toFixed(1)} KB`).join(" + ")} = ${kb} KB (limit ${LIMIT_BYTES / 1024} KB)`,
    ...(lazy.length > 0 ? [`lazy chunks (not budgeted): ${lazy.join(", ")}`] : []),
  ],
  stats: { bytes: size, limitBytes: LIMIT_BYTES, parts: Object.fromEntries(parts) },
});
