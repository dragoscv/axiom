#!/usr/bin/env node
// Parity harness between AXIOM's `command.deny` house pack and the PowerShell house guard
// (S-1216, D-39). Feeds commands to the REAL guard as VS Code PreToolUse payloads.
//
//   node scripts/guard-parity.mjs --generate --guard <guard.ps1> --out <corpus.json>
//   node scripts/guard-parity.mjs --check    --guard <guard.ps1> [--corpus <corpus.json>]
//   node scripts/guard-parity.mjs --replay <decisions.jsonl> --guard <guard.ps1>
//
// The guard runs with a private AGENTQ_HOME / CODAI_WT_ROOT / TEMP and a cwd outside any git
// repo, from a COPY in a temp dir (so its side channels - lease renewals, stale-script markers,
// the "blocked" signal sender next to it - stay inert). No shell: spawn with an args array.
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_CORPUS = "packages/mcp/fixtures/guard-parity.json";
const CONCURRENCY = 6;

// Words a PreToolUse guard on the maintainer's machine scans edit text for: built from pieces.
const SQL_D = ["DR", "OP"].join("");
const SQL_T = ["TRUNC", "ATE"].join("");
const SQL_DEL = ["DEL", "ETE"].join("");

/** Seed commands: a deny and a near-miss allow for every HOUSE_PACK rule, plus neutral ones. */
const SEEDS = [
  // house.gitAddAll
  ["git add -A", "house.gitAddAll"],
  ["git add .", "house.gitAddAll"],
  ["git add --all", "house.gitAddAll"],
  ["GIT ADD -A", "house.gitAddAll (case-insensitive)"],
  ["git add -- src/a.ts", "near-miss gitAddAll"],
  ["git add ./src/a.ts", "near-miss gitAddAll"],
  // house.gitCommitAll
  ["git commit -am 'msg'", "house.gitCommitAll"],
  ["git commit -a -m wip", "house.gitCommitAll"],
  ["git commit --all -m wip", "house.gitCommitAll"],
  ["git commit -m 'add' -- a.ts", "near-miss gitCommitAll (pathspec)"],
  // house.forcePush
  ["git push --force origin main", "house.forcePush"],
  ["git push origin main -f", "house.forcePush"],
  ["git push --force-with-lease", "house.forcePush"],
  ["git push origin main", "near-miss forcePush"],
  ["git push origin my-feat", "near-miss forcePush"],
  // house.resetHard
  ["git reset --hard HEAD~1", "house.resetHard"],
  ["git reset --soft HEAD~1", "near-miss resetHard"],
  // house.cleanForce
  ["git clean -fd", "house.cleanForce"],
  ["git clean -xdf", "house.cleanForce"],
  ["git clean -n", "near-miss cleanForce"],
  // house.checkoutDiscard
  ["git checkout -- src/a.ts", "house.checkoutDiscard"],
  ["git checkout .", "house.checkoutDiscard"],
  ["git checkout HEAD -- a.ts", "house.checkoutDiscard"],
  ["git checkout -b feat/x", "near-miss checkoutDiscard"],
  ["git checkout main", "near-miss checkoutDiscard"],
  // house.restore
  ["git restore src/a.ts", "house.restore"],
  ["git restore --staged a.ts", "house.restore"],
  ["git log -- restore.ts", "near-miss restore"],
  // house.stashFlagsAfterDashDash
  ["git stash push -- a.ts -m wip", "house.stashFlagsAfterDashDash"],
  ["git -C repo stash push -- a.ts -u", "house.stashFlagsAfterDashDash"],
  ["git stash push -m wip -- a.ts", "near-miss stashFlagsAfterDashDash"],
  // house.stashBare
  ["git stash pop", "house.stashBare"],
  ["git stash drop", "house.stashBare"],
  ["git -C repo stash apply", "house.stashBare"],
  ["git stash pop stash@{2}", "near-miss stashBare"],
  ["git stash list", "near-miss stashBare"],
  // house.sqlDestructive
  [`psql -c "${SQL_D} TABLE users"`, "house.sqlDestructive"],
  [`${SQL_T} TABLE logs`, "house.sqlDestructive"],
  [`psql -c "${SQL_D} INDEX idx_users"`, "near-miss sqlDestructive"],
  // house.sqlDeleteAll
  [`${SQL_DEL} FROM users;`, "house.sqlDeleteAll"],
  [`${SQL_DEL} FROM users`, "house.sqlDeleteAll"],
  [`${SQL_DEL} FROM users WHERE id = 1;`, "near-miss sqlDeleteAll"],
  // house.rmRoot
  ["rm -rf /", "house.rmRoot"],
  ["rm -rf ~", "house.rmRoot"],
  ["rm -rf ./dist", "near-miss rmRoot"],
  ["rm -rf /tmp/x", "near-miss rmRoot"],
  // house.removeItemRoot
  ["Remove-Item -Recurse -Force C:\\", "house.removeItemRoot"],
  ["Remove-Item -Recurse -Force .\\dist", "near-miss removeItemRoot"],
  // house.commitNoPathspec
  ["git commit -m 'fix: x'", "house.commitNoPathspec"],
  ["cd repo; git commit -m x", "house.commitNoPathspec"],
  ["git -C repo commit -m x", "house.commitNoPathspec"],
  ["git commit -m x -- a.ts", "near-miss commitNoPathspec (pathspec)"],
  ["git commit --amend --no-edit", "near-miss commitNoPathspec (amend)"],
  ["git commit --allow-empty -m x", "near-miss commitNoPathspec (allow-empty)"],
  ["git commit-tree abc123 -m x", "near-miss commitNoPathspec (commit-tree)"],
  [
    "pwsh -NoProfile -File C:\\tools\\agentq.ps1 commit -Paths a.ts",
    "near-miss commitNoPathspec (agentq)",
  ],
  ["echo 'git commit'", "near-miss commitNoPathspec (not at command position)"],
  // house.worktreeRawRemove / Add / RemoveForce
  ["git worktree remove ../wt", "house.worktreeRawRemove"],
  ["git worktree move a b", "house.worktreeRawRemove"],
  ["git worktree list", "near-miss worktree rules"],
  ["git worktree add ../x main", "house.worktreeRawAdd"],
  [
    "pwsh -NoProfile -File C:\\tools\\agentq.ps1 lease -Purpose x; git worktree add ../x",
    "near-miss worktreeRawAdd (via tool)",
  ],
  ["git worktree remove --force ../x", "house.worktreeRemoveForce"],
  [
    "pwsh -File C:\\tools\\worktree.ps1 x; git worktree remove -f ../x",
    "house.worktreeRemoveForce (tool does not exempt --force)",
  ],
  [
    "pwsh -File C:\\tools\\worktree.ps1 remove -Path ../x",
    "near-miss worktreeRawRemove (via tool)",
  ],
  // house.playwrightLocal
  ["npx playwright test", "house.playwrightLocal"],
  ["pnpm exec playwright test e2e/a.spec.ts", "house.playwrightLocal"],
  ["$env:CI=1; npx playwright test", "house.playwrightLocal"],
  ["pnpm a11y:routes", "house.playwrightLocal"],
  ["node node_modules/@playwright/test/cli.js test", "house.playwrightLocal"],
  ["cd apps/web; playwright test --project=chromium", "house.playwrightLocal"],
  ["npx playwright test --list", "near-miss playwrightLocal (--list)"],
  ["PW_ALLOW_LOCAL=1 npx playwright test", "near-miss playwrightLocal (escape)"],
  ["npx playwright install", "near-miss playwrightLocal (install)"],
  ["echo 'npx playwright test'", "near-miss playwrightLocal (inside a string)"],
  [
    "pnpm playwright test",
    "near-miss playwrightLocal (bare pnpm prefix is not matched by the guard)",
  ],
  // house.buildUnqueued
  ["pnpm build", "house.buildUnqueued"],
  ["pnpm --filter @codai/axiom-mcp typecheck", "house.buildUnqueued"],
  ["npx tsc --noEmit", "house.buildUnqueued"],
  ["turbo run build", "house.buildUnqueued"],
  ["next build", "house.buildUnqueued"],
  [
    "node --max-old-space-size=8192 node_modules/typescript/lib/tsc.js --noEmit",
    "house.buildUnqueued",
  ],
  ["cd x; pnpm run build > out.log", "house.buildUnqueued (complex: run-build message)"],
  ["pnpm test", "near-miss buildUnqueued"],
  ["pnpm lint", "near-miss buildUnqueued"],
  [
    "pwsh -NoProfile -File C:\\tools\\run-build.ps1 -Command 'pnpm build'",
    "near-miss buildUnqueued (wrapper)",
  ],
  // deploys: the guard refuses them only on a DIRTY git tree (HOUSE_DEPLOY_RULE, not in the pack)
  [
    "gcloud builds submit .",
    "deploy outside git = allowed; HOUSE_DEPLOY_RULE fires only on a dirty tree",
  ],
  [
    "docker build -t app .",
    "deploy outside git = allowed; HOUSE_DEPLOY_RULE fires only on a dirty tree",
  ],
  // neutral
  ["ls", "neutral"],
  ["rg -n foo packages", "neutral"],
  ["pnpm install", "neutral (guard only warns)"],
  ["Stop-Process -Id 4242", "neutral (guard only warns)"],
  ["git status --porcelain", "neutral"],
];

function fail(msg) {
  console.error(`guard-parity: ${msg}`);
  process.exit(2);
}

/** A private sandbox: guard copy, empty AGENTQ_HOME/CODAI_WT_ROOT/TEMP, non-git cwd. */
async function makeSandbox(guardPath) {
  const dir = await mkdtemp(path.join(tmpdir(), "axiom-guard-parity-"));
  const guard = path.join(dir, "guard.ps1");
  await copyFile(guardPath, guard);
  const cwd = path.join(dir, "cwd");
  for (const sub of ["agentq", "wt", "tmp", "cwd"]) await mkdir(path.join(dir, sub));
  const env = {
    ...process.env,
    AGENTQ_HOME: path.join(dir, "agentq"),
    CODAI_WT_ROOT: path.join(dir, "wt"),
    TEMP: path.join(dir, "tmp"),
    TMP: path.join(dir, "tmp"),
    AGENTQ_WHERE: "",
    PW_ALLOW_LOCAL: "",
  };
  // The guard's "blocked" signal is a detached Start-Process that may briefly hold the dir:
  // retry, then leave the leftovers to the OS temp cleaner rather than fail the run.
  const dispose = () =>
    rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {
      console.error(`guard-parity: could not remove ${dir} (still in use); left for temp cleanup`);
    });
  return { dir, guard, env, cwd, dispose };
}

function runGuard(sb, command) {
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "run_in_terminal",
    tool_input: { command },
    cwd: sb.cwd,
  });
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", sb.guard], {
      cwd: sb.cwd,
      env: sb.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      const deny = code === 2 || /"permissionDecision"\s*:\s*"deny"/.test(out);
      resolve(deny ? "deny" : "allow");
    });
    child.stdin.end(payload);
  });
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

async function withSandbox(guardPath, fn) {
  const sb = await makeSandbox(guardPath);
  try {
    return await fn(sb);
  } finally {
    await sb.dispose();
  }
}

async function generate(guardPath, outPath) {
  const cases = await withSandbox(guardPath, (sb) =>
    pool(SEEDS, async ([command, note]) => ({ command, guard: await runGuard(sb, command), note })),
  );
  await writeFile(outPath, `${JSON.stringify(cases, null, 2)}\n`);
  const deny = cases.filter((c) => c.guard === "deny").length;
  console.log(
    JSON.stringify({ written: outPath, total: cases.length, deny, allow: cases.length - deny }),
  );
}

async function check(guardPath, corpusPath) {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const live = corpus.filter((c) => !c.stateful);
  const answers = await withSandbox(guardPath, (sb) => pool(live, (c) => runGuard(sb, c.command)));
  const diffs = live
    .map((c, i) => ({ command: c.command, corpus: c.guard, guard: answers[i] }))
    .filter((d) => d.corpus !== d.guard);
  console.log(JSON.stringify({ total: live.length, diffs }, null, 2));
  process.exit(diffs.length > 0 ? 1 : 0);
}

async function replay(jsonlPath, guardPath) {
  const text = await readFile(jsonlPath, "utf8");
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r && r.shadow === true && typeof r.command === "string") {
      records.push({ command: r.command, axiom: r.decision === "allow" ? "allow" : "deny" });
    }
  }
  const answers = await withSandbox(guardPath, (sb) =>
    pool(records, (r) => runGuard(sb, r.command)),
  );
  const diffs = records
    .map((r, i) => ({ command: r.command, axiom: r.axiom, guard: answers[i] }))
    .filter((d) => d.axiom !== d.guard);
  console.log(JSON.stringify({ total: records.length, diffs }, null, 2));
  process.exit(diffs.length > 0 ? 1 : 0);
}

const { values } = parseArgs({
  options: {
    generate: { type: "boolean" },
    check: { type: "boolean" },
    replay: { type: "string" },
    guard: { type: "string" },
    out: { type: "string" },
    corpus: { type: "string" },
  },
  strict: true,
});
if (!values.guard) fail("--guard <guard.ps1> is required");
if (values.generate) await generate(values.guard, values.out ?? DEFAULT_CORPUS);
else if (values.check) await check(values.guard, values.corpus ?? DEFAULT_CORPUS);
else if (values.replay) await replay(values.replay, values.guard);
else fail("one of --generate, --check, --replay <file> is required");
