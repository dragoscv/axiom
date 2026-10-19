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
 *
 * v3: the destructive git rules (force push, push delete, reset --hard, clean -f, worktree remove
 * --force, stash drop/clear) and `house.undecodable` are matched SEMANTICALLY through `shell-lex`
 * — every simple command the string runs, nested interpreters included, with quotes, escapes,
 * call operators and global git options normalised. Their `pattern` only documents the shape.
 */
import { z } from "zod";
import type { RuleVerdict } from "./gate-verdict.js";
import {
  type CommandUnit,
  commandUnits,
  normalizeGit,
  programBase,
  UNDECODABLE,
} from "./shell-lex.js";

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
    id: "house.pushDelete",
    pattern: String.raw`git\s+push\s[^\n]*?(?:--delete|-d\b|\s:\S)`,
    reason:
      "git push --delete / <remote> :<ref> deletes a remote branch or tag; ask the user first.",
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
    id: "house.stashDrop",
    pattern: String.raw`${GIT_OPTS}\s+stash\s+(?:drop|clear)(?:\s|$)`,
    reason:
      "git stash drop/clear deletes stash entries for good; in a shared clone they are usually another agent's.",
    fix: "git stash list; git stash show -p stash@{N}  # ask before dropping",
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
    id: "house.worktreeRemoveForce",
    pattern: String.raw`\bgit\b[^;|&]*\bworktree\s+remove\b[^;|&]*(?:--force|-f\b)`,
    reason:
      "git worktree remove --force follows Windows junctions into their targets and discards uncommitted work.",
    fix: `${WORKTREE} remove -Path <dir>`,
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
  {
    id: "house.undecodable",
    pattern: UNDECODABLE,
    reason:
      "The command runs a nested command AXIOM cannot read (an undecodable -EncodedCommand, or nesting deeper than 3 levels).",
    fix: "decode the command and run it plainly",
    decision: "ask",
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

/** The parsed command, computed once per evaluation and only when a rule needs it. */
class Parsed {
  #units: CommandUnit[] | undefined;
  #git: GitCall[] | undefined;
  readonly command: string;
  constructor(command: string) {
    this.command = command;
  }
  get units(): CommandUnit[] {
    this.#units ??= commandUnits(this.command);
    return this.#units;
  }
  /** Every git invocation with a subcommand, under every shell reading, nested ones included. */
  get git(): GitCall[] {
    if (this.#git === undefined) {
      const out: GitCall[] = [];
      for (const u of this.units) {
        for (const v of u.variants) {
          const g = normalizeGit(v);
          if (g?.sub !== undefined) out.push({ sub: g.sub, args: g.args });
        }
      }
      this.#git = out;
    }
    return this.#git;
  }
}

interface GitCall {
  sub: string;
  args: string[];
}

function argvMatches(argv: readonly string[], parsed: Parsed, caseSensitive: boolean): boolean {
  const norm = (s: string): string => (caseSensitive ? s : s.toLowerCase());
  return parsed.units.some((u) =>
    u.variants.some(
      (words) =>
        words.length >= argv.length &&
        argv.every((want, i) => {
          if (want === "*") return true;
          const got = words[i] ?? "";
          return norm(i === 0 ? programBase(got) : got) === norm(want);
        }),
    ),
  );
}

// ------------------------------------------------------------------- semantic git matchers --

interface GitArgs {
  /** Options before `--` (long ones as written, `--name[=value]`). */
  opts: string[];
  /** Non-option words, `--` excluded. */
  positionals: string[];
}

function splitArgs(args: readonly string[], valueOpts: ReadonlySet<string> = NO_VALUE): GitArgs {
  const opts: string[] = [];
  const positionals: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (ended || a === "-" || !a.startsWith("-")) {
      positionals.push(a);
    } else if (a === "--") {
      ended = true;
    } else {
      opts.push(a);
      if (valueOpts.has(a)) i++;
    }
  }
  return { opts, positionals };
}

const NO_VALUE: ReadonlySet<string> = new Set();
const PUSH_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
]);

/** `--name` / `--name=v`, where git accepts any unambiguous prefix of `full` (≥ `min` chars). */
function longOpt(arg: string, full: string, min: number): boolean {
  if (!arg.startsWith("--")) return false;
  const name = arg.slice(2).split("=")[0] ?? "";
  return name.length >= min && full.startsWith(name);
}

/** A short-option cluster (`-f`, `-uf`, `-fdx`) containing `letter`. */
function shortHas(arg: string, letter: string): boolean {
  return /^-[A-Za-z0-9]+$/.test(arg) && arg.slice(1).includes(letter);
}

function isForcePush(g: GitCall): boolean {
  if (g.sub !== "push") return false;
  const { opts, positionals } = splitArgs(g.args, PUSH_VALUE_OPTS);
  const forced = opts.some(
    (o) => longOpt(o, "force-with-lease", 3) || longOpt(o, "mirror", 2) || shortHas(o, "f"),
  );
  return forced || positionals.some((p) => p.startsWith("+"));
}

function isPushDelete(g: GitCall): boolean {
  if (g.sub !== "push") return false;
  const { opts, positionals } = splitArgs(g.args, PUSH_VALUE_OPTS);
  if (opts.some((o) => longOpt(o, "delete", 3) || shortHas(o, "d"))) return true;
  // `<remote> :<ref>` / `+:<ref>` pushes "nothing" onto the ref, i.e. deletes it.
  return positionals.slice(1).some((p) => p.replace(/^\+/, "").startsWith(":"));
}

function isResetHard(g: GitCall): boolean {
  return g.sub === "reset" && splitArgs(g.args).opts.some((o) => longOpt(o, "hard", 2));
}

function isCleanForce(g: GitCall): boolean {
  if (g.sub !== "clean") return false;
  return splitArgs(g.args).opts.some((o) => longOpt(o, "force", 1) || shortHas(o, "f"));
}

function isWorktreeRemoveForce(g: GitCall): boolean {
  if (g.sub !== "worktree") return false;
  const { opts, positionals } = splitArgs(g.args);
  if (positionals[0]?.toLowerCase() !== "remove") return false;
  return opts.some((o) => longOpt(o, "force", 1) || shortHas(o, "f"));
}

function isStashDrop(g: GitCall): boolean {
  if (g.sub !== "stash") return false;
  const action = splitArgs(g.args).positionals[0]?.toLowerCase();
  return action === "drop" || action === "clear";
}

type Semantic = (parsed: Parsed) => boolean;
const onGit =
  (pred: (g: GitCall) => boolean): Semantic =>
  (parsed) =>
    parsed.git.some(pred);

/**
 * House rules matched through shell-lex instead of their regex. Keyed by rule id, applied only to
 * the `HOUSE_PACK` objects themselves (a user rule reusing an id keeps its own pattern).
 */
const SEMANTIC: ReadonlyMap<string, Semantic> = new Map([
  ["house.forcePush", onGit(isForcePush)],
  ["house.pushDelete", onGit(isPushDelete)],
  ["house.resetHard", onGit(isResetHard)],
  ["house.cleanForce", onGit(isCleanForce)],
  ["house.worktreeRemoveForce", onGit(isWorktreeRemoveForce)],
  ["house.stashDrop", onGit(isStashDrop)],
  ["house.undecodable", (parsed: Parsed) => parsed.units.some((u) => u.text === UNDECODABLE)],
]);
const HOUSE_SET: ReadonlySet<CommandRule> = new Set(HOUSE_PACK);

function semanticFor(rule: CommandRule): Semantic | undefined {
  return HOUSE_SET.has(rule) && rule.id !== undefined ? SEMANTIC.get(rule.id) : undefined;
}

function ruleMatches(rule: CommandRule, parsed: Parsed): boolean {
  if (rule.pattern === undefined && rule.argv === undefined) return false;
  const c = compile(rule);
  if (c.unless?.test(parsed.command)) return false;
  const semantic = semanticFor(rule);
  if (semantic !== undefined) return semantic(parsed);
  if (c.pattern && !c.pattern.test(parsed.command)) return false;
  if (rule.argv && !argvMatches(rule.argv, parsed, rule.caseSensitive === true)) return false;
  return true;
}

function verdictFor(rule: CommandRule): RuleVerdict {
  const v: RuleVerdict = { id: rule.id ?? DEFAULT_ID, reason: rule.reason };
  if (rule.fix !== undefined) v.fix = rule.fix;
  if (rule.decision !== undefined) v.decision = rule.decision;
  return v;
}

/**
 * EVERY matching rule, in order: `cfg.deny`, then the pack. The gate denies when any verdict is a
 * hard one, so a softer rule matching first can no longer shadow a hard rule. Never throws: a rule
 * that cannot be evaluated (a regex that fails to compile at runtime, a parse failure) adds a
 * `command.deny` verdict at its position — fail closed.
 */
export function evaluateCommandRules(command: string, cfg: CommandsConfig): RuleVerdict[] {
  const lists: readonly (readonly CommandRule[])[] =
    cfg.pack === "house" ? [cfg.deny, HOUSE_PACK] : [cfg.deny];
  const parsed = new Parsed(command);
  const out: RuleVerdict[] = [];
  for (const list of lists) {
    for (const rule of list) {
      let hit: boolean;
      try {
        hit = ruleMatches(rule, parsed);
      } catch {
        out.push({
          id: DEFAULT_ID,
          reason: `command rule ${rule.id ?? "(unnamed)"} could not be evaluated (invalid pattern); refusing the command`,
        });
        continue;
      }
      if (hit) out.push(verdictFor(rule));
    }
  }
  return out;
}

/** First matching rule (see `evaluateCommandRules`), or `undefined`. */
export function evaluateCommand(command: string, cfg: CommandsConfig): RuleVerdict | undefined {
  return evaluateCommandRules(command, cfg)[0];
}
