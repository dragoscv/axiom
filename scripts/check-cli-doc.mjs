#!/usr/bin/env node
/**
 * check-cli-doc - docs/reference/cli.md must equal what `scripts/gen-cli-doc.mjs` would write
 * from the CLI command table (D-43). Needs the built `packages/mcp/dist/cli-main.js`.
 *
 * Skips with OK+note when dist is absent; `--strict` fails instead.
 */
import { readFileSync } from "node:fs";
import { exists, report, STRICT } from "./_guard-lib.mjs";
import { CLI_DOC, CLI_MAIN, expectedCliDoc } from "./gen-cli-doc.mjs";

if (!exists(CLI_MAIN)) {
  report(
    "cli-doc",
    STRICT ? ["packages/mcp/dist/cli-main.js missing - run pnpm build first"] : [],
    {
      notes: ["skipped: packages/mcp/dist/cli-main.js not built"],
      skipped: true,
    },
  );
}

const problems = [];
let notes = [];
try {
  const current = readFileSync(CLI_DOC, "utf8").replaceAll("\r\n", "\n");
  const expected = await expectedCliDoc(current);
  if (expected !== current) {
    const a = current.split("\n");
    const b = expected.split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    problems.push(
      `docs/reference/cli.md is stale (first difference at line ${i + 1}) - run: node scripts/gen-cli-doc.mjs`,
    );
  } else {
    notes = ["docs/reference/cli.md matches the command table"];
  }
} catch (err) {
  problems.push(err instanceof Error ? err.message : String(err));
}
report("cli-doc", problems, { notes });
