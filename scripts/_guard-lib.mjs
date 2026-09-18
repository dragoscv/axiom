/**
 * Shared helpers for `scripts/check-*.mjs` guards.
 *
 * Contract (mirrors brivio): each guard is a standalone ESM script that prints
 * `OK    <name>[: note]` or `FAIL  <name>: reason` lines, exits 0/1 and
 * supports `--json` (one JSON object on stdout, nothing else). Only node
 * builtins — guards must run on a fresh checkout before `pnpm install`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories never worth walking. `_v1` is the frozen legacy tree. */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".stryker-tmp",
  ".copilot-tmp",
  ".pnpm-cache",
  "coverage",
  "_v1",
]);

export const args = new Set(process.argv.slice(2));
export const JSON_MODE = args.has("--json");
export const STRICT = args.has("--strict");

/** Posix-style path relative to the repo root, for stable output on Windows. */
export function rel(p) {
  return relative(REPO_ROOT, p).split("\\").join("/");
}

/** Recursively yield files under `dir` whose relative path passes `filter`. */
export function* walk(dir, filter = () => true) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, filter);
    else if (e.isFile() && filter(rel(full))) yield full;
  }
}

/** `packages/<name>` directories that are part of the v2 workspace (not `_v1`). */
export function workspacePackages() {
  const dir = join(REPO_ROOT, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((name) => exists(join(dir, name, "package.json")))
    .sort();
}

export function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

export function readText(p) {
  return readFileSync(p, "utf8");
}

/**
 * Strip string literals, comments and template literals so a regex over the
 * remainder only sees code. Good enough for "no console.log outside cli.ts"
 * style guards; not a parser.
 */
export function stripStringsAndComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** Line number (1-based) of a character offset. */
export function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Print the result in the house format and exit.
 * `problems`: string[]; `notes`: string[] appended on OK; `skipped`: true when
 * the guard could not run (no dist etc.) and is reporting OK-with-note.
 */
export function report(name, problems, { notes = [], skipped = false, stats = {} } = {}) {
  const ok = problems.length === 0;
  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({ guard: name, ok, skipped, problems, notes, ...stats })}\n`,
    );
  } else if (ok) {
    const suffix = notes.length > 0 ? `: ${notes.join("; ")}` : "";
    console.log(`OK    ${name}${suffix}`);
  } else {
    for (const p of problems) console.log(`FAIL  ${name}: ${p}`);
  }
  process.exit(ok ? 0 : 1);
}
