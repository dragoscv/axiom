#!/usr/bin/env node
/**
 * check-no-shell-spawn — v1 spawned `git` with `shell: true` and a
 * user-supplied branch name (command injection). v2 bans:
 *   - `shell: true` anywhere in packages/(star)/src
 *   - `exec(` / `execSync(` imported from node:child_process (string-parsed
 *     commands). `execFile`/`spawn` with an args array are fine.
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

const problems = [];
let files = 0;

for (const file of walk(join(REPO_ROOT, "packages"), (r) => /\/src\/.*\.ts$/.test(r))) {
  files++;
  const raw = readText(file);
  const code = stripStringsAndComments(raw);
  const r = rel(file);

  for (const m of code.matchAll(/\bshell\s*:\s*true\b/g)) {
    problems.push(`${r}:${lineOf(code, m.index)}: shell: true is banned — pass an args array`);
  }

  // `import { exec, execSync } from "node:child_process"` (any spelling of the specifier)
  const importsChildProcess = /from\s+["'](node:)?child_process["']/.test(raw);
  const usesPromisified = /promisify\(\s*exec\s*\)/.test(code);
  if (importsChildProcess || usesPromisified) {
    for (const m of raw.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g,
    )) {
      const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
      for (const n of names) {
        if (n === "exec" || n === "execSync") {
          problems.push(
            `${r}:${lineOf(raw, m.index)}: imports ${n} from child_process — use execFile/spawn`,
          );
        }
      }
    }
    for (const m of code.matchAll(/\b(?:child_process|cp)\.(exec|execSync)\s*\(/g)) {
      problems.push(
        `${r}:${lineOf(code, m.index)}: ${m[1]}( parses a shell string — use execFile/spawn`,
      );
    }
  }
}

report("no-shell-spawn", problems, { notes: [`${files} files scanned`], stats: { files } });
