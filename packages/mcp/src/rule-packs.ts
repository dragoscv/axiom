/**
 * Topic packs (4.0, S-1422): optional rule sets for a technology an agent can destroy with one
 * command. **None of them is enabled by a base pack or by a preset** - a policy opts in with
 * `commands.packs: ["cloud", "kubernetes"]`, because every one of these rules depends on the
 * project (a repository with no cloud account should never see an `aws` rule).
 *
 * Every rule matches a PROGRAM plus its operands, through the shell-lex word list the gate already
 * computed (`topicMatch`), never a regex over the raw command: quoted text, comments, a heredoc
 * body and the next statement cannot trigger or satisfy a rule. The `pattern` of each rule only
 * documents the shape.
 *
 * This module holds data and matchers only. It imports `command-rules.ts` for the `CommandRule`
 * TYPE (erased at runtime), so `command-rules.ts` can import these packs at runtime without a
 * cycle.
 */
import type { CommandRule, ExtraPack } from "./command-rules.js";

/** One simple command, already tokenised by shell-lex (see `command-rules.ts`). */
export interface PackCall {
  /** Basename of the program word, lowercased, prefix commands and env assignments skipped. */
  program: string;
  /** Every word of the reading. */
  words: readonly string[];
  /** The words after the program. */
  tail: readonly string[];
}

export interface TopicPack {
  pack: ExtraPack;
  rules: readonly CommandRule[];
}

// ------------------------------------------------------------------------------- words --

/** Basename without a Windows executable suffix, lowercased. */
function base(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return word
    .slice(slash + 1)
    .replace(/\.(?:exe|cmd|bat|com)$/i, "")
    .toLowerCase();
}

function isFlag(word: string): boolean {
  return word.startsWith("-") || word.startsWith("/");
}

/** Words that are not options. A PowerShell parameter value (`-Path x`) stays an operand. */
function operands(tail: readonly string[]): string[] {
  return tail.filter((w) => w !== "" && !isFlag(w));
}

function hasFlag(tail: readonly string[], ...names: string[]): boolean {
  const want = new Set(names.map((n) => n.toLowerCase()));
  return tail.some((w) => want.has(w.toLowerCase()));
}

/** Lowercased words, so `kubectl DELETE Namespace` matches the same rule as the plain form. */
function lower(words: readonly string[]): string[] {
  return words.map((w) => w.toLowerCase());
}

/** Package-manager prefixes that only forward to another program. */
const WRAPPERS = new Set(["npx", "pnpm", "npm", "yarn", "bunx", "bun"]);
/** Wrapper words that forward to the next word instead of running a script themselves. */
// `run` is deliberately absent: `pnpm run <name>` runs a SCRIPT, so `<name>` is not a program.
const WRAPPER_FORWARD = new Set(["exec", "dlx", "x"]);
/** Wrapper options that take a separate value (`pnpm --filter @x/y exec ...`). */
const WRAPPER_VALUE_OPTS = new Set(["--filter", "-F", "--workspace", "-w", "--dir", "-C"]);
/** Programs this module knows about: the only ones a wrapper is unwrapped for. */
const TOOL_PROGRAMS = new Set([
  "aws",
  "gcloud",
  "az",
  "railway",
  "kubectl",
  "oc",
  "k",
  "helm",
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "sqlcmd",
  "mongo",
  "mongosh",
  "sqlplus",
  "duckdb",
  "prisma",
  "terraform",
  "tofu",
  "pulumi",
  "cdk",
  "flyctl",
  "fly",
  "curl",
  "wget",
]);

/**
 * The program a call really runs and its operands: `npx prisma migrate reset` -> `prisma` +
 * `migrate reset`, `pnpm --filter @x/y exec kubectl delete ns prod` -> `kubectl` + the rest.
 * Only a known tool is unwrapped, so `pnpm run build` stays a `pnpm` call. Best effort: an
 * unknown wrapper is left as it is rather than guessed at.
 */
function resolve(call: PackCall): { program: string; tail: string[] } {
  const program = call.program.toLowerCase();
  const tail = [...call.tail];
  if (!WRAPPERS.has(program)) return { program, tail };
  let i = 0;
  while (i < tail.length) {
    const w = tail[i] ?? "";
    if (WRAPPER_VALUE_OPTS.has(w)) {
      i += 2;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const word = (tail[i] ?? "").toLowerCase();
  if (WRAPPER_FORWARD.has(word)) {
    i++;
    while (WRAPPER_VALUE_OPTS.has((tail[i] ?? "").toLowerCase())) i += 2;
  }
  const sub = base(tail[i] ?? "");
  if (sub === "" || !TOOL_PROGRAMS.has(sub)) return { program, tail };
  return { program: sub, tail: tail.slice(i + 1) };
}

// ---------------------------------------------------------------------------- matchers --

const SQL_CLIENTS = new Set([
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "sqlcmd",
  "sqlplus",
  "duckdb",
  "clickhouse-client",
]);
const MONGO_CLIENTS = new Set(["mongo", "mongosh"]);
const DESTRUCTIVE_SQL =
  /(?:drop|truncate)\s+(?:table|database|schema)\b|dropdatabase\s*\(|\.drop\s*\(/i;
/** Programs that read or move a file's content. */
const READERS = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "less",
  "more",
  "head",
  "tail",
  "strings",
  "xxd",
  "od",
  "sed",
  "awk",
  "rg",
  "grep",
  "findstr",
  "select-string",
  "find",
  "cp",
  "copy",
  "copy-item",
  "mv",
  "move",
  "move-item",
  "scp",
  "rsync",
  "tar",
  "zip",
  "base64",
  "certutil",
  "openssl",
  "gpg",
  "docker",
  "node",
  "nodejs",
  "python",
  "python3",
  "bash",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
  "git",
  "open",
  "notepad",
  "code",
]);
/** Programs that can send what they read somewhere else. */
const EGRESS = new Set([
  "curl",
  "wget",
  "iwr",
  "invoke-webrequest",
  "invoke-restmethod",
  "ssh",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "aws",
  "gcloud",
  "az",
]);
/** A path that holds a live credential rather than its placeholder. */
const CREDENTIAL_TAIL =
  /(?:^|[\\/])(?:\.env(?:\.[a-z0-9_-]+)?|\.aws[\\/](?:credentials|config|cli\/cache)|\.ssh[\\/]id_[a-z0-9_.-]+|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.docker[\\/]config\.json)$/i;
const PLACEHOLDER_TAIL = /(?:example|sample|template|dist|md|txt|pub)$/i;

function credentialPath(word: string): boolean {
  let w = word.replace(/^["']+|["']+$/g, "");
  const at = w.lastIndexOf("@");
  if (at !== -1) w = w.slice(at + 1);
  const eq = w.lastIndexOf("=");
  if (eq !== -1) w = w.slice(eq + 1);
  if (w === "" || !CREDENTIAL_TAIL.test(w)) return false;
  const name = w.slice(Math.max(w.lastIndexOf("/"), w.lastIndexOf("\\")) + 1);
  return !PLACEHOLDER_TAIL.test(name.split(".").pop() ?? "");
}

function awsRecursiveDelete(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "aws") return false;
  const ops = lower(operands(tail));
  if (ops[0] !== "s3") return false;
  if (ops.includes("rm")) return hasFlag(tail, "--recursive");
  return ops.includes("rb") && hasFlag(tail, "--force");
}

function gcloudDelete(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "gcloud") return false;
  const ops = lower(operands(tail));
  if (ops.includes("delete") || ops.includes("destroy")) return true;
  return ops[0] === "storage" && ops.includes("rm");
}

function azDelete(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "az") return false;
  return lower(operands(tail)).includes("delete");
}

function railwayDelete(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "railway") return false;
  const ops = lower(operands(tail));
  return ops.includes("delete") || ops.includes("remove");
}

const KUBECTL_WIDE = new Set([
  "namespace",
  "namespaces",
  "ns",
  "node",
  "nodes",
  "pv",
  "persistentvolume",
  "persistentvolumes",
  "all",
  "clusterrole",
  "clusterrolebinding",
  "serviceaccount",
  "crd",
  "customresourcedefinition",
]);

function kubectlDelete(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "kubectl" && program !== "oc" && program !== "k") return false;
  const ops = lower(operands(tail));
  if (ops[0] !== "delete") return false;
  if (hasFlag(tail, "--all", "-A", "--all-namespaces")) return true;
  return ops.slice(1, 3).some((w) => KUBECTL_WIDE.has(w));
}

function helmUninstall(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "helm") return false;
  const ops = lower(operands(tail));
  return ops[0] === "uninstall" || ops[0] === "delete";
}

function destructiveSql(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (!SQL_CLIENTS.has(program) && !MONGO_CLIENTS.has(program)) return false;
  const text = tail.join(" ");
  if (DESTRUCTIVE_SQL.test(text)) return true;
  if (!MONGO_CLIENTS.has(program)) return false;
  return /flushall|drop\b/i.test(lower(tail).join(" "));
}

function prismaReset(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (program !== "prisma") return false;
  const ops = lower(operands(tail));
  if (ops[0] === "migrate" && ops.includes("reset")) return true;
  return ops[0] === "db" && ops.includes("push") && hasFlag(tail, "--force-reset");
}

function iacDestroy(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  const ops = lower(operands(tail));
  if (program === "terraform" || program === "tofu" || program === "pulumi") {
    return ops[0] === "destroy";
  }
  return program === "cdk" && ops[0] === "destroy";
}

function iacStateRemove(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  const ops = lower(operands(tail));
  if (program === "terraform" || program === "tofu") {
    return ops[0] === "state" && (ops[1] === "rm" || ops[1] === "delete");
  }
  return program === "pulumi" && ops[0] === "stack" && (ops[1] === "rm" || ops[1] === "remove");
}

function credentialRead(call: PackCall): boolean {
  const { program, tail } = resolve(call);
  if (!READERS.has(program) && !EGRESS.has(program)) return false;
  return operands(tail).some(credentialPath);
}

const PACK_MATCHERS: ReadonlyMap<string, (call: PackCall) => boolean> = new Map([
  ["pack.cloud.s3RecursiveDelete", awsRecursiveDelete],
  ["pack.cloud.gcloudDelete", gcloudDelete],
  ["pack.cloud.azDelete", azDelete],
  ["pack.cloud.railwayDelete", railwayDelete],
  ["pack.kubernetes.kubectlDelete", kubectlDelete],
  ["pack.kubernetes.helmUninstall", helmUninstall],
  ["pack.database.destructiveSql", destructiveSql],
  ["pack.database.prismaReset", prismaReset],
  ["pack.iac.destroy", iacDestroy],
  ["pack.iac.stateRemove", iacStateRemove],
  ["pack.secrets.credentialRead", credentialRead],
]);

/** True when `call` is what rule `ruleId` refuses. Unknown id: never matches (fail closed). */
export function topicMatch(ruleId: string, call: PackCall): boolean {
  const m = PACK_MATCHERS.get(ruleId);
  return m === undefined ? false : m(call);
}

// -------------------------------------------------------------------------------- data --

const CLOUD_PACK: readonly CommandRule[] = [
  {
    id: "pack.cloud.s3RecursiveDelete",
    pattern: String.raw`\baws\s+s3\s+rm\b[^\n]*\s--recursive\b|\baws\s+s3\s+rb\b[^\n]*\s--force\b`,
    reason:
      "aws s3 rm --recursive (or s3 rb --force) deletes a whole bucket or prefix with no undo.",
    fix: "list the keys first (aws s3 ls --recursive) and delete the objects you mean.",
  },
  {
    id: "pack.cloud.gcloudDelete",
    pattern: String.raw`\bgcloud\s+[^\n]*\b(?:delete|destroy)\b|\bgcloud\s+storage\s+rm\b`,
    reason: "gcloud delete/destroy removes a live cloud resource; ask the human first.",
    fix: "describe the resource and get explicit confirmation before deleting it.",
  },
  {
    id: "pack.cloud.azDelete",
    pattern: String.raw`\baz\s+[^\n]*\bdelete\b`,
    reason: "az delete removes a live Azure resource (az group delete takes a whole group).",
    fix: "az <group> list / az resource show first, then delete only what you named.",
  },
  {
    id: "pack.cloud.railwayDelete",
    pattern: String.raw`\brailway\s+[^\n]*\b(?:delete|remove)\b`,
    reason: "railway delete/remove drops a live project, service or the production volume.",
    fix: "read the service and volume state first; deleting a volume is not reversible.",
  },
];

const KUBERNETES_PACK: readonly CommandRule[] = [
  {
    id: "pack.kubernetes.kubectlDelete",
    pattern: String.raw`\bkubectl\s+delete\b[^\n]*\b(?:namespace|ns|nodes?|--all|-A)\b`,
    reason:
      "kubectl delete of a namespace, a node or --all removes many objects at once, usually in a live cluster.",
    fix: "kubectl get the objects; delete the single object you mean, in a named namespace.",
  },
  {
    id: "pack.kubernetes.helmUninstall",
    pattern: String.raw`\bhelm\s+(?:uninstall|delete)\b`,
    reason: "helm uninstall deletes every object of a release.",
    fix: "helm list / helm get manifest first, and name the release explicitly.",
  },
];

const DATABASE_PACK: readonly CommandRule[] = [
  {
    id: "pack.database.destructiveSql",
    pattern: String.raw`\b(?:psql|mysql|sqlite3|mongosh|mongo)\b[^\n]*(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|dropDatabase\s*\()`,
    reason: "A destructive statement sent to a database client (DROP, TRUNCATE, dropDatabase).",
    fix: "run the SELECT that proves you are on the right database first; ask before dropping.",
  },
  {
    id: "pack.database.prismaReset",
    pattern: String.raw`\bprisma\s+(?:migrate\s+reset|db\s+push\b[^\n]*--force-reset)\b`,
    reason: "prisma migrate reset drops and recreates the whole database it points at.",
    fix: "prisma migrate status / prisma db execute --stdin with the statement you mean.",
  },
];

const IAC_PACK: readonly CommandRule[] = [
  {
    id: "pack.iac.destroy",
    pattern: String.raw`\b(?:terraform|tofu|pulumi|cdk)\s+destroy\b`,
    reason: "Infrastructure destroy removes live resources; it is not a code change.",
    fix: "terraform plan -destroy / pulumi preview first, and get human confirmation.",
  },
  {
    id: "pack.iac.stateRemove",
    pattern: String.raw`\bterraform\s+state\s+rm\b|\bpulumi\s+stack\s+(?:rm|remove)\b`,
    reason:
      "Removing an object from the state (or deleting a stack) orphans or destroys real resources.",
    fix: "terraform state list / pulumi stack ls first; change the configuration instead.",
  },
];

const SECRETS_PACK: readonly CommandRule[] = [
  {
    id: "pack.secrets.credentialRead",
    pattern: String.raw`\b(?:cat|type|Get-Content|cp|scp|curl)\b[^\n]*(?:\.env\b|\.aws[\\/]credentials|\.ssh[\\/]id_)`,
    reason:
      "The command reads a credential file (.env, ~/.aws/credentials, ~/.ssh/id_*) into another program; a secret that reaches a command can reach a log or a network call.",
    fix: "use the harness secret store / an env var that is already set, never the file itself.",
    decision: "ask",
  },
];

/** The topic packs, in enum order. `command-rules.ts` evaluates only the ones a policy lists. */
export const TOPIC_PACKS: readonly TopicPack[] = [
  { pack: "cloud", rules: CLOUD_PACK },
  { pack: "kubernetes", rules: KUBERNETES_PACK },
  { pack: "database", rules: DATABASE_PACK },
  { pack: "iac", rules: IAC_PACK },
  { pack: "secrets", rules: SECRETS_PACK },
];

/** Every topic rule object, so the evaluator can tell a pack rule from a user rule. */
export const TOPIC_RULES: readonly CommandRule[] = TOPIC_PACKS.flatMap((p) => [...p.rules]);
