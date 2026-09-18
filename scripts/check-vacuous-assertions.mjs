#!/usr/bin/env node
/**
 * check-vacuous-assertions — tests that pass with the code under test deleted.
 * Ported from brivio (which found two such guards in a due-diligence pass).
 *
 * Flags, in every `*.test.ts` under packages/(star)/src (not _v1):
 *   1. an `it(`/`test(` block whose body contains no `expect(` and no
 *      fast-check `fc.assert(` — a green test that asserts nothing;
 *   2. `expect(true).toBe(true)` / `expect(1).toBe(1)` style tautologies;
 *   3. `expect(x.indexOf(..)).toBeLessThan(y.length)` — always true;
 *   4. `.skip(` / `.todo(` without a reason comment on the same or previous
 *      line (PLAN.md S-112: "0 skipped-without-reason").
 */
import { join } from "node:path";
import { lineOf, REPO_ROOT, readText, rel, report, walk } from "./_guard-lib.mjs";

const TAUTOLOGY =
  /expect\(\s*(true|false|1|0|null|undefined|"[^"]*"|'[^']*')\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy)\b/g;
const INDEX_VS_LENGTH = /indexOf\([^)]*\)\s*\)\s*\.\s*toBeLessThan\(\s*[\w.]+\.length\s*\)/g;
const SKIP = /\b(?:it|test|describe)\.(skip|todo)\s*\(/g;
const BLOCK_START =
  /\b(?:it|test)(?:\.(?:only|each\([^)]*\)|concurrent|sequential))?\s*\(\s*(["'`])((?:(?!\1).)*)\1\s*,/g;

/** Return the body text of the arrow/function starting at `from` (brace-balanced). */
function blockBody(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const problems = [];
let files = 0;
let tests = 0;

for (const file of walk(join(REPO_ROOT, "packages"), (r) => /\/src\/.*\.test\.ts$/.test(r))) {
  files++;
  const src = readText(file);
  const r = rel(file);

  for (const m of src.matchAll(BLOCK_START)) {
    tests++;
    const body = blockBody(src, m.index + m[0].length);
    const asserts =
      /\bexpect\w*(?:\.soft|\.poll)?\s*\(/.test(body) ||
      /\bfc\.assert\s*\(/.test(body) ||
      /\bassert(?:\.\w+)?\s*\(/.test(body) ||
      /\bassert\w+\s*\(/.test(body);
    if (!asserts) {
      problems.push(
        `${r}:${lineOf(src, m.index)}: "${m[2]}" has no assertion (no expect*/assert*/fc.assert)`,
      );
    }
  }

  for (const m of src.matchAll(TAUTOLOGY)) {
    problems.push(`${r}:${lineOf(src, m.index)}: tautological assertion ${m[0].trim()}`);
  }
  for (const m of src.matchAll(INDEX_VS_LENGTH)) {
    problems.push(`${r}:${lineOf(src, m.index)}: indexOf(...) < .length is always true`);
  }

  const lines = src.split("\n");
  for (const m of src.matchAll(SKIP)) {
    const ln = lineOf(src, m.index);
    const here = lines[ln - 1] ?? "";
    const prev = lines[ln - 2] ?? "";
    const hasReason = /\/\/\s*\S{4,}/.test(here) || /^\s*(\/\/|\*)\s*\S{4,}/.test(prev);
    if (!hasReason) {
      problems.push(`${r}:${ln}: .${m[1]}( without a reason comment (same or previous line)`);
    }
  }
}

report("vacuous-assertions", problems, {
  notes: [`${tests} tests in ${files} files`],
  stats: { files, tests },
});
