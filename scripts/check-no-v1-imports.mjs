#!/usr/bin/env node
/**
 * check-no-v1-imports — packages/_v1 is a frozen archive of the 1.x code; v2
 * packages must never import from it (its manifest hash was not content-bound,
 * its apply had no rollback). Any `import`/`export … from` or `require(` whose
 * specifier contains `_v1` fails.
 */
import { join } from "node:path";
import { lineOf, REPO_ROOT, readText, rel, report, walk } from "./_guard-lib.mjs";

const SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']*_v1[^"']*)["']/g;

const problems = [];
let files = 0;
for (const file of walk(join(REPO_ROOT, "packages"), (r) =>
  /\/src\/.*\.(ts|mts|cts|js|mjs)$/.test(r),
)) {
  files++;
  const src = readText(file);
  for (const m of src.matchAll(SPEC)) {
    problems.push(`${rel(file)}:${lineOf(src, m.index)}: imports legacy "${m[1]}"`);
  }
}

report("no-v1-imports", problems, { notes: [`${files} files scanned`], stats: { files } });
