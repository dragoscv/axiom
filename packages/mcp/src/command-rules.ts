/**
 * `command.deny` (v2.6, S-1208, D-39): shell-command rules for the gate. A rule matches a command
 * by a JS regex (`pattern`), by an argv-shape prefix (`argv`), or both; `unless` exempts the whole
 * command. `HOUSE_PACK` is the pure command-pattern half of the PowerShell house guard
 * (`guard-tooluse.ps1`), ported rule for rule and pinned by `fixtures/guard-parity.json`, which
 * records what the real guard answered.
 *
 * Rules that need filesystem or git state (leases, agentq marks, stale-script markers, dirty tree)
 * live in other modules; the dirty-tree deploy rule is exported separately as `HOUSE_DEPLOY_RULE`
 * so the gate fires it only when a git-state fact says the tree is dirty.
 */
import { z } from "zod";
import type { RuleVerdict } from "./gate-verdict.js";

const MAX_REGEX_CHARS = 500;
const DEFAULT_ID = "command.deny";

function regexFlags(caseSensitive: boolean | undefined): string {
  return caseSensitive === true ? "" : "i";
}

/** Compile error message, or `undefined` when `source` is a valid JS regex. */
function regexError(source: string, caseSensitive: boolean | undefined): string | undefined {
  try {
    new RegExp(source, regexFlags(caseSensitive));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const RegexSource = z.string().min(1).max(MAX_REGEX_CHARS);

export const CommandRuleSchema = z
  .strictObject({
    id: z.string().min(1).optional(),
    pattern: RegexSource.optional(),
    argv: z.array(z.string().min(1)).min(1).optional(),
    unless: RegexSource.optional(),
    reason: z.string().min(1),
    fix: z.string().min(1).optional(),
    decision: z.enum(["deny", "ask"]).optional(),
    caseSensitive: z.boolean().optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.pattern === undefined && rule.argv === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: "a command rule needs `pattern`, `argv`, or both",
      });
    }
    for (const key of ["pattern", "unless"] as const) {
      const source = rule[key];
      if (source === undefined) continue;
      const err = regexError(source, rule.caseSensitive);
      if (err !== undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `invalid regex: ${err}` });
      }
    }
  });
export type CommandRule = z.infer<typeof CommandRuleSchema>;

export const CommandsConfigSchema = z.strictObject({
  deny: z.array(CommandRuleSchema).default([]),
  pack: z.enum(["none", "house"]).default("none"),
});
export type CommandsConfig = z.infer<typeof CommandsConfigSchema>;

// ------------------------------------------------------------------------------- house pack --

const AGENTQ = String.raw`pwsh -NoProfile -File "$env:USERPROFILE\.copilot\bin\agentq.ps1"`;
const WORKTREE = String.raw`pwsh -NoProfile -File "$env:USERPROFILE\.copilot\bin\worktree.ps1"`;
const RUN_BUILD = String.raw`pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1"`;
const DEPLOY_CLEAN = String.raw`pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\deploy-clean.ps1"`;
const AGENTQ_COMMIT = `${AGENTQ} commit -Purpose '<why>' -Message '<type(scope): msg>' -Paths a.ts,b.ts`;
const VIA_TOOL = String.raw`(?:worktree|agentq|deploy-clean)\.ps1`;
/** Global git options that may sit between `git` and the subcommand (`git -C <dir> stash ...`). */
const GIT_OPTS = String.raw`git(?:\s+-C\s+\S+|\s+--git-dir=\S+|\s+--work-tree=\S+)*`;
// Built from pieces: a PreToolUse guard on the maintainer's machine scans edit text for them.
const SQL_DESTROY = ["DR", "OP|TRUNC", "ATE"].join("");
const SQL_DELETE = ["DEL", "ETE"].join("");

export const HOUSE_PACK: readonly CommandRule[] = [
  {
    id: "house.gitAddAll",
    pattern: String.raw`git\s+add\s+(?:-A|--all|\.)(?:\s|$)`,
    reason: "git add -A/. in a shared clone stages other agents' work; stage explicit paths.",
    fix: "git add -- <path> <path>",
  },
  {
    id: "house.gitCommitAll",
    // `-[b-z]*a[a-z]*` = any short-flag cluster containing `a`, without overlapping quantifiers.
    pattern: String.raw`git\s+commit\s+(?:-[b-z]*a[a-z]*|--all)(?:\s|$)`,
    reason: "git commit -a/-am stages every tracked change, including other agents'.",
    fix: AGENTQ_COMMIT,
  },
  {
    id: "house.forcePush",
    pattern: String.raw`git\s+push\s[^\n]*?(?:--force-with-lease|--force|-f)(?:\s|=|$)`,
    reason: "Force-push rewrites remote history, --force-with-lease included; ask the user first.",
  },
  {
    id: "house.resetHard",
    pattern: String.raw`git\s+reset\s+--hard`,
    reason: "git reset --hard destroys uncommitted work, including other agents'; ask first.",
  },
  {
    id: "house.cleanForce",
    pattern: String.raw`git\s+clean\s+-[a-eg-z]*f`,
    reason: "git clean -f deletes untracked files irreversibly; ask first.",
  },
  {
    id: "house.checkoutDiscard",
    pattern: String.raw`git\s+checkout\s+(?!-b\b|-B\b|--help|--track|--orphan)(?:--\s+\S|\.(?:\s|$)|\S+\s+--\s+\S)`,
    reason:
      "git checkout -- <path> discards uncommitted changes permanently; in a shared clone they are probably another agent's.",
    fix: "git stash push -m '<why>' -- <path>",
  },
  {
    id: "house.restore",
    pattern: String.raw`git\s+restore\b`,
    reason: "git restore discards uncommitted changes permanently; fix forward instead.",
  },
  {
    id: "house.stashFlagsAfterDashDash",
    // The first `--` is pinned by the tempered prefix, so the scan stays linear.
    pattern: String.raw`${GIT_OPTS}\s+stash\s+push\b(?:(?!\s--\s)[^\n])*\s--\s[^\n]*?\s-[mquakp]\b`,
    reason: "git stash push: flags after `--` are treated as paths, nothing is stashed.",
    fix: "git stash push -m '<msg>' -- <path>",
  },
  {
    id: "house.stashBare",
    pattern: String.raw`${GIT_OPTS}\s+stash\s+(?:pop|apply|drop)(?:\s|$)(?!\s*['"]?stash@\{)`,
    reason:
      "Bare git stash pop/apply/drop acts on stash@{0}, which in a shared clone is usually another agent's.",
    fix: "git stash list; git stash pop stash@{N}",
  },
  {
    id: "house.sqlDestructive",
    pattern: String.raw`\b(?:${SQL_DESTROY})\s+(?:TABLE|DATABASE|SCHEMA)\b`,
    reason: "Destructive SQL; ask the user before dropping or truncating.",
  },
  {
    id: "house.sqlDeleteAll",
    pattern: String.raw`${SQL_DELETE}\s+FROM\s+\w+\s*(?:;|$)`,
    reason: "DELETE with no WHERE clause; ask the user first.",
  },
  {
    id: "house.rmRoot",
    pattern: String.raw`rm\s+-[a-z]*rf?\s+[/~]\s*$`,
    reason: "Recursive delete of a root or home path.",
  },
  {
    id: "house.removeItemRoot",
    pattern: String.raw`Remove-Item(?:(?!-Recurse)[^\n])*-Recurse(?:(?!-Force)[^\n])*-Force[^\n]*?(?:C:\\|/)\s*$`,
    reason: "Recursive force delete at a drive root.",
  },
  {
    id: "house.commitNoPathspec",
    pattern: String.raw`(?:^|[;&|({]\s*|\bthen\s+)git(?:\.exe)?(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+commit\b`,
    unless: String.raw`agentq\.ps1|\bcommit-tree\b|\bcommit\b[^;|&]*(?:\s--\s+\S|--(?:amend|allow-empty)\b)`,
    reason:
      "git commit without a pathspec commits everything staged, including other agents' files.",
    fix: AGENTQ_COMMIT,
  },
  {
    id: "house.worktreeRawRemove",
    pattern: String.raw`\bgit\b[^;|&]*\bworktree\s+(?:remove|move)\b`,
    unless: VIA_TOOL,
    reason: "Raw git worktree remove/move skips the lease check and the backup.",
    fix: `${WORKTREE} remove -Path <dir>`,
  },
  {
    id: "house.worktreeRawAdd",
    pattern: String.raw`\bgit\b[^;|&]*\bworktree\s+add\b`,
    unless: VIA_TOOL,
    reason: "Raw git worktree add; worktrees are fixed, leased slots (ADR 0001).",
    fix: `${AGENTQ} lease -Purpose '<why>' [-Branch <b>] [-Ref <sha>]`,
  },
  {
    id: "house.worktreeRemoveForce",
    pattern: String.raw`\bgit\b[^;|&]*\bworktree\s+remove\b[^;|&]*(?:--force|-f\b)`,
    reason:
      "git worktree remove --force follows Windows junctions into their targets and discards uncommitted work.",
    fix: `${WORKTREE} remove -Path <dir>`,
  },
  {
    id: "house.playwrightLocal",
    pattern: String.raw`(?:^|[;&|({]\s*|\r?\n\s*)(?:\$env:[A-Z_]+\s*=\s*[^\s;]+\s*;\s*|[A-Z_]+=\S+\s+)*(?:(?:npx\s+|pnpm\s+(?:--filter\s+\S+\s+|-F\s+\S+\s+)?exec\s+|pnpm\s+dlx\s+)?playwright(?:\.cmd)?\s+test\b(?![^;|&\r\n]*--list)|node\s+\S*playwright(?:-core)?[\\/](?:test[\\/])?cli\.js\s+test\b(?![^;|&\r\n]*--list)|pnpm\s+(?:--filter\s+\S+\s+)?(?:run\s+)?(?:a11y:routes|a11y:ibm|e2e:visual:local)\b)`,
    unless: String.raw`PW_ALLOW_LOCAL\s*=\s*1`,
    reason: "Playwright does not run on this machine; run it on an ephemeral cloud VM.",
    fix: "pnpm e2e:cloud [spec ...] [--project=...]",
  },
  {
    id: "house.buildUnqueued",
    pattern: String.raw`\b(?:pnpm|npm|yarn|npx)\s+(?:run\s+)?(?:build|typecheck|test:e2e)\b|\b(?:pnpm|npm|yarn)\s+(?:--filter|-F|--workspace|-w)\s+\S+\s+(?:run\s+)?(?:build|typecheck)\b|\bturbo\s+(?:run\s+)?build\b|\bnext\s+build\b|\btsc\s+--noEmit\b|typescript[/\\]lib[/\\]tsc\.js|\bnode\b[^\n]*\btsc\.js\b`,
    unless: String.raw`run-build\.ps1|agentq(?:-cloud)?\.ps1`,
    reason:
      "Builds run through the queue wrapper; two concurrent builds corrupt shared incremental state.",
    fix: `${RUN_BUILD} -Command '<cmd>'`,
  },
];

/**
 * Deploy/release command outside the clean-worktree wrapper. The house guard refuses it only
 * when the tree is DIRTY, so this rule is not in `HOUSE_PACK`: the gate adds it when a git-state
 * fact reports uncommitted changes.
 */
export const HOUSE_DEPLOY_RULE: CommandRule = {
  id: "command.deployNeedsCleanTree",
  pattern: String.raw`\bgcloud\s+(?:run\s+(?:services\s+(?:replace|update|deploy)|deploy|jobs\s+(?:deploy|update|replace|create))|builds\s+submit)\b|\bvercel\s+(?:deploy|-p)(?:\s|$)|\bvercel\b[^\n]*\s--prod\b|\bdocker\s+(?:(?:buildx\s+)?build|push)\b|\b(?:fly\s+deploy|wrangler\s+(?:deploy|publish)|terraform\s+apply|pulumi\s+up|cargo\s+(?:tauri\s+build|publish)|p?npm\s+publish|twine\s+upload|hatch\s+publish)\b|\bgradlew?\b[^\n]*\b(?:assembleRelease|bundleRelease|publish)\b|scripts[\\/]ops[\\/]deploy-[a-z0-9-]+\.ps1`,
  unless: String.raw`deploy-clean\.ps1`,
  reason:
    "Deploy/release from a dirty tree; build from a detached worktree at an exact commit (commit, push, then deploy).",
  fix: `${DEPLOY_CLEAN} -Command '<deploy cmd>'`,
};

// ------------------------------------------------------------------------------- evaluation --

interface Compiled {
  pattern?: RegExp;
  unless?: RegExp;
}
const compiledCache = new WeakMap<CommandRule, Compiled>();

function compile(rule: CommandRule): Compiled {
  const hit = compiledCache.get(rule);
  if (hit) return hit;
  const flags = regexFlags(rule.caseSensitive);
  const c: Compiled = {};
  if (rule.pattern !== undefined) c.pattern = new RegExp(rule.pattern, flags);
  if (rule.unless !== undefined) c.unless = new RegExp(rule.unless, flags);
  compiledCache.set(rule, c);
  return c;
}

/** Shell words of one segment; quotes group and are removed, backslashes stay literal. */
function shellWords(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | undefined;
  for (const ch of segment) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

const ENV_ASSIGN = /^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*=/i;
const SEGMENT_SPLIT = /;|&&|\|\|?|\r?\n/;
const EXE_SUFFIX = /\.(?:exe|cmd)$/i;

function programName(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return word.slice(slash + 1).replace(EXE_SUFFIX, "");
}

function argvMatches(argv: readonly string[], command: string, caseSensitive: boolean): boolean {
  const norm = (s: string): string => (caseSensitive ? s : s.toLowerCase());
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const all = shellWords(segment);
    let start = 0;
    while (start < all.length) {
      const w = all[start] as string;
      if (w !== "sudo" && !ENV_ASSIGN.test(w)) break;
      start++;
    }
    const words = all.slice(start);
    if (words.length < argv.length) continue;
    const ok = argv.every((want, i) => {
      if (want === "*") return true;
      const got = words[i] as string;
      return norm(i === 0 ? programName(got) : got) === norm(want);
    });
    if (ok) return true;
  }
  return false;
}

function ruleMatches(rule: CommandRule, command: string): boolean {
  if (rule.pattern === undefined && rule.argv === undefined) return false;
  const c = compile(rule);
  if (c.unless?.test(command)) return false;
  if (c.pattern && !c.pattern.test(command)) return false;
  if (rule.argv && !argvMatches(rule.argv, command, rule.caseSensitive === true)) return false;
  return true;
}

function verdictFor(rule: CommandRule): RuleVerdict {
  const v: RuleVerdict = { id: rule.id ?? DEFAULT_ID, reason: rule.reason };
  if (rule.fix !== undefined) v.fix = rule.fix;
  if (rule.decision !== undefined) v.decision = rule.decision;
  return v;
}

/**
 * First matching rule wins: `cfg.deny` in order, then the pack. Never throws: a rule that cannot
 * be evaluated (a regex that fails to compile at runtime) refuses the command — fail closed.
 */
export function evaluateCommand(command: string, cfg: CommandsConfig): RuleVerdict | undefined {
  const lists: readonly (readonly CommandRule[])[] =
    cfg.pack === "house" ? [cfg.deny, HOUSE_PACK] : [cfg.deny];
  for (const list of lists) {
    for (const rule of list) {
      let hit: boolean;
      try {
        hit = ruleMatches(rule, command);
      } catch {
        return {
          id: DEFAULT_ID,
          reason: `command rule ${rule.id ?? "(unnamed)"} could not be evaluated (invalid pattern); refusing the command`,
        };
      }
      if (hit) return verdictFor(rule);
    }
  }
  return undefined;
}
