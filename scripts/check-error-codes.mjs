#!/usr/bin/env node
/**
 * check-error-codes — every `ERR_*` string literal used anywhere in
 * packages/(star)/src (not _v1) must be a member of the closed enum
 * `ERROR_CODES` in packages/schema/src/errors.ts (PLAN.md §2: "All error codes
 * are a closed enum").
 *
 * Also fails if the enum itself cannot be parsed — a silently empty set would
 * make the guard vacuous. For the "unknown literal" rule `*.test.ts` files are
 * skipped: tests legitimately use made-up codes ("ERR_NOPE") to prove
 * `isErrorCode()` rejects them. Node's own `ERR_*` errno codes (util.parseArgs
 * etc.) are allowlisted by prefix.
 *
 * S-407 hygiene: every enum member must be RAISED in some `src` file and
 * ASSERTED in some behavioural test (a `*.test.ts` other than `errors.test.ts`,
 * which only lists the enum). A code nobody raises is dead; a code nobody
 * asserts has an untested failure path.
 */
import { join } from "node:path";
import { REPO_ROOT, readText, rel, report, walk } from "./_guard-lib.mjs";

const ERRORS_TS = join(REPO_ROOT, "packages", "schema", "src", "errors.ts");
const src = readText(ERRORS_TS);
const block = /export const ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
if (!block) {
  report("error-codes", ["cannot find `export const ERROR_CODES = [...] as const` in errors.ts"]);
}
const known = new Set([...block[1].matchAll(/"(ERR_[A-Z0-9_]+)"/g)].map((m) => m[1]));
if (known.size === 0) {
  report("error-codes", ["ERROR_CODES parsed as empty — guard would be vacuous"]);
}

const LITERAL = /(["'`])(ERR_[A-Z0-9_]+)\1/g;
/** Node.js built-in error codes we compare against, not ours. */
const NODE_BUILTIN_PREFIXES = ["ERR_PARSE_ARGS", "ERR_INVALID_ARG", "ERR_MODULE_NOT_FOUND"];
const problems = [];
let files = 0;
let refs = 0;
const usedCodes = new Set();
const assertedCodes = new Set();

for (const file of walk(
  join(REPO_ROOT, "packages"),
  (r) => /\/src\/.*\.ts$/.test(r) && !/\.test\.ts$/.test(r) && !/test-helpers/.test(r),
)) {
  if (file === ERRORS_TS) continue;
  const text = readText(file);
  files++;
  for (const m of text.matchAll(LITERAL)) {
    refs++;
    const code = m[2];
    if (NODE_BUILTIN_PREFIXES.some((p) => code.startsWith(p))) continue;
    usedCodes.add(code);
    if (!known.has(code)) {
      const line = text.slice(0, m.index).split("\n").length;
      problems.push(`${rel(file)}:${line}: "${code}" is not in ERROR_CODES (schema/src/errors.ts)`);
    }
  }
}

for (const file of walk(
  join(REPO_ROOT, "packages"),
  (r) => /\/src\/.*\.test\.ts$/.test(r) && !/errors\.test\.ts$/.test(r),
)) {
  for (const m of readText(file).matchAll(LITERAL)) assertedCodes.add(m[2]);
}

/** `ERR_INTERNAL` is the catch-all for invariant violations; it is asserted but never raised on purpose in a reachable path. */
const RAISE_EXEMPT = new Set(["ERR_INTERNAL"]);
const unraised = [...known].filter((c) => !usedCodes.has(c) && !RAISE_EXEMPT.has(c));
const unasserted = [...known].filter((c) => !assertedCodes.has(c));
for (const c of unraised)
  problems.push(`"${c}" is in ERROR_CODES but never raised in packages/*/src`);
for (const c of unasserted) {
  problems.push(
    `"${c}" is never asserted in a behavioural test (*.test.ts other than errors.test.ts)`,
  );
}

report("error-codes", problems, {
  notes: [
    `${known.size} codes in enum, ${refs} references across ${files} files, all raised and asserted`,
  ],
  stats: {
    enumSize: known.size,
    references: refs,
    files,
    unraised,
    unasserted,
  },
});
