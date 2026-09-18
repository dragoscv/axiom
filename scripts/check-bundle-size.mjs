#!/usr/bin/env node
/**
 * check-bundle-size — the published bin `packages/mcp/dist/cli.js` PLUS the
 * chunk it lazy-loads (`cli-main.js`) must stay ≤ 950 KB together (PLAN.md
 * D-11). Summing both keeps the budget honest: a thin entry alone is not the bin.
 * Measured, not estimated.
 *
 * Skips with OK+note when dist is absent (fresh checkout); `--strict` (CI,
 * after build) turns the skip into a failure.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { exists, REPO_ROOT, report, STRICT } from "./_guard-lib.mjs";

const LIMIT_BYTES = 950 * 1024;
const dist = join(REPO_ROOT, "packages", "mcp", "dist");
const target = join(dist, "cli.js");
const chunks = ["cli.js", "cli-main.js"];

if (!exists(target)) {
  report("bundle-size", STRICT ? ["packages/mcp/dist/cli.js missing — run pnpm build first"] : [], {
    notes: ["skipped: packages/mcp/dist/cli.js not built"],
    skipped: true,
  });
}

const parts = chunks
  .filter((f) => exists(join(dist, f)))
  .map((f) => [f, statSync(join(dist, f)).size]);
const size = parts.reduce((n, [, b]) => n + b, 0);
const kb = (size / 1024).toFixed(1);
const problems =
  size > LIMIT_BYTES
    ? [`packages/mcp/dist/{${chunks.join(",")}} total ${kb} KB > ${LIMIT_BYTES / 1024} KB limit`]
    : [];

report("bundle-size", problems, {
  notes: [
    `${parts.map(([f, b]) => `${f} ${(b / 1024).toFixed(1)} KB`).join(" + ")} = ${kb} KB (limit ${LIMIT_BYTES / 1024} KB)`,
  ],
  stats: { bytes: size, limitBytes: LIMIT_BYTES, parts: Object.fromEntries(parts) },
});
