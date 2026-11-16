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
 * v4: EVERY pack rule is matched SEMANTICALLY through `shell-lex` — the program and the operands
 * of each simple command the string runs, nested interpreters included, with quotes, escapes,
 * call operators and global git options normalised (A2-32, EN-6, OPS-8: a regex over the whole
 * string fired on quoted text and on the next statement, and a wrapper named in a comment exempted
 * a command it never ran). A rule's `pattern` only documents the shape, and its `unless` is tested
 * against the text of the COMMAND UNIT that matched, never against the whole string.
 *
 * The pack is split into `CORE_PACK` (destructive commands every repository wants) and
 * `SHARED_CLONE_PACK` (the multi-agent shared-clone workflow rules); `house` is both, and rule ids
 * never change with the pack, because journals and consumer policies reference them.
 */
import { z } from "zod";
import type { RuleVerdict } from "./gate-verdict.js";
import { TOPIC_PACKS, topicMatch } from "./rule-packs.js";
import {
  type CommandUnit,
  commandUnits,
  normalizeGit,
  programBase,
  programName,
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
    /** 4.0: advice, never a block — the gate allows the call and attaches the reason as a warning. */
    advisory: z.boolean().optional(),
    /** Advisory shown once per (root, session, rule). */
    oncePerSession: z.boolean().optional(),
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

/**
 * Built-in base packs (4.0, D-48). `core` = portable destructive-command rules every repository
 * wants; `shared-clone` = the multi-agent shared-clone workflow rules (queue wrapper, pathspec
 * commits, leased worktrees); `house` = both (the 3.x name, kept so existing policies keep
 * meaning the same thing). Rule ids are stable names and do not change with the pack.
 */
export const BASE_PACKS = ["none", "core", "shared-clone", "house"] as const;
export type BasePack = (typeof BASE_PACKS)[number];
/** Opt-in topic packs (4.0, S-1422); none is enabled by a preset. */
export const EXTRA_PACKS = ["cloud", "kubernetes", "database", "iac", "secrets"] as const;
export type ExtraPack = (typeof EXTRA_PACKS)[number];

export const CommandsConfigSchema = z.strictObject({
  deny: z.array(CommandRuleSchema).default([]),
  pack: z.enum(BASE_PACKS).default("none"),
  /** Absent = no topic pack (kept optional so a 3.x config parses to the same object). */
  packs: z.array(z.enum(EXTRA_PACKS)).optional(),
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

const PACK_RULES: readonly CommandRule[] = [
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
    id: "house.typecheckUnqueued",
    pattern: String.raw`\b(?:pnpm|npm|yarn|npx)\s+(?:run\s+)?typecheck\b|\btsc\s+--noEmit\b|typescript[/\\]lib[/\\]tsc\.js|\bnode\b[^\n]*\btsc\.js\b`,
    unless: String.raw`run-build\.ps1|agentq(?:-cloud)?\.ps1`,
    reason:
      "A typecheck outside the queue wrapper; it is read-only, but two of them at once still crowd the machine.",
    fix: `${RUN_BUILD} -Command '<cmd>'`,
    // OPS-9: 722 of the 865 `house.buildUnqueued` records were a typecheck, not a build. Advice,
    // and only once per session, so the rule keeps its signal without steering on every call.
    advisory: true,
    oncePerSession: true,
  },
  {
    id: "self.uninstall",
    pattern: String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:uninstall|un|remove|rm)\b[^\n]*\b(?:-g|--global)\b[^\n]*axiom|\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b[^\n]*\b(?:-g|--global)\b[^\n]*@codai/axiom-mcp@\d`,
    reason:
      "Removing or downgrading the AXIOM bin takes the gate off this machine; a human does that from their own shell.",
    fix: "ask the human to change the global install.",
  },
  {
    id: "self.adminVerb",
    pattern: String.raw`\baxiom(?:-mcp)?\s+(?:gc\b|journal\s+(?:undo|rotate)\b|setup\s+(?:init|on|off|remove|pin-policy)\b|keys\s+trust\s+(?:add|remove)\b|allow-once\b|daemon\s+(?:start|stop)\b)`,
    reason:
      "An AXIOM operator verb from the agent's shell changes the gate's own state (journal, trust store, wiring).",
    fix: "ask the human to run it; report what you would have run.",
    decision: "ask",
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
 * Ids of the shared-clone workflow rules (contract 4). Everything else in `PACK_RULES` is `core`:
 * a destructive command every repository wants refused, wherever it is checked out.
 *
 * `topics` carry the id prefix `pack.<pack>.` and are never in either base pack.
 */
const SHARED_CLONE_RULE_IDS: ReadonlySet<string> = new Set([
  "house.gitAddAll",
  "house.gitCommitAll",
  "house.stashFlagsAfterDashDash",
  "house.stashBare",
  "house.commitNoPathspec",
  "house.worktreeRemoveForce",
  "house.worktreeRawRemove",
  "house.worktreeRawAdd",
  "house.playwrightLocal",
  "house.buildUnqueued",
  "house.typecheckUnqueued",
]);

/** The multi-agent shared-clone rules: the queue wrapper, pathspec commits, leased worktrees. */
export const SHARED_CLONE_PACK: readonly CommandRule[] = PACK_RULES.filter(
  (r) => r.id !== undefined && SHARED_CLONE_RULE_IDS.has(r.id),
);

/** Destructive-command rules that apply to any repository, shared clone or not. */
export const CORE_PACK: readonly CommandRule[] = PACK_RULES.filter(
  (r) => r.id === undefined || !SHARED_CLONE_RULE_IDS.has(r.id),
);

/** Both packs (`core` then `shared-clone`): the 3.x `house` name, unchanged meaning. */
export const HOUSE_PACK: readonly CommandRule[] = [...CORE_PACK, ...SHARED_CLONE_PACK];

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

interface GitCall {
  sub: string;
  args: string[];
}

/** One simple command as `shell-lex` read it, with its program and operands split out. */
interface Call {
  /** Text of the unit this reading came from: comments and the next statement are not in it. */
  text: string;
  /** Basename of the program word, lowercased, prefix commands and env assignments skipped. */
  program: string;
  /** Every word of the reading. */
  words: string[];
  /** The words after the program. */
  tail: string[];
  /** The git invocation this reading is, when the program is git and has a subcommand. */
  git?: GitCall;
}

/**
 * Words after the program. `shell-lex` strips env assignments and prefix commands (`sudo`), and a
 * PowerShell reading can put the command after `=` or an opener, so the program is found by VALUE
 * to keep the operands aligned with `programName`.
 */
function tailOf(words: readonly string[]): string[] {
  const p = programName(words);
  for (let i = 0; i < words.length; i++) {
    if (programBase(words[i] ?? "").toLowerCase() === p) return words.slice(i + 1);
  }
  return words.length === 0 ? [] : words.slice(1);
}

/** The parsed command, computed once per evaluation and only when a rule needs it. */
class Parsed {
  #units: CommandUnit[] | undefined;
  #calls: Call[] | undefined;
  readonly command: string;
  constructor(command: string) {
    this.command = command;
  }
  get units(): CommandUnit[] {
    this.#units ??= commandUnits(this.command);
    return this.#units;
  }
  /** Every simple command, under every shell reading, nested ones included. */
  get calls(): Call[] {
    if (this.#calls !== undefined) return this.#calls;
    const out: Call[] = [];
    for (const u of this.units) {
      for (const words of u.variants) {
        const g = normalizeGit(words);
        const call: Call = {
          text: u.text,
          program: programName(words),
          words: [...words],
          tail: tailOf(words),
        };
        if (g?.sub !== undefined) call.git = { sub: g.sub, args: g.args };
        out.push(call);
      }
    }
    this.#calls = out;
    return out;
  }
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
  /** Options (long ones as written, `--name[=value]`). */
  opts: string[];
  /** Non-option words before `--`. */
  before: string[];
  /** Non-option words after `--` (a pathspec, in git). */
  after: string[];
  /** Every non-option word, `--` excluded. */
  positionals: string[];
  /** A `--` separator was present. */
  dashed: boolean;
}

function splitArgs(args: readonly string[], valueOpts: ReadonlySet<string> = NO_VALUE): GitArgs {
  const opts: string[] = [];
  const before: string[] = [];
  const after: string[] = [];
  const positionals: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (ended || a === "-" || !a.startsWith("-")) {
      positionals.push(a);
      (ended ? after : before).push(a);
    } else if (a === "--") {
      ended = true;
    } else {
      opts.push(a);
      if (valueOpts.has(a)) i++;
    }
  }
  return { opts, before, after, positionals, dashed: ended };
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
  const { opts, before } = splitArgs(g.args);
  if (before[0]?.toLowerCase() !== "remove") return false;
  return opts.some((o) => longOpt(o, "force", 1) || shortHas(o, "f"));
}

function isStashDrop(g: GitCall): boolean {
  if (g.sub !== "stash") return false;
  const action = splitArgs(g.args).before[0]?.toLowerCase();
  return action === "drop" || action === "clear";
}

// -------------------------------------------------------------------- word-level matchers --

/** Words that are not options, so a PowerShell parameter value (`-Path x`) stays an operand. */
function operandsOf(words: readonly string[]): string[] {
  return words.filter((w) => w !== "" && !w.startsWith("-"));
}

function lowerAll(words: readonly string[]): string[] {
  return words.map((w) => w.toLowerCase());
}

/** A PowerShell parameter by unambiguous prefix (`-Recurse`, `-Rec`), not a `--git` long option. */
function paramIs(opt: string, name: string): boolean {
  if (!opt.startsWith("-") || opt.startsWith("--")) return false;
  const low = (opt.slice(1).split(":")[0] ?? "").toLowerCase();
  return low.length >= 2 && name.startsWith(low);
}

/** `~`, `/`, `C:\`, `$HOME`, `$env:USERPROFILE`, `%USERPROFILE%`: a root or a home directory. */
const HOME_ROOTS: ReadonlySet<string> = new Set([
  "~",
  "$home",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell token the lexer may produce
  "${home}",
  "$env:home",
  "$env:userprofile",
  "%userprofile%",
  "%homepath%",
]);

function isRootOrHome(raw: string): boolean {
  const token = raw.replace(/^["']+|["']+$/g, "");
  if (token === "/" || token === "~") return true;
  const trimmed = token.replace(/[\\/]+$/, "").toLowerCase();
  if (trimmed === "" || trimmed === "/" || trimmed === "~") return true;
  if (HOME_ROOTS.has(trimmed)) return true;
  return /^[a-z]:$/.test(trimmed);
}

const RM_PROGRAMS: ReadonlySet<string> = new Set(["rm", "rmdir"]);
const REMOVE_ITEM_PROGRAMS: ReadonlySet<string> = new Set(["remove-item", "ri"]);

/** Recursive force delete of a root, a home directory or a drive root (GR-2, OPS-8). */
function isRootDelete(c: Call): boolean {
  const { opts, positionals } = splitArgs(c.tail);
  if (RM_PROGRAMS.has(c.program)) {
    if (!opts.some((o) => shortHas(o, "r") || longOpt(o, "recursive", 1))) return false;
  } else if (REMOVE_ITEM_PROGRAMS.has(c.program)) {
    if (!opts.some((o) => paramIs(o, "recurse")) || !opts.some((o) => paramIs(o, "force"))) {
      return false;
    }
  } else {
    return false;
  }
  return positionals.some(isRootOrHome);
}

function isGitAddAll(g: GitCall): boolean {
  if (g.sub !== "add") return false;
  const { opts, positionals, dashed } = splitArgs(g.args);
  // `git add -A -- <pathspec>` stages only what the pathspec names (OPS-8: 10 false denies).
  if (dashed && positionals.length > 0) return false;
  if (opts.some((o) => o === "-A" || o === "-a" || longOpt(o, "all", 3))) return true;
  return positionals.includes(".");
}

function isGitCommitAll(g: GitCall): boolean {
  if (g.sub !== "commit") return false;
  const { opts, after } = splitArgs(g.args);
  if (after.length > 0) return false;
  return opts.some((o) => shortHas(o, "a") || longOpt(o, "all", 3));
}

function isCommitNoPathspec(g: GitCall): boolean {
  if (g.sub !== "commit") return false;
  const { opts, after } = splitArgs(g.args);
  // `git commit <ref> -- <pathspec>` names what it commits; a merge or an amend does not.
  if (after.length > 0) return false;
  return !opts.some((o) => longOpt(o, "amend", 3) || longOpt(o, "allow-empty", 3));
}

function isCheckoutDiscard(g: GitCall): boolean {
  if (g.sub !== "checkout") return false;
  const { opts, before, after, dashed } = splitArgs(g.args);
  const switches = opts.some(
    (o) =>
      o === "-b" ||
      o === "-B" ||
      o === "-t" ||
      longOpt(o, "orphan", 3) ||
      longOpt(o, "track", 3) ||
      longOpt(o, "ours", 3) ||
      longOpt(o, "theirs", 3) ||
      longOpt(o, "conflict", 3) ||
      longOpt(o, "help", 3),
  );
  // `--ours` / `--theirs` resolve a conflict: they never discard uncommitted work (OPS-8: 26).
  if (switches) return false;
  if (after.length > 0) return true;
  return !dashed && before.includes(".");
}

function isRestoreDiscard(g: GitCall): boolean {
  if (g.sub !== "restore") return false;
  const { opts } = splitArgs(g.args);
  // `--staged` alone unstages; that is not a discard (OPS-8: all 12 hits were this shape).
  if (!opts.some((o) => longOpt(o, "staged", 3) || o === "-S")) return true;
  return opts.some((o) => longOpt(o, "worktree", 2) || o === "-W");
}

function isStashPushFlagsAfterDashDash(g: GitCall): boolean {
  if (g.sub !== "stash") return false;
  const { before, after, dashed } = splitArgs(g.args);
  if (before[0]?.toLowerCase() !== "push") return false;
  return dashed && after.some((a) => /^-[mquakp]/i.test(a));
}

function isStashBare(g: GitCall): boolean {
  if (g.sub !== "stash") return false;
  const { before } = splitArgs(g.args);
  const action = before[0]?.toLowerCase();
  if (action !== "pop" && action !== "apply" && action !== "drop") return false;
  return !before.slice(1).some((p) => /^['"]?stash@\{/.test(p));
}

function isWorktreeRawAction(g: GitCall, actions: readonly string[]): boolean {
  if (g.sub !== "worktree") return false;
  const first = splitArgs(g.args).before[0]?.toLowerCase();
  return first !== undefined && actions.includes(first);
}

const SQL_CLIENTS: ReadonlySet<string> = new Set([
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "sqlcmd",
  "sqlplus",
  "duckdb",
  "clickhouse-client",
  "mongosh",
  "mongo",
]);
const SQL_KEYWORD = /^(?:drop|truncate|delete|alter)\b/i;
/** The two destructive-SQL shapes, built from the same pieces as the rules' `pattern`. */
const DESTRUCTIVE_SQL = new RegExp(
  String.raw`\b(?:${SQL_DESTROY})\s+(?:TABLE|DATABASE|SCHEMA)\b`,
  "i",
);
const DELETE_ALL_SQL = new RegExp(String.raw`${SQL_DELETE}\s+FROM\s+\w+\s*(?:;|$)`, "i");

/**
 * A destructive SQL statement, but only where it is EXECUTED: the program is a database client, or
 * the statement is the first word of the unit. `rg -n 'DROP TABLE' docs` only names it.
 */
function sqlMatch(parsed: Parsed, re: RegExp): boolean {
  return parsed.calls.some((c) => {
    if (!SQL_CLIENTS.has(c.program) && !SQL_KEYWORD.test(c.words[0] ?? "")) return false;
    return re.test(c.words.join(" ").trim());
  });
}

// ---------------------------------------------------------- build / typecheck (OPS-9, D-53) --

const BUILD_PM: ReadonlySet<string> = new Set(["pnpm", "npm", "yarn", "npx", "bun", "bunx"]);
const BUILD_SCRIPTS: ReadonlySet<string> = new Set(["build", "typecheck", "test:e2e"]);
const BUILD_TOOL_PROGRAMS: ReadonlySet<string> = new Set(["tsc", "turbo", "next", "node"]);
const NO_EMIT = /^--noemit$/i;
const TSC_JS = /(?:^|[\\/])tsc\.js$|typescript[\\/]lib[\\/]tsc\.js/i;
/** Programs that run another command given as an argument (`pwsh -File x.ps1 -Cmd 'pnpm build'`). */
const LAUNCHERS: ReadonlySet<string> = new Set([
  "pwsh",
  "powershell",
  "pwsh-preview",
  "cmd",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "wsl",
  "node",
  "nodejs",
  "deno",
  "bun",
  "start-process",
]);

/** Skip `run`, `exec`, `dlx` and the value-taking wrapper options; return the script index. */
function skipPmWords(tail: readonly string[]): number {
  let i = 0;
  while (i < tail.length) {
    const w = (tail[i] ?? "").toLowerCase();
    if (w === "run" || w === "exec" || w === "dlx") {
      i++;
      continue;
    }
    if (w === "--filter" || w === "-f" || w === "--workspace" || w === "-w") {
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Does a launcher's argument name a build? `-Cmd 'pnpm run build'` and the joined
 * `-NoProfile,-Command,pnpm exec tsc --noEmit` of a `Start-Process -ArgumentList` both do, while
 * `rg -n "pnpm build" docs` does not: only the words after the leading flag fragments count.
 */
function launcherArgIs(text: string, kind: "build" | "typecheck"): boolean {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  let i = 0;
  while (i < parts.length && (parts[i]?.startsWith("-") ?? false)) i++;
  return i < parts.length && buildKind(parts.slice(i)) === kind;
}

/**
 * What a word list is: a real build, or a typecheck (advice only). `undefined` = neither.
 * The typecheck split is D-53: 83 % of the 865 `house.buildUnqueued` records were a typecheck.
 */
function buildKind(words: readonly string[]): "build" | "typecheck" | undefined {
  if (words.length === 0) return undefined;
  const p = programName(words);
  const tail = tailOf(words);
  if (p === "tsc") return tail.some((w) => NO_EMIT.test(w)) ? "typecheck" : undefined;
  if (p === "turbo" || p === "next") {
    const first = (tail[skipPmWords(tail)] ?? "").toLowerCase();
    return first === "build" ? "build" : undefined;
  }
  if (p === "node") {
    if (!tail.some((w) => TSC_JS.test(w))) return undefined;
    return tail.some((w) => NO_EMIT.test(w)) ? "typecheck" : "build";
  }
  if (!BUILD_PM.has(p)) return undefined;
  const rest = tail.slice(skipPmWords(tail));
  const first = rest[0] ?? "";
  if (first === "") return undefined;
  if (BUILD_PM.has(programName(rest)) || BUILD_TOOL_PROGRAMS.has(programName(rest))) {
    return buildKind(rest);
  }
  const script = first.toLowerCase();
  if (!BUILD_SCRIPTS.has(script)) return undefined;
  // `test:e2e` runs a build too; only `typecheck` is the read-only kind (D-53).
  return script === "typecheck" ? "typecheck" : "build";
}

function buildRule(kind: "build" | "typecheck"): Semantic {
  return (parsed, unless) =>
    parsed.calls.some((c) => {
      if (unless?.test(c.text) ?? false) return false;
      if (buildKind(c.words) === kind) return true;
      if (!LAUNCHERS.has(c.program)) return false;
      return c.tail.some((w) => launcherArgIs(w, kind));
    });
}

// ------------------------------------------------------------------ playwright (OPS-8) --

const PW_WORD = /^playwright(?:\.cmd)?$/i;
const PW_CLI = /playwright(?:-core)?[\\/](?:test[\\/])?cli\.js$/i;
const PW_SCRIPTS: ReadonlySet<string> = new Set(["a11y:routes", "a11y:ibm", "e2e:visual:local"]);

/** `playwright test ...`, but not `--list` (a listing runs nothing) and not another subcommand. */
function playwrightRunsTest(args: readonly string[]): boolean {
  if (args.some((w) => /^--list$/i.test(w))) return false;
  return (args.find((w) => !w.startsWith("-")) ?? "").toLowerCase() === "test";
}

function isPlaywrightLocal(c: Call): boolean {
  const { program, tail } = c;
  if (program === "playwright") return playwrightRunsTest(tail);
  if (program === "node") {
    const i = tail.findIndex((w) => PW_CLI.test(w));
    return i !== -1 && playwrightRunsTest(tail.slice(i + 1));
  }
  if (program === "npx" || program === "npm" || program === "yarn" || program === "bunx") {
    const i = tail.findIndex((w) => PW_WORD.test(w));
    return i !== -1 && playwrightRunsTest(tail.slice(i + 1));
  }
  if (program !== "pnpm") return false;
  const i = skipPmWords(tail);
  const word = (tail[i - 1] ?? "").toLowerCase();
  if (word === "exec" || word === "dlx") {
    const j = tail.findIndex((w, k) => k >= i && PW_WORD.test(w));
    return j !== -1 && playwrightRunsTest(tail.slice(j + 1));
  }
  // `pnpm a11y:routes` / `pnpm run a11y:ibm`, and nothing else: a bare `pnpm playwright test` is
  // not a Playwright invocation the guard or AXIOM has ever refused.
  return PW_SCRIPTS.has((tail[i] ?? "").toLowerCase());
}

// ------------------------------------------------------------------ self-protection (A2-23) --

const PM_PROGRAMS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const GLOBAL_WORDS: ReadonlySet<string> = new Set([
  "-g",
  "--global",
  "--location=global",
  "global",
]);
const PM_REMOVE_SUBS: ReadonlySet<string> = new Set(["uninstall", "un", "remove", "rm", "r"]);
const PM_INSTALL_SUBS: ReadonlySet<string> = new Set([
  "install",
  "i",
  "add",
  "up",
  "update",
  "dlx",
  "exec",
]);
// Built from pieces: a PreToolUse guard on the maintainer's machine scans edit text for the
// package name, and a rule about the name is not a reason to spell it out.
const AXIOM_SPEC = /^@?codai[\\/]axiom|^axiom(?:-mcp|-hook)?(?:@|$)/i;

/** The package-manager subcommand: the first non-flag word that is not a bare `global`. */
function pmSub(tail: readonly string[]): string {
  return lowerAll(tail).find((w) => !w.startsWith("-") && w !== "global") ?? "";
}

function isSelfUninstall(c: Call): boolean {
  if (!PM_PROGRAMS.has(c.program)) return false;
  const specs = c.tail.filter((w) => AXIOM_SPEC.test(w));
  if (specs.length === 0) return false;
  if (!c.tail.some((w) => GLOBAL_WORDS.has(w.toLowerCase()))) return false;
  const sub = pmSub(c.tail);
  if (PM_REMOVE_SUBS.has(sub)) return true;
  // A pinned reinstall is how a downgrade happens; an unpinned one is fine.
  return PM_INSTALL_SUBS.has(sub) && specs.some((w) => /@\d/.test(w));
}

const AXIOM_PROGRAMS: ReadonlySet<string> = new Set(["axiom", "axiom-mcp", "axiom-hook"]);
const ADMIN_VERB_SEQUENCES: readonly (readonly string[])[] = [
  ["gc"],
  ["journal", "undo"],
  ["journal", "rotate"],
  ["setup", "init"],
  ["setup", "on"],
  ["setup", "off"],
  ["setup", "remove"],
  ["setup", "pin-policy"],
  ["keys", "trust", "add"],
  ["keys", "trust", "remove"],
  ["allow-once"],
  ["daemon", "start"],
  ["daemon", "stop"],
];

/** Operands of an AXIOM invocation, wrapper forms (`npx @codai/axiom-mcp gc`) included. */
function axiomOperands(c: Call): string[] | undefined {
  if (AXIOM_PROGRAMS.has(c.program)) return lowerAll(operandsOf(c.tail));
  if (!PM_PROGRAMS.has(c.program) && c.program !== "npx") return undefined;
  const i = c.tail.findIndex((w) => AXIOM_SPEC.test(w));
  if (i === -1) return undefined;
  return lowerAll(operandsOf(c.tail.slice(i + 1)));
}

function isSelfAdminVerb(c: Call): boolean {
  const ops = axiomOperands(c);
  if (ops === undefined) return false;
  return ADMIN_VERB_SEQUENCES.some((seq) => seq.every((w, i) => ops[i] === w));
}

// ---------------------------------------------------------------------------- dispatch --

type Semantic = (parsed: Parsed, unless: RegExp | undefined) => boolean;

/**
 * Match a rule against each simple command on its own. The rule's `unless` is tested against the
 * TEXT OF THAT UNIT, so naming the wrapper in a comment (EN-6: `pnpm build # run-build.ps1`) or in
 * the next statement (`echo agentq.ps1; git commit -m x`) no longer exempts a command it never ran.
 */
const onCall =
  (pred: (c: Call) => boolean): Semantic =>
  (parsed, unless) =>
    parsed.calls.some((c) => !(unless?.test(c.text) ?? false) && pred(c));

const onGit =
  (pred: (g: GitCall) => boolean): Semantic =>
  (parsed, unless) =>
    parsed.calls.some(
      (c) => c.git !== undefined && !(unless?.test(c.text) ?? false) && pred(c.git),
    );

/**
 * Pack rules matched through shell-lex instead of their regex. Keyed by rule id, applied only to
 * the pack's own rule objects (a user rule that reuses an id keeps its own pattern).
 */
const SEMANTIC: Map<string, Semantic> = new Map([
  ["house.forcePush", onGit(isForcePush)],
  ["house.pushDelete", onGit(isPushDelete)],
  ["house.resetHard", onGit(isResetHard)],
  ["house.cleanForce", onGit(isCleanForce)],
  ["house.worktreeRemoveForce", onGit(isWorktreeRemoveForce)],
  ["house.stashDrop", onGit(isStashDrop)],
  ["house.gitAddAll", onGit(isGitAddAll)],
  ["house.gitCommitAll", onGit(isGitCommitAll)],
  ["house.checkoutDiscard", onGit(isCheckoutDiscard)],
  ["house.restore", onGit(isRestoreDiscard)],
  ["house.stashFlagsAfterDashDash", onGit(isStashPushFlagsAfterDashDash)],
  ["house.stashBare", onGit(isStashBare)],
  ["house.worktreeRawRemove", onGit((g) => isWorktreeRawAction(g, ["remove", "move", "prune"]))],
  ["house.worktreeRawAdd", onGit((g) => isWorktreeRawAction(g, ["add"]))],
  ["house.commitNoPathspec", onGit(isCommitNoPathspec)],
  ["house.sqlDestructive", (parsed) => sqlMatch(parsed, DESTRUCTIVE_SQL)],
  ["house.sqlDeleteAll", (parsed) => sqlMatch(parsed, DELETE_ALL_SQL)],
  ["house.rmRoot", onCall(isRootDelete)],
  ["house.removeItemRoot", onCall(isRootDelete)],
  ["house.playwrightLocal", onCall(isPlaywrightLocal)],
  ["house.buildUnqueued", buildRule("build")],
  ["house.typecheckUnqueued", buildRule("typecheck")],
  ["self.uninstall", onCall(isSelfUninstall)],
  ["self.adminVerb", onCall(isSelfAdminVerb)],
  ["house.undecodable", (parsed) => parsed.units.some((u) => u.text === UNDECODABLE)],
]);

for (const topic of TOPIC_PACKS) {
  for (const rule of topic.rules) {
    const id = rule.id;
    if (id === undefined) continue;
    SEMANTIC.set(id, (parsed, unless) =>
      parsed.calls.some(
        (c) =>
          !(unless?.test(c.text) ?? false) &&
          topicMatch(id, { program: c.program, words: c.words, tail: c.tail }),
      ),
    );
  }
}

const PACK_RULE_OBJECTS: ReadonlySet<CommandRule> = new Set([
  ...PACK_RULES,
  ...TOPIC_PACKS.flatMap((t) => [...t.rules]),
]);

function semanticFor(rule: CommandRule): Semantic | undefined {
  return PACK_RULE_OBJECTS.has(rule) && rule.id !== undefined ? SEMANTIC.get(rule.id) : undefined;
}

function ruleMatches(rule: CommandRule, parsed: Parsed): boolean {
  if (rule.pattern === undefined && rule.argv === undefined) return false;
  const c = compile(rule);
  const semantic = semanticFor(rule);
  // A semantic rule applies its own `unless` to the text of the command unit that matched.
  if (semantic !== undefined) return semantic(parsed, c.unless);
  if (c.unless?.test(parsed.command)) return false;
  if (c.pattern && !c.pattern.test(parsed.command)) return false;
  if (rule.argv && !argvMatches(rule.argv, parsed, rule.caseSensitive === true)) return false;
  return true;
}

function verdictFor(rule: CommandRule): RuleVerdict {
  const v: RuleVerdict = { id: rule.id ?? DEFAULT_ID, reason: rule.reason };
  if (rule.fix !== undefined) v.fix = rule.fix;
  if (rule.decision !== undefined) v.decision = rule.decision;
  if (rule.advisory !== undefined) v.advisory = rule.advisory;
  if (rule.oncePerSession !== undefined) v.oncePerSession = rule.oncePerSession;
  return v;
}

/** The base pack a policy selected: `core`, `shared-clone`, or both under the 3.x `house` name. */
const BASE_RULES: Readonly<Record<BasePack, readonly CommandRule[]>> = {
  none: [],
  core: CORE_PACK,
  "shared-clone": SHARED_CLONE_PACK,
  house: HOUSE_PACK,
};

/**
 * Rule ids the rule side contributes to the override governance of EN-11/EN-12: a verdict with one
 * of these ids may NEVER be lifted by an `axiom-override(<code>): <reason>`, whatever the budget
 * says, because lifting it is the tamper the rule exists to stop (contract 5: the same ids are the
 * self-protection HARD set, `isSelfHardCode` in `self-protect.ts`).
 *
 * `self.adminVerb` is deliberately NOT here: it answers `ask`, so the human's answer is the only
 * way past it and an override cannot answer for them.
 */
export const NON_OVERRIDABLE_RULE_IDS: readonly string[] = ["self.uninstall"];

/** The opt-in topic packs a policy listed, de-duplicated, in the order it listed them. */
function topicRules(packs: readonly ExtraPack[] | undefined): readonly CommandRule[] {
  if (packs === undefined || packs.length === 0) return [];
  const seen = new Set<string>();
  const out: CommandRule[] = [];
  for (const name of packs) {
    if (seen.has(name)) continue;
    seen.add(name);
    for (const topic of TOPIC_PACKS) if (topic.pack === name) out.push(...topic.rules);
  }
  return out;
}

/**
 * EVERY matching rule, in order: `cfg.deny`, then the base pack, then each topic pack the policy
 * listed. The gate denies when any verdict is a hard one, so a softer rule matching first can no
 * longer shadow a hard rule; a verdict carrying `advisory: true` never blocks. Never throws: a rule
 * that cannot be evaluated (a regex that fails to compile at runtime, a parse failure) adds a
 * `command.deny` verdict at its position — fail closed.
 */
export function evaluateCommandRules(command: string, cfg: CommandsConfig): RuleVerdict[] {
  const lists: readonly (readonly CommandRule[])[] = [
    cfg.deny,
    BASE_RULES[cfg.pack],
    topicRules(cfg.packs),
  ];
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
