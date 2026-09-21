#!/usr/bin/env node
/**
 * check-stale-markers — a "reserved for v2.1" / "planned for v2.2" / "arrives in
 * v2.x" / "is a v2.x deliverable" note whose version is already released is a lie
 * the next reader will believe (S-410: seven such strings survived two releases;
 * the LSP hover said `template` "compile rejects it today" while it was shipping).
 *
 * Rule: in source and docs (not archive/research/changelogs/tracker), a
 * forward-looking marker naming `v<major>.<minor>` FAILS when that version is
 * ≤ the current `@codai/axiom-schema` version (fixed group → same for all).
 * Markers for versions still ahead are fine; plain history ("added in v2.1")
 * is not matched.
 */
import { join } from "node:path";
import { lineOf, REPO_ROOT, readJson, readText, rel, report, walk } from "./_guard-lib.mjs";

const current = readJson(join(REPO_ROOT, "packages/schema/package.json")).version;
const [curMajor, curMinor] = current.split(".").map(Number);

/** Forward-looking phrases followed (within a few words) by a version. */
const MARKER =
  /\b(?:reserved(?: for| in| until)?|planned(?: for)?|deferred(?: to| until)?|arrives? in|lands? in|coming in|scheduled for|is an? v\d+\.\d+ (?:deliverable|item|feature)|will (?:be|ship|land|arrive)[^.\n]{0,40}?in)\s+(?:the\s+)?v?(\d+)\.(\d+)(?:\.\d+)?\b/gi;

const SKIP_PATH =
  /^(docs\/archive\/|docs\/research\/|apps\/site\/(?:src\/content\/docs|public|dist|\.astro)\/|\.changeset\/|PLAN\.md$|TRACKER\.csv$|.*CHANGELOG\.md$|.*\.expected\.json$|packages\/mcp\/spec\/|scripts\/check-stale-markers\.mjs$)/;

const files = [
  ...walk(
    REPO_ROOT,
    (p) => /\.(md|ts|mts|mjs|json)$/.test(p) && !SKIP_PATH.test(p) && !/\.test\.ts$/.test(p),
  ),
];

const problems = [];
let scanned = 0;
for (const file of files) {
  const src = readText(file);
  scanned++;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(src); m !== null; m = MARKER.exec(src)) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const shipped = major < curMajor || (major === curMajor && minor <= curMinor);
    if (!shipped) continue;
    problems.push(
      `${rel(file)}:${lineOf(src, m.index)} "${m[0].trim()}" — v${major}.${minor} is already released (current ${current}); rewrite in present tense or point at the tracker id`,
    );
  }
}

report("stale-markers", problems, {
  notes: [`${scanned} files scanned against current version ${current}`],
});
