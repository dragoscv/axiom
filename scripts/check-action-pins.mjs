#!/usr/bin/env node
/**
 * check-action-pins — every `uses:` in .github/ must be a 40-hex commit SHA
 * followed by a `# vX` comment naming the tag it pins. A tag can be repointed
 * by whoever controls the action repo (tj-actions/changed-files,
 * CVE-2025-30066); a SHA cannot. The comment keeps it reviewable and lets
 * Dependabot/Renovate bump it. Also refuses `image:` on `:latest`/untagged.
 *
 * Local composite actions (`./.github/actions/...`) and `docker://…@sha256:`
 * are allowed. Ported from brivio.
 *
 * Usage: node scripts/check-action-pins.mjs [--self-test] [--json]
 */
import { join } from "node:path";
import { args, REPO_ROOT, readText, rel, report, walk } from "./_guard-lib.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;

export function auditWorkflow(file, text) {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const ln = i + 1;
    const uses = raw.match(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)["']?\s*(#.*)?$/);
    if (uses) {
      const ref = uses[1];
      const comment = uses[2] ?? "";
      if (ref.startsWith("./")) return;
      if (ref.startsWith("docker://")) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) {
          problems.push(`${file}:${ln}: docker action "${ref}" is not pinned by digest`);
        }
        return;
      }
      const at = ref.lastIndexOf("@");
      if (at < 0) {
        problems.push(`${file}:${ln}: "${ref}" has no @ref at all`);
        return;
      }
      const sha = ref.slice(at + 1);
      if (!SHA_RE.test(sha)) {
        problems.push(`${file}:${ln}: "${ref}" is pinned to a tag/branch, not a 40-hex SHA`);
        return;
      }
      if (!/#\s*v?\d[\w.-]*/.test(comment)) {
        problems.push(
          `${file}:${ln}: "${ref.slice(0, at)}@${sha.slice(0, 7)}…" has no "# vX" comment`,
        );
      }
      return;
    }
    const image = raw.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/);
    if (image) {
      const img = image[1];
      if (img.startsWith("${{")) return;
      const hasDigest = /@sha256:[0-9a-f]{64}$/.test(img);
      const tag = img.includes("@") ? null : img.split("/").pop().split(":")[1];
      if (!hasDigest && (!tag || tag === "latest")) {
        problems.push(`${file}:${ln}: container image "${img}" is unpinned`);
      }
    }
  });
  return problems;
}

function selfTest() {
  const cases = [
    ["uses: actions/checkout@v4", 1],
    ["uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", 1],
    ["uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v5", 0],
    ["      - uses: ./.github/actions/setup", 0],
    ["uses: docker://alpine:3.20", 1],
    ["      image: semgrep/semgrep:latest", 1],
    ["      image: semgrep/semgrep:1.176.1", 0],
    ["uses: actions/checkout@3d3c42e5aac5ba805825da76410c18127", 1],
  ];
  const bad = cases.filter(([line, want]) => auditWorkflow("t.yml", line).length !== want);
  for (const [line] of bad) console.error(`SELF-TEST FAIL: ${line}`);
  report(
    "action-pins",
    bad.map(([l]) => `self-test: ${l}`),
    { notes: [`self-test ${cases.length} cases`] },
  );
}

if (args.has("--self-test")) selfTest();

const problems = [];
let files = 0;
let uses = 0;
for (const f of [
  ...walk(join(REPO_ROOT, ".github"), (r) => /\.ya?ml$/.test(r)),
  ...walk(join(REPO_ROOT, "action"), (r) => /\.ya?ml$/.test(r)),
]) {
  const text = readText(f);
  files++;
  uses += (text.match(/^\s*-?\s*uses:/gm) ?? []).length;
  problems.push(...auditWorkflow(rel(f), text));
}
if (files === 0) problems.push("no workflow files under .github/ — guard would be vacuous");

report("action-pins", problems, {
  notes: [`${uses} uses: across ${files} files`],
  stats: { files, uses },
});
