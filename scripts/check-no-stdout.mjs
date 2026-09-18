#!/usr/bin/env node
/**
 * check-no-stdout — MCP stdio servers own stdout for JSON-RPC. Any stray
 * `console.log(` or `process.stdout.write(` in library code corrupts the
 * transport. Only `packages/mcp/src/cli.ts` and `cli-main.ts` (the CLI verbs)
 * may write to stdout; everything else logs to stderr. Root `scripts/**` is out of scope
 * (guards print to stdout by contract).
 */
import { join } from "node:path";
import {
  lineOf,
  REPO_ROOT,
  readText,
  rel,
  report,
  stripStringsAndComments,
  walk,
} from "./_guard-lib.mjs";

const ALLOW = new Set(["packages/mcp/src/cli.ts", "packages/mcp/src/cli-main.ts"]);
const PATTERN = /\b(console\.log|console\.info|console\.debug|process\.stdout\.write)\s*\(/g;

const problems = [];
let files = 0;
for (const file of walk(join(REPO_ROOT, "packages"), (r) => /\/src\/.*\.ts$/.test(r))) {
  const r = rel(file);
  if (ALLOW.has(r)) continue;
  files++;
  const code = stripStringsAndComments(readText(file));
  for (const m of code.matchAll(PATTERN)) {
    problems.push(
      `${r}:${lineOf(code, m.index)}: ${m[1]}( writes to stdout — use console.error/warn`,
    );
  }
}

report("no-stdout", problems, { notes: [`${files} files scanned`], stats: { files } });
