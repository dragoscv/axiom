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
 *   5. assertions on message text — `.message).toMatch(` and `toThrow("…")` /
 *      `toThrow(/…/)` (tests.instructions.md: assert on codes, never on messages).
 *      Waive one with an inline `// message-ok: <reason>` on the same or previous line.
 *   6. `it.skipIf(` / `describe.skipIf(` / `runIf(` without a reason comment on the
 *      same or previous line.
 *
 * LEGACY_ALLOW lists files owned by other work streams that still carry rule-5/6 hits, with
 * the number tolerated per rule; a file exceeding its cap (or any unlisted file) fails. A file
 * under its cap is reported as a note so the cap can be lowered (ratchet).
 */
import { join } from "node:path";
import { lineOf, REPO_ROOT, readText, rel, report, walk } from "./_guard-lib.mjs";

const TAUTOLOGY =
  /expect\(\s*(true|false|1|0|null|undefined|"[^"]*"|'[^']*')\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy)\b/g;
const INDEX_VS_LENGTH = /indexOf\([^)]*\)\s*\)\s*\.\s*toBeLessThan\(\s*[\w.]+\.length\s*\)/g;
const SKIP = /\b(?:it|test|describe)\.(skip|todo)\s*\(/g;
const SKIP_IF = /\b(?:(?:it|test|describe)\.)?(skipIf|runIf)\s*\(/g;
const MESSAGE_MATCH = /\.message\s*\)\s*\.\s*(?:not\s*\.\s*)?toMatch\s*\(/g;
const THROW_TEXT = /\.toThrow(?:Error)?\s*\(\s*(?:["'`]|\/(?![/*]))/g;
const WAIVER = /\/\/\s*message-ok:\s*\S{3,}/;

/**
 * Rule-5/6 hits in files owned by other work streams (v3 C2, 2026-10-19). Key = the test file
 * (its owner converts it), value = hits tolerated per rule. Lower the cap as they are converted.
 * @type {Map<string, { message?: number, skipIf?: number }>}
 */
const LEGACY_ALLOW = new Map([
  ["packages/apply/src/fsx.test.ts", { skipIf: 1 }],
  ["packages/apply/src/git.test.ts", { skipIf: 1 }],
  ["packages/checks/src/predicates/cel.test.ts", { message: 1 }],
  ["packages/checks/src/predicates/predicates.test.ts", { message: 2 }],
  ["packages/checks/src/predicates/util.test.ts", { skipIf: 2 }],
  ["packages/conformance/src/run.test.ts", { skipIf: 1 }],
  ["packages/mcp/src/cli-ops.test.ts", { skipIf: 1 }],
  ["packages/mcp/src/cli.test.ts", { skipIf: 1 }],
  ["packages/mcp/src/daemon-client.test.ts", { skipIf: 1 }],
  ["packages/mcp/src/doctor.test.ts", { message: 6 }],
  ["packages/mcp/src/gate-hardening.test.ts", { skipIf: 2 }],
  ["packages/mcp/src/gate.test.ts", { message: 2, skipIf: 1 }],
  ["packages/mcp/src/init.test.ts", { skipIf: 2 }],
  ["packages/mcp/src/keys.test.ts", { message: 1, skipIf: 1 }],
  ["packages/mcp/src/migrate.test.ts", { skipIf: 1 }],
  ["packages/mcp/src/opencode-plugin.test.ts", { message: 5 }],
  ["packages/mcp/src/roots.test.ts", { skipIf: 1 }],
  ["packages/mcp/src/snapshot.test.ts", { skipIf: 1 }],
  ["packages/plan/src/compile.test.ts", { message: 1 }],
]);
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
const notes = [];
let files = 0;
let tests = 0;
/** @type {Map<string, { message: number, skipIf: number }>} */
const legacyHits = new Map();

/** Push `found` unless it fits the file's LEGACY_ALLOW cap for `rule`. */
function legacy(file, rule, found) {
  const hits = legacyHits.get(file) ?? { message: 0, skipIf: 0 };
  hits[rule] = found.length;
  legacyHits.set(file, hits);
  const cap = LEGACY_ALLOW.get(file)?.[rule] ?? 0;
  if (found.length > cap) problems.push(...found);
}

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
  const reasonAt = (ln) => {
    const here = lines[ln - 1] ?? "";
    const prev = lines[ln - 2] ?? "";
    return /\/\/\s*\S{4,}/.test(here) || /^\s*(\/\/|\*)\s*\S{4,}/.test(prev);
  };
  for (const m of src.matchAll(SKIP)) {
    const ln = lineOf(src, m.index);
    if (!reasonAt(ln)) {
      problems.push(`${r}:${ln}: .${m[1]}( without a reason comment (same or previous line)`);
    }
  }
  const skipIfFound = [];
  for (const m of src.matchAll(SKIP_IF)) {
    const ln = lineOf(src, m.index);
    if (!reasonAt(ln)) {
      skipIfFound.push(`${r}:${ln}: ${m[1]}( without a reason comment (same or previous line)`);
    }
  }
  legacy(r, "skipIf", skipIfFound);

  const msgFound = [];
  for (const re of [MESSAGE_MATCH, THROW_TEXT]) {
    for (const m of src.matchAll(re)) {
      const ln = lineOf(src, m.index);
      if (WAIVER.test(lines[ln - 1] ?? "") || WAIVER.test(lines[ln - 2] ?? "")) continue;
      msgFound.push(`${r}:${ln}: asserts on message text (${m[0].trim()}…) — assert on .code/.id`);
    }
  }
  legacy(r, "message", msgFound);
}

let allowed = 0;
for (const [file, caps] of LEGACY_ALLOW) {
  for (const rule of /** @type {const} */ (["message", "skipIf"])) {
    const cap = caps[rule] ?? 0;
    const n = legacyHits.get(file)?.[rule] ?? 0;
    allowed += Math.min(cap, n);
    if (n < cap) notes.push(`${file}: LEGACY_ALLOW ${rule} cap ${cap} > ${n} hits — lower it`);
  }
}

report("vacuous-assertions", problems, {
  notes: [
    `${tests} tests in ${files} files`,
    `${allowed} legacy message/skipIf hits allowlisted in ${LEGACY_ALLOW.size} files owned by others`,
    ...notes,
  ],
  stats: { files, tests, allowlisted: allowed },
});
