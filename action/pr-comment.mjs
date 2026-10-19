#!/usr/bin/env node
/**
 * pr-comment — post or update ONE sticky pull-request comment summarising what AXIOM proved
 * about the PR (S-1317): the verify-tree result, the check verdict, which changed files are
 * covered by an AXIOM manifest (agent-applied) and which are not, and the attestation link.
 *
 * Zero dependencies, Node ≥ 22 (global fetch). Inputs come from the environment so the
 * composite action never interpolates user data into a shell line:
 *
 *   AXIOM_BUNDLE            bundle JSON the action verified (required)
 *   AXIOM_ROOT              tree root (default ".")
 *   AXIOM_VERIFY_JSON       file with the `axiom verify --tree` JSON (optional)
 *   AXIOM_CHECK_JSON        file with the `axiom plan check --format json` CheckReport (optional)
 *   AXIOM_ATTESTATION_URL   actions/attest `attestation-url` output (optional)
 *   GITHUB_TOKEN            needs `pull-requests: write` (never printed)
 *   GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID,
 *   GITHUB_WORKSPACE, GITHUB_OUTPUT  — set by the runner
 *
 * `--dry-run` (or AXIOM_PR_COMMENT_DRY_RUN=1) prints the comment body instead of calling the
 * API; changed files then come from AXIOM_PR_FILES (newline-separated) when set.
 *
 * Exit codes: 0 posted/updated/skipped (not a pull_request, fork token without write access —
 * a warning annotation explains it), 2 bad input. The comment never decides the job: the
 * verify step already failed or passed it.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const MARKER = "<!-- axiom-pr-summary -->";
const MAX_LIST = 50;
const MAX_BODY = 60_000; // GitHub caps comment bodies at 65 536 characters.

const env = process.env;
const DRY = process.argv.includes("--dry-run") || env.AXIOM_PR_COMMENT_DRY_RUN === "1";

function warn(msg) {
  // Annotation text only — never a header, token or response body that could echo one.
  console.log(`::warning title=AXIOM PR comment::${msg.replace(/\r?\n/g, " ")}`);
}

function readJsonFile(file) {
  if (!file || !existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** POSIX path of `abs` relative to the repository checkout, or null when it lies outside. */
function repoPrefix(rootAbs) {
  const ws = path.resolve(env.GITHUB_WORKSPACE ?? process.cwd());
  const rel = path.relative(ws, rootAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Every manifest-covered path, as root-relative POSIX, mapped to the digests that cover it. */
export function collectCoverage(rootAbs, bundle) {
  const covered = new Map();
  const add = (p, digest) => {
    if (typeof p !== "string") return;
    const set = covered.get(p) ?? new Set();
    if (typeof digest === "string") set.add(digest);
    covered.set(p, set);
  };
  for (const a of bundle?.manifest?.artifacts ?? []) add(a.path, bundle.manifestDigest);
  const manifestsDir = path.join(rootAbs, ".axiom", "manifests");
  const appliedDir = path.join(rootAbs, ".axiom", "applied");
  let manifests = 0;
  let applied = 0;
  for (const [dir, kind] of [
    [manifestsDir, "manifest"],
    [appliedDir, "applied"],
  ]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const j = readJsonFile(path.join(dir, name));
      if (!j) continue;
      if (kind === "manifest" && Array.isArray(j.manifest?.artifacts)) {
        manifests++;
        for (const a of j.manifest.artifacts) add(a.path, j.manifestDigest);
      } else if (kind === "applied" && Array.isArray(j.files)) {
        applied++;
        for (const f of j.files) add(f.path, j.manifestDigest);
      }
    }
  }
  return { covered, manifests, applied };
}

/** Decision journal summary: counts per decision, and paths an allowed call touched. */
export function collectDecisions(rootAbs) {
  const file = path.join(rootAbs, ".axiom", "decisions.jsonl");
  const counts = { allow: 0, deny: 0, ask: 0 };
  const gated = new Set();
  if (!existsSync(file)) return { present: false, counts, gated };
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.decision in counts) counts[r.decision]++;
    if (r.decision === "allow" && Array.isArray(r.paths)) for (const p of r.paths) gated.add(p);
  }
  return { present: true, counts, gated };
}

/** Classify the PR's changed files (repo-relative) against the root-relative coverage sets. */
export function classify(prFiles, prefix, covered, gated) {
  const toRoot = (f) => {
    if (prefix === null || prefix === "") return f;
    return f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : null;
  };
  const out = { manifest: [], gated: [], uncovered: [], outside: [] };
  for (const f of prFiles) {
    if (f.startsWith(".axiom/") || f.includes("/.axiom/")) continue; // AXIOM's own state
    const r = toRoot(f);
    if (r === null) out.outside.push(f);
    else if (covered.has(r)) out.manifest.push(f);
    else if (gated.has(r)) out.gated.push(f);
    else out.uncovered.push(f);
  }
  return out;
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/`/g, "'");
function list(title, files) {
  if (files.length === 0) return null;
  const shown = files.slice(0, MAX_LIST).map((f) => `- \`${cell(f)}\``);
  if (files.length > MAX_LIST) shown.push(`- … and ${files.length - MAX_LIST} more`);
  return `<details><summary>${title} (${files.length})</summary>\n\n${shown.join("\n")}\n\n</details>\n`;
}

export function renderBody({ verify, check, cls, decisions, coverage, attestationUrl, runUrl }) {
  const lines = [MARKER, "## AXIOM summary", ""];
  const vOk = verify?.ok === true;
  const vText = verify
    ? `${vOk ? "✅ match" : "❌ mismatch"} — \`${cell(verify.manifestDigest ?? "?")}\`${
        vOk ? "" : ` (${(verify.mismatches ?? []).length} path(s) differ)`
      }`
    : "⚠️ no result (the verify step did not produce JSON)";
  const icon = { pass: "✅", fail: "❌", error: "⚠️" };
  let cText = "— not run";
  if (check?.kind === "CheckReport") {
    const sev = {};
    for (const f of check.findings ?? []) sev[f.severity] = (sev[f.severity] ?? 0) + 1;
    const counts = Object.entries(sev)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    cText = `${icon[check.verdict] ?? ""} ${check.verdict} (profile \`${cell(check.profile)}\`${
      counts ? `; ${counts}` : ""
    })`;
  }
  const total = cls.manifest.length + cls.gated.length + cls.uncovered.length;
  lines.push("| | |", "|---|---|");
  lines.push(`| verify-tree | ${vText} |`);
  lines.push(`| checks | ${cText} |`);
  lines.push(
    `| changed files covered by a manifest | ${cls.manifest.length} of ${total}` +
      ` (${coverage.manifests} manifest(s), ${coverage.applied} applied marker(s) in the tree) |`,
  );
  if (decisions.present) {
    const c = decisions.counts;
    lines.push(`| decision journal | ${c.allow} allow · ${c.deny} deny · ${c.ask} ask |`);
  }
  lines.push(
    `| attestation | ${attestationUrl ? `[in-toto statement](${attestationUrl})` : "— none uploaded"} |`,
  );
  lines.push("");
  if (verify && !vOk && Array.isArray(verify.mismatches) && verify.mismatches.length > 0) {
    lines.push(
      list(
        "❌ paths that do not match the manifest",
        verify.mismatches.map((m) => m.path),
      ),
    );
  }
  if (check?.findings?.length) {
    const top = check.findings
      .filter((f) => f.severity === "error" || f.severity === "warn")
      .slice(0, 20)
      .map(
        (f) =>
          `- **${cell(f.severity)}** \`${cell(f.predicate)}\`${f.path ? ` \`${cell(f.path)}\`` : ""} — ${cell(f.message)}`,
      );
    if (top.length)
      lines.push(`<details><summary>check findings</summary>\n\n${top.join("\n")}\n\n</details>\n`);
  }
  lines.push(list("🟢 agent-applied (in an AXIOM manifest)", cls.manifest));
  lines.push(list("🟡 gated by the hook but not in a manifest", cls.gated));
  lines.push(list("⚪ not covered by AXIOM", cls.uncovered));
  lines.push(list("outside the verified root", cls.outside));
  lines.push(
    `<sub>Updated by [dragoscv/axiom/action](https://github.com/dragoscv/axiom/blob/main/docs/integration/github-action.md)${
      runUrl ? ` · [run](${runUrl})` : ""
    }. "Covered" means the path is an artifact of a manifest in this tree; it says nothing about files the manifest never mentioned.</sub>`,
  );
  // GFM ends a table only at a blank line: keep "" entries, drop only absent sections.
  let body = lines.filter((l) => l !== null).join("\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n… (truncated)`;
  return body;
}

async function gh(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "dragoscv-axiom-action",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = new Error(`${method} ${new URL(url).pathname} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function paged(url, token) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const sep = url.includes("?") ? "&" : "?";
    const items = await gh("GET", `${url}${sep}per_page=100&page=${page}`, token);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function main() {
  const bundlePath = env.AXIOM_BUNDLE;
  if (!bundlePath) {
    console.error("pr-comment: AXIOM_BUNDLE is required");
    return 2;
  }
  const rootAbs = path.resolve(env.AXIOM_ROOT || ".");
  const bundle = readJsonFile(bundlePath);
  const verify = readJsonFile(env.AXIOM_VERIFY_JSON);
  const check = readJsonFile(env.AXIOM_CHECK_JSON);

  const event = readJsonFile(env.GITHUB_EVENT_PATH);
  const pr = event?.pull_request;
  if (!pr && !DRY) {
    console.log("pr-comment: not a pull_request event — nothing to post");
    return 0;
  }
  const repo = env.GITHUB_REPOSITORY ?? "";
  const api = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const token = env.GITHUB_TOKEN ?? "";

  let prFiles;
  if (DRY && env.AXIOM_PR_FILES !== undefined) {
    prFiles = env.AXIOM_PR_FILES.split(/\r?\n/).filter(Boolean);
  } else {
    if (!token) {
      warn("GITHUB_TOKEN is empty — pass `github-token` and grant `pull-requests: write`");
      return 0;
    }
    try {
      const files = await paged(`${api}/repos/${repo}/pulls/${pr.number}/files`, token);
      prFiles = files.map((f) => f.filename);
    } catch (err) {
      warn(`could not list the PR's files (${err.message})`);
      return 0;
    }
  }

  const coverage = collectCoverage(rootAbs, bundle);
  const decisions = collectDecisions(rootAbs);
  const cls = classify(prFiles, repoPrefix(rootAbs), coverage.covered, decisions.gated);
  const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
  const runUrl =
    env.GITHUB_RUN_ID && repo ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : "";
  const body = renderBody({
    verify,
    check,
    cls,
    decisions,
    coverage,
    attestationUrl: env.AXIOM_ATTESTATION_URL || "",
    runUrl,
  });

  if (DRY) {
    process.stdout.write(`${body}\n`);
    return 0;
  }

  try {
    const comments = await paged(`${api}/repos/${repo}/issues/${pr.number}/comments`, token);
    const mine = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
    const res = mine
      ? await gh("PATCH", `${api}/repos/${repo}/issues/comments/${mine.id}`, token, { body })
      : await gh("POST", `${api}/repos/${repo}/issues/${pr.number}/comments`, token, { body });
    console.log(`pr-comment: ${mine ? "updated" : "posted"} ${res.html_url}`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `comment_url=${res.html_url}\n`);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      warn(
        `cannot write the comment (${err.message}): grant \`pull-requests: write\`; fork PRs get a read-only token`,
      );
      return 0;
    }
    warn(`comment failed (${err.message})`);
    return 0;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
