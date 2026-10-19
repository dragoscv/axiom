/**
 * The CLI command table (D-43). ONE table drives command resolution (noun groups + the old
 * verbs as hidden aliases until 4.0), option pre-validation, `axiom --help`, per-command help
 * and the generated part of `docs/reference/cli.md` (`scripts/gen-cli-doc.mjs`).
 *
 * Adding a command = one entry in `COMMANDS`. Heavy handlers belong in their own module and
 * are reached with `run: async (a) => (await import("./x-lazy.js")).cmdX(a)` so the eager
 * `cli-main.js` does not grow; the existing handlers live in `cli-main.ts`.
 *
 * Everything a human reads here is ASCII-only (cli.test.ts asserts it).
 */
import {
  cmdAcpProxy,
  cmdApply,
  cmdAttest,
  cmdCheck,
  cmdCompile,
  cmdDiff,
  cmdDoctor,
  cmdEmitters,
  cmdExplain,
  cmdGate,
  cmdGc,
  cmdImportGuard,
  cmdInit,
  cmdKeygen,
  cmdLog,
  cmdMcp,
  cmdMigrate,
  cmdPin,
  cmdReplay,
  cmdReport,
  cmdRollback,
  cmdSchema,
  cmdServe,
  cmdSign,
  cmdSnapshot,
  cmdSnapshotDiff,
  cmdStats,
  cmdStatus,
  cmdSuggestProfile,
  cmdTrust,
  cmdUndo,
  cmdVerify,
} from "./cli-main.js";
import { SCHEMA_KINDS } from "./jsonschema.js";
import { LOG_LEVELS } from "./log.js";
import { WIRE_MODES } from "./wire.js";

export type OptionType = "string" | "boolean" | "string[]";

export interface OptionDef {
  /** Long name without the leading `--`. */
  name: string;
  /** One-letter short form without the leading `-`. */
  short?: string;
  /** `string[]` = repeatable string option. */
  type: OptionType;
  /** Value placeholder shown in help, e.g. `<dir>`. */
  arg?: string;
  default?: string;
  description: string;
}

export interface CommandDef {
  /** Canonical words, e.g. `["plan", "compile"]` or `["gc"]`. */
  path: readonly string[];
  /** Hidden old names that resolve to the same handler (removed in 4.0). */
  aliases?: readonly (readonly string[])[];
  summary: string;
  /** Full usage, first line = the one-line usage printed with a usage error. */
  usage: string;
  options: readonly OptionDef[];
  examples: readonly string[];
  /** The handler parses its own argv with its own error contract (the gate): no pre-validation. */
  passthrough?: boolean;
  run: (argv: string[]) => Promise<number>;
}

export interface GroupDef {
  name: string;
  summary: string;
}

export const GROUPS: readonly GroupDef[] = [
  { name: "plan", summary: "author, judge and transactionally apply a Plan" },
  { name: "journal", summary: "what was applied: history, state, integrity, undo, attestations" },
  { name: "keys", summary: "signing keys, signatures and the root's trust store" },
  { name: "hook", summary: "harness hooks: the PreToolUse/PostToolUse gate and its daemon" },
  { name: "setup", summary: "wire a repo, diagnose it, measure the gate, migrate, import guards" },
];

const LEVELS = LOG_LEVELS.join("|");
const HARNESSES =
  "auto|copilot|claude|codex|vscode|cursor|windsurf|gemini|junie|cline|kiro|opencode";
const GATE_FORMATS = "auto|copilot|claude|codex|vscode|cursor|windsurf|gemini|junie|cline|kiro";

const rootRequired: OptionDef = {
  name: "root",
  type: "string",
  arg: "<dir>",
  description: "repository root (required; no cwd fallback)",
};
const rootCwd: OptionDef = {
  name: "root",
  type: "string",
  arg: "<dir>",
  default: ".",
  description: "repository root",
};
const jsonOpt: OptionDef = {
  name: "json",
  type: "boolean",
  description: "print the full result object instead of the text summary",
};
const guardOpts: readonly OptionDef[] = [
  {
    name: "allow-guards",
    type: "boolean",
    description: "enable guard.external checks (the profile must also set facts.allowGuards)",
  },
  {
    name: "guard-allowlist",
    type: "string[]",
    arg: "<abs>",
    description: "absolute guard command allowed to run (repeatable)",
  },
];
const profileOpt: OptionDef = {
  name: "profile",
  type: "string",
  arg: "<name>",
  default: "manifest profile",
  description: "built-in (default|strict|permissive) or <root>/.axiom/profiles/<name>.json",
};
const outOpt = (what: string, dflt = "stdout"): OptionDef => ({
  name: "out",
  short: "o",
  type: "string",
  arg: "<file>",
  default: dflt,
  description: what,
});
const emitterOpt: OptionDef = {
  name: "emitter",
  type: "string[]",
  arg: "<pkg>",
  description: "load a template emitter package, e.g. @codai/axiom-emitters-web (repeatable)",
};

const gateOpts = (withPost: boolean): OptionDef[] => [
  { name: "stdin", type: "boolean", description: "read the harness payload from stdin" },
  ...(withPost
    ? [
        {
          name: "post",
          type: "boolean",
          description: "PostToolUse payload: check what the tool changed",
        } satisfies OptionDef,
      ]
    : []),
  {
    name: "format",
    type: "string",
    arg: GATE_FORMATS,
    default: "auto",
    description: "harness answer document and exit code",
  },
  {
    name: "root",
    type: "string",
    arg: "<dir>",
    description: "root used only when the payload has no cwd",
  },
  {
    name: "profile",
    type: "string",
    arg: "<file>",
    default: "<root>/.axiom/gate-profile.json",
    description: "gate profile file (then ~/.axiom/gate-profile.json, then built-in)",
  },
  { name: "fail-open", type: "boolean", description: "allow when the gate cannot decide" },
  { name: "no-shell-scan", type: "boolean", description: "skip shell command scanning" },
  {
    name: "no-root-discovery",
    type: "boolean",
    description: "do not walk up from cwd to find the root",
  },
  {
    name: "track-reads",
    type: "boolean",
    description: "let read tools reach the gate (sessions.trackReads; skips the fast path)",
  },
  {
    name: "deny-exit",
    type: "string",
    arg: "0|2",
    default: "0",
    description: "exit code of a deny (2 for exit-code-only harnesses)",
  },
  {
    name: "log-level",
    type: "string",
    arg: LEVELS,
    default: "warn",
    description: "stderr verbosity",
  },
];

const daemonOpts: readonly OptionDef[] = [
  {
    name: "root",
    type: "string[]",
    arg: "<abs>",
    description: "root the daemon answers for (required, repeatable)",
  },
  {
    name: "host",
    type: "string",
    arg: "<host>",
    default: "127.0.0.1",
    description: "loopback bind address",
  },
  { name: "port", type: "string", arg: "<n>", default: "47861", description: "TCP port" },
  {
    name: "token-env",
    type: "string",
    arg: "<NAME>",
    description: "env var holding a bearer token required on every request",
  },
  {
    name: "otel",
    type: "boolean",
    description: "export GenAI execute_tool spans to $AXIOM_OTEL_ENDPOINT / OTLP env",
  },
];

export const COMMANDS: readonly CommandDef[] = [
  // ---- plan ------------------------------------------------------------------------------
  {
    path: ["plan", "compile"],
    aliases: [["compile"]],
    summary: "Plan (.json, .yaml, .axm) -> content-addressed ManifestBundle",
    usage:
      "axiom plan compile <plan.json|plan.yaml|plan.axm> [-o <out.json>] [--store inline|cas] [--root <dir>]\n" +
      "                   [--allow-net [--net-allow <host>[,host]]] [--allow-file] [--emitter <pkg>]...",
    options: [
      outOpt("write the bundle to <file> and print a summary"),
      {
        name: "store",
        type: "string",
        arg: "inline|cas",
        default: "inline",
        description: "blob transport",
      },
      {
        name: "root",
        type: "string",
        arg: "<dir>",
        description: "record preImage[] and store the manifest under <root>/.axiom/manifests",
      },
      { name: "allow-net", type: "boolean", description: "fetch https: ref sources" },
      {
        name: "net-allow",
        type: "string[]",
        arg: "<host>[,host]",
        description: "restrict --allow-net to these hosts (*.example.com wildcards)",
      },
      { name: "allow-file", type: "boolean", description: "admit file: ref sources" },
      emitterOpt,
    ],
    examples: [
      "axiom plan compile plan.json --root . -o bundle.json",
      "axiom plan compile plan.axm -o bundle.json",
      "axiom plan compile plan.json --root . --store cas --allow-net --net-allow cdn.example.com",
    ],
    run: (a) => cmdCompile(a),
  },
  {
    path: ["plan", "check"],
    aliases: [["check"]],
    summary: "run the profile's predicates over a bundle against a root",
    usage:
      "axiom plan check <bundle.json> --root <dir> [--profile <name>] [--json | --format text|json|sarif]\n" +
      "                 [--allow-guards] [--guard-allowlist <abs>]...",
    options: [
      rootRequired,
      profileOpt,
      jsonOpt,
      {
        name: "format",
        type: "string",
        arg: "text|json|sarif",
        default: "text",
        description: "output format (sarif = SARIF 2.1.0 for code scanning)",
      },
      ...guardOpts,
    ],
    examples: [
      "axiom plan check bundle.json --root . --profile strict",
      "axiom plan check bundle.json --root . --format sarif > axiom.sarif",
    ],
    run: (a) => cmdCheck(a),
  },
  {
    path: ["plan", "apply"],
    aliases: [["apply"]],
    summary: "hash-gated two-phase apply of a bundle (--dry-run first, then --confirm)",
    usage:
      "axiom plan apply <bundle.json> --root <dir> [--dry-run] [--confirm <digest>] [--profile <name>]\n" +
      "                 [--pr [--branch <name>] [--message <text>]] [--lock-timeout <ms>] [--keep-backups <n>]\n" +
      "                 [--allow-guards] [--guard-allowlist <abs>]...",
    options: [
      rootRequired,
      {
        name: "dry-run",
        type: "boolean",
        description: "phase 1 only: stage, check, print the diff and the manifestDigest",
      },
      {
        name: "confirm",
        type: "string",
        arg: "<digest>",
        description: "must equal bundle.manifestDigest (required without --dry-run)",
      },
      profileOpt,
      {
        name: "pr",
        type: "boolean",
        description: "commit the touched paths on a new branch from an axiom-owned worktree",
      },
      {
        name: "branch",
        type: "string",
        arg: "<name>",
        default: "axiom/<name>/<digest12>",
        description: "--pr branch",
      },
      { name: "message", type: "string", arg: "<text>", description: "--pr commit message" },
      {
        name: "lock-timeout",
        type: "string",
        arg: "<ms>",
        default: "30000",
        description: "max wait for .axiom/lock (0..600000)",
      },
      {
        name: "keep-backups",
        type: "string",
        arg: "<n>",
        default: "3",
        description: "pre-image backup sets kept (0..1000)",
      },
      ...guardOpts,
    ],
    examples: [
      "axiom plan apply bundle.json --root . --dry-run",
      "axiom plan apply bundle.json --root . --confirm sha256:<manifestDigest>",
      "axiom plan apply bundle.json --root . --confirm sha256:<manifestDigest> --pr --branch feat/x",
    ],
    run: (a) => cmdApply(a),
  },
  {
    path: ["plan", "diff"],
    aliases: [["diff"]],
    summary: "structural diff of two bundles by artifact path",
    usage: "axiom plan diff <a.json> <b.json>",
    options: [],
    examples: ["axiom plan diff old.bundle.json new.bundle.json"],
    run: (a) => cmdDiff(a),
  },
  {
    path: ["plan", "verify"],
    aliases: [["verify"]],
    summary: "verify a bundle: digests, signatures (--root), the tree it describes (--tree)",
    usage:
      "axiom plan verify <bundle.json> [--root <dir>]\n" +
      "axiom plan verify <bundle.json> --tree <dir> [--pre] [--attest <out.json>]",
    options: [
      {
        name: "root",
        type: "string",
        arg: "<dir>",
        description: "also verify signatures against <root>/.axiom/trust/keys.json",
      },
      {
        name: "tree",
        type: "string",
        arg: "<dir>",
        description: "compare the tree under <dir> with the manifest's artifacts",
      },
      {
        name: "pre",
        type: "boolean",
        description: "with --tree: compare against the declared pre-image set",
      },
      {
        name: "attest",
        type: "string",
        arg: "<out.json>",
        description: "with --tree: write an in-toto Statement on success",
      },
      {
        name: "journal",
        type: "boolean",
        description: "verify the root's journal hash chain instead (= axiom journal verify)",
      },
    ],
    examples: [
      "axiom plan verify bundle.json",
      "axiom plan verify bundle.json --root .",
      "axiom plan verify bundle.json --tree . --attest axiom.intoto.json",
    ],
    run: (a) => cmdVerify(a),
  },
  {
    path: ["plan", "emitters"],
    aliases: [["emitters"]],
    summary: "list the template emitters available to plan compile",
    usage: "axiom plan emitters [--emitter <pkg>]... [--json]",
    options: [emitterOpt, jsonOpt],
    examples: ["axiom plan emitters --emitter @codai/axiom-emitters-web --json"],
    run: (a) => cmdEmitters(a),
  },
  // ---- journal ---------------------------------------------------------------------------
  {
    path: ["journal", "log"],
    aliases: [["log"]],
    summary: "the journal chain, newest first",
    usage: "axiom journal log [--root <dir>] [--limit <n>] [--json]",
    options: [
      rootCwd,
      {
        name: "limit",
        short: "n",
        type: "string",
        arg: "<n>",
        default: "20",
        description: "entries to print (1..100000)",
      },
      jsonOpt,
    ],
    examples: ["axiom journal log", "axiom journal log -n 5 --json"],
    run: (a) => cmdLog(a),
  },
  {
    path: ["journal", "status"],
    aliases: [["status"]],
    summary: "lock holder, queue, intents, interrupted journals, last applied, chain",
    usage: "axiom journal status [--root <dir>] [--json]",
    options: [rootCwd, jsonOpt],
    examples: ["axiom journal status --json"],
    run: (a) => cmdStatus(a),
  },
  {
    path: ["journal", "verify"],
    summary: "verify the journal hash chain (broken -> exit 1, ERR_JOURNAL_CHAIN)",
    usage: "axiom journal verify --root <dir>",
    options: [rootRequired],
    examples: ["axiom journal verify --root ."],
    run: (a) => cmdVerify(["--journal", ...a]),
  },
  {
    path: ["journal", "undo"],
    aliases: [["undo"]],
    summary: "restore every file one agent session wrote through the gate",
    usage:
      "axiom journal undo --session <agent> [--root <dir>] [--dry-run] [--force] [--since <iso>]",
    options: [
      {
        name: "session",
        type: "string",
        arg: "<agent>",
        description: "agent id (<harness>:<session>) or session id (required)",
      },
      rootCwd,
      { name: "dry-run", type: "boolean", description: "report what would be restored" },
      {
        name: "force",
        type: "boolean",
        description: "also restore paths another agent wrote later",
      },
      { name: "since", type: "string", arg: "<iso>", description: "only writes after this time" },
    ],
    examples: ["axiom journal undo --session claude:abc123 --dry-run"],
    run: (a) => cmdUndo(a),
  },
  {
    path: ["journal", "rollback"],
    aliases: [["rollback"]],
    summary: "reverse-replay the journal of an applied manifest",
    usage: "axiom journal rollback <digest> --root <dir>",
    options: [rootRequired],
    examples: ["axiom journal rollback sha256:<manifestDigest> --root ."],
    run: (a) => cmdRollback(a),
  },
  {
    path: ["journal", "attest"],
    aliases: [["attest"]],
    summary: "gate decision journal -> in-toto agent-decision Statements (JSON Lines)",
    usage:
      "axiom journal attest decisions [--root <dir>] [--since <iso>] [--limit <n>] [--sign [--key-file <path>]]",
    options: [
      rootCwd,
      {
        name: "since",
        type: "string",
        arg: "<iso>",
        description: "only decisions after this time",
      },
      {
        name: "limit",
        short: "n",
        type: "string",
        arg: "<n>",
        description: "max statements (1..100000)",
      },
      { name: "sign", type: "boolean", description: "wrap each Statement in a DSSE envelope" },
      {
        name: "key-file",
        type: "string",
        arg: "<path>",
        default: "$AXIOM_SIGNING_KEY",
        description: "Ed25519 private key for --sign",
      },
    ],
    examples: ["axiom journal attest decisions --since 2026-10-14T00:00:00Z --sign"],
    run: (a) => cmdAttest(a),
  },
  // ---- keys ------------------------------------------------------------------------------
  {
    path: ["keys", "gen"],
    aliases: [["keygen"]],
    summary: "generate an Ed25519 signing key (private key -> file 0600)",
    usage: "axiom keys gen [--out <dir>] [--name <label>]",
    options: [
      {
        name: "out",
        type: "string",
        arg: "<dir>",
        default: ".",
        description: "directory for the private key file",
      },
      { name: "name", type: "string", arg: "<label>", description: "label in the public entry" },
    ],
    examples: ["axiom keys gen --out ./secrets --name ci"],
    run: (a) => cmdKeygen(a),
  },
  {
    path: ["keys", "sign"],
    aliases: [["sign"]],
    summary: "append a DSSE signature (Ed25519 or Sigstore keyless) to a bundle",
    usage:
      "axiom keys sign <bundle.json> [--key-file <path>] [-o <out.json>] [--root-id <id>]\n" +
      "axiom keys sign <bundle.json> --keyless [--bound --root <dir> | --root-id <id>] [-o <out.json>]",
    options: [
      {
        name: "key-file",
        type: "string",
        arg: "<path>",
        default: "$AXIOM_SIGNING_KEY",
        description: "Ed25519 private key",
      },
      outOpt("write the signed bundle to <file>", "the input file"),
      {
        name: "root-id",
        type: "string",
        arg: "<id>",
        description: "root-bound envelope only a trust store with this rootId accepts",
      },
      {
        name: "keyless",
        type: "boolean",
        description: "Sigstore via ambient OIDC (no OIDC -> exit 1 ERR_KEYLESS_UNAVAILABLE)",
      },
      {
        name: "bound",
        type: "boolean",
        description: "with --keyless: take the root id from --root's trust store",
      },
      { name: "root", type: "string", arg: "<dir>", description: "root for --bound" },
    ],
    examples: [
      "axiom keys sign bundle.json --key-file ./secrets/axiom-signing-<id>.key -o signed.json",
      "axiom keys sign bundle.json --keyless --bound --root . -o signed.json",
    ],
    run: (a) => cmdSign(a),
  },
  {
    path: ["keys", "trust"],
    aliases: [["trust"]],
    summary: "manage <root>/.axiom/trust/keys.json (add, remove, list, root-id)",
    usage:
      "axiom keys trust add <pubkey.json> --root <dir>\n" +
      "axiom keys trust remove <keyid> --root <dir>\n" +
      "axiom keys trust list --root <dir>\n" +
      "axiom keys trust root-id [<id> | --clear] --root <dir>",
    options: [
      rootRequired,
      { name: "clear", type: "boolean", description: "root-id: remove the binding" },
    ],
    examples: [
      "axiom keys trust add pubkey.json --root .",
      "axiom keys trust root-id github:owner/repo --root .",
    ],
    run: (a) => cmdTrust(a),
  },
  // ---- hook ------------------------------------------------------------------------------
  {
    path: ["hook", "gate"],
    aliases: [["gate"]],
    summary: "PreToolUse hook: judge one harness payload (fail-closed)",
    usage:
      `axiom hook gate --stdin [--post] [--format ${GATE_FORMATS}]\n` +
      "                [--root <dir>] [--profile <file>] [--fail-open] [--no-shell-scan] [--no-root-discovery]\n" +
      `                [--track-reads] [--deny-exit 0|2] [--log-level ${LEVELS}]`,
    options: gateOpts(true),
    examples: [
      "axiom gate --stdin --format auto",
      "axiom hook gate --stdin --format claude --deny-exit 2",
    ],
    passthrough: true,
    run: (a) => cmdGate(a),
  },
  {
    path: ["hook", "post"],
    summary: "PostToolUse hook: check what the tool changed (= gate --post)",
    usage:
      `axiom hook post --stdin [--format ${GATE_FORMATS}] [--root <dir>] [--profile <file>]\n` +
      `                [--log-level ${LEVELS}]`,
    options: gateOpts(false),
    examples: ["axiom hook post --stdin --format claude"],
    passthrough: true,
    run: (a) => cmdGate(["--post", ...a]),
  },
  {
    path: ["hook", "daemon"],
    summary: "resident gate daemon for hooks on loopback (= serve --hook)",
    usage:
      "axiom hook daemon --root <abs>... [--host 127.0.0.1] [--port 47861] [--token-env <NAME>] [--otel]",
    options: daemonOpts,
    examples: ["axiom hook daemon --root E:\\gh"],
    run: (a) => cmdServe(["--hook", ...a]),
  },
  // ---- setup -----------------------------------------------------------------------------
  {
    path: ["setup", "init"],
    aliases: [["init"]],
    summary: "wire a repo: MCP entry, hooks, profiles, .gitignore (idempotent)",
    usage:
      `axiom setup init [--root <dir>] [--harness ${HARNESSES}] [--daemon]\n` +
      "                 [--profile-name <name>] [--force] [--upgrade] [--managed --out <dir>] [--json]",
    options: [
      rootCwd,
      {
        name: "harness",
        type: "string",
        arg: HARNESSES,
        default: "auto",
        description: "auto = one harness per marker directory present",
      },
      {
        name: "daemon",
        type: "boolean",
        description: "hooks call the native axiom-hook client / the daemon's HTTP hook",
      },
      {
        name: "profile-name",
        type: "string",
        arg: "<name>",
        default: "directory name",
        description: "name of .axiom/profiles/<name>.json",
      },
      { name: "force", type: "boolean", description: "overwrite existing files" },
      {
        name: "upgrade",
        type: "boolean",
        description: "bring an existing wiring up to date without --force",
      },
      {
        name: "managed",
        type: "boolean",
        description: "write enterprise policy files into --out instead",
      },
      { name: "out", type: "string", arg: "<dir>", description: "output directory for --managed" },
      {
        name: "dry-run",
        type: "boolean",
        description: "print the unified diff of what init would write; write nothing",
      },
      jsonOpt,
    ],
    examples: [
      "axiom setup init",
      "axiom setup init --dry-run",
      "axiom setup init --harness claude --profile-name web --json",
    ],
    run: (a) => cmdInit(a),
  },
  {
    path: ["setup", "doctor"],
    aliases: [["doctor"]],
    summary: "is this machine + root wired correctly? (exit 2 = a check failed)",
    usage:
      "axiom setup doctor [--root <dir>] [--json]\n" +
      "axiom setup doctor --fleet [--scan <dir>]... [--json]",
    options: [
      rootCwd,
      {
        name: "fleet",
        type: "boolean",
        description: "every wired repo + worktree slot: profile drift, stale hooks, bin skew",
      },
      {
        name: "scan",
        type: "string[]",
        arg: "<dir>",
        description: "with --fleet: directory whose child repos are checked (repeatable)",
      },
      jsonOpt,
    ],
    examples: [
      "axiom setup doctor",
      "axiom setup doctor --json",
      "axiom setup doctor --fleet --scan E:\\gh",
    ],
    run: (a) => cmdDoctor(a),
  },
  {
    path: ["setup", "suggest-profile"],
    summary: "propose profile changes from the decision journal (never writes the profile)",
    usage: "axiom setup suggest-profile [--days 7] [--min 5] [--root <dir>] [--json]",
    options: [
      { name: "days", type: "string", arg: "<n>", default: "7", description: "journal window" },
      {
        name: "min",
        type: "string",
        arg: "<n>",
        default: "5",
        description: "minimum hits before a code is proposed",
      },
      rootCwd,
      jsonOpt,
    ],
    examples: ["axiom setup suggest-profile --days 14"],
    run: (a) => cmdSuggestProfile(a),
  },
  {
    path: ["setup", "stats"],
    aliases: [["stats"]],
    summary: "gate decisions, latency per harness, silent-gate alarms",
    usage: "axiom setup stats [--root <dir>] [--since <iso>|<n>d|<n>h|<n>m] [--json]",
    options: [
      rootCwd,
      {
        name: "since",
        type: "string",
        arg: "<iso>|<n>d|<n>h|<n>m",
        description: "window start (absolute or relative to now)",
      },
      jsonOpt,
    ],
    examples: ["axiom setup stats --since 7d"],
    run: (a) => cmdStats(a),
  },
  {
    path: ["setup", "migrate"],
    aliases: [["migrate"]],
    summary: "old policy files -> .axiom/axiom.json, or an AXIOM 1.x manifest -> Plan",
    usage:
      "axiom setup migrate --profile [--root <dir>] [--dry-run] [--name <profile>]\n" +
      "axiom setup migrate v1 <manifest.json> [-o <plan.json>] [--profile <name>] [--cas <root>]\n" +
      "                       [--content <dir>] [--name <kebab>] [--overwrite]",
    options: [
      {
        name: "dry-run",
        type: "boolean",
        description: "with --profile: print the new axiom.json, write nothing",
      },
      { name: "root", type: "string", arg: "<dir>", default: ".", description: "repository root" },
      outOpt("write the Plan to <file> and print the report"),
      {
        name: "profile",
        type: "string",
        arg: "[<name>]",
        description: "alone: migrate the policy files; with v1: profile of the new Plan",
      },
      {
        name: "cas",
        type: "string",
        arg: "<root>",
        description: "store resolved bytes in this root's CAS",
      },
      {
        name: "content",
        type: "string",
        arg: "<dir>",
        default: "manifest directory",
        description: "sidecar bytes for hash-only artifacts",
      },
      {
        name: "name",
        type: "string",
        arg: "<kebab>",
        default: "migrated-v1-<profile>",
        description: "Plan name",
      },
      { name: "overwrite", type: "boolean", description: "op: overwrite on every artifact" },
    ],
    examples: [
      "axiom setup migrate --profile --dry-run",
      "axiom setup migrate v1 out.manifest.json -o plan.json",
    ],
    run: (a) => cmdMigrate(a),
  },
  {
    path: ["setup", "import-guard"],
    aliases: [["import-guard"]],
    summary: "PowerShell guard pattern tables -> gate profile commands JSON",
    usage: "axiom setup import-guard <guard.ps1> [-o <file>]",
    options: [outOpt("write { commands } to <file>")],
    examples: ["axiom setup import-guard guard-tooluse.ps1 -o commands.json"],
    run: (a) => cmdImportGuard(a),
  },
  // ---- 3.0 journal / audit -----------------------------------------------------------------
  {
    path: ["explain"],
    summary: "why the gate decided what it did: rule, profile, paths, and how to fix it",
    usage: "axiom explain <id|last|-N|N> [--root <dir>] [--json]",
    options: [rootCwd, jsonOpt],
    examples: ["axiom explain last", "axiom explain -3 --json"],
    run: (a) => cmdExplain(a),
  },
  {
    path: ["journal", "replay"],
    summary: "re-judge one session's recorded decisions with the current profile (read-only)",
    usage:
      "axiom journal replay --session <agent_id|session> [--root <dir>] [--profile <file>] [--json]",
    options: [
      { name: "session", type: "string", arg: "<id>", description: "agent_id or session id" },
      rootCwd,
      { name: "profile", type: "string", arg: "<file>", description: "gate profile to judge with" },
      jsonOpt,
    ],
    examples: ["axiom journal replay --session copilot:abc123"],
    run: (a) => cmdReplay(a),
  },
  {
    path: ["report"],
    summary: "self-contained HTML report of gate decisions (no external assets)",
    usage: "axiom report [--root <dir>] [--days 7] --out <file.html> [--json]",
    options: [
      rootCwd,
      { name: "days", type: "string", arg: "<n>", default: "7", description: "window" },
      outOpt("HTML file to write", "required"),
      jsonOpt,
    ],
    examples: ["axiom report --days 30 --out axiom-report.html"],
    run: (a) => cmdReport(a),
  },
  {
    path: ["pin"],
    summary: "pin MCP server configs (.vscode/.cursor/.mcp.json); --check reports drift (exit 1)",
    usage: "axiom pin [--root <dir>] [--check] [--json]",
    options: [
      rootCwd,
      { name: "check", type: "boolean", description: "compare against .axiom/mcp-pins.json" },
      jsonOpt,
    ],
    examples: ["axiom pin", "axiom pin --check"],
    run: (a) => cmdPin(a),
  },
  {
    path: ["acp-proxy"],
    summary: "ACP stdio proxy: answers session/request_permission with the gate",
    usage: "axiom acp-proxy --root <dir> -- <agent> [args...]",
    options: [rootRequired],
    examples: ["axiom acp-proxy --root . -- my-agent --acp"],
    run: (a) => cmdAcpProxy(a),
  },
  // ---- top level -------------------------------------------------------------------------
  {
    path: ["mcp"],
    summary: "MCP server: stdio JSON-RPC, or Streamable HTTP with --http",
    usage:
      `axiom mcp [--root <abs>]... [--allow-guards] [--guard-allowlist <abs>]... [--log-level ${LEVELS}]\n` +
      `          [--http <host:port>] [--http-token-env <NAME>] [--wire ${WIRE_MODES.join("|")}] [--require-human]\n` +
      "          [--tools core|full] [--emitter <pkg>]...",
    options: [
      {
        name: "root",
        type: "string[]",
        arg: "<abs>",
        description: "allowlisted root (repeatable; none -> ERR_ROOT_REQUIRED per tool)",
      },
      {
        name: "log-level",
        type: "string",
        arg: LEVELS,
        default: "warn",
        description: "stderr verbosity",
      },
      {
        name: "http",
        type: "string",
        arg: "<host:port>",
        description: "serve Streamable HTTP at /mcp (port 0 = random)",
      },
      {
        name: "http-token-env",
        type: "string",
        arg: "<NAME>",
        default: "AXIOM_HTTP_TOKEN",
        description: "env var with the bearer token (required for non-loopback hosts)",
      },
      {
        name: "wire",
        type: "string",
        arg: WIRE_MODES.join("|"),
        default: "2026",
        description: "protocol era served",
      },
      {
        name: "require-human",
        type: "boolean",
        description: "axiom_apply/axiom_write refuse unless a human confirms via elicitation",
      },
      {
        name: "tools",
        type: "string",
        arg: "core|full",
        default: "core",
        description: "core = the 6 write-path tools; full = every tool",
      },
      emitterOpt,
      ...guardOpts,
    ],
    examples: [
      "axiom mcp --root /abs/repo",
      "axiom mcp --root /abs/repo --tools full --http 127.0.0.1:3411",
    ],
    run: (a) => cmdMcp(a),
  },
  {
    path: ["serve"],
    summary: "resident gate daemon (serve --hook); same as axiom hook daemon",
    usage:
      "axiom serve --hook --root <abs>... [--host 127.0.0.1] [--port 47861] [--token-env <NAME>] [--otel]",
    options: [
      { name: "hook", type: "boolean", description: "serve the gate for hooks (required)" },
      ...daemonOpts,
    ],
    examples: ["axiom serve --hook --root E:\\gh"],
    run: (a) => cmdServe(a),
  },
  {
    path: ["snapshot"],
    summary: "deterministic inventory of a root (RepoSnapshot)",
    usage:
      "axiom snapshot --root <dir> [-o <out.json>] [--include <glob>]... [--exclude <glob>]...\n" +
      "               [--max-files <n>] [--max-bytes <n>] [--no-gitignore] [--no-digest]",
    options: [
      rootRequired,
      outOpt("write the snapshot to <file> and print a summary"),
      { name: "include", type: "string[]", arg: "<glob>", description: "only matching paths" },
      { name: "exclude", type: "string[]", arg: "<glob>", description: "skip matching paths" },
      {
        name: "max-files",
        type: "string",
        arg: "<n>",
        default: "20000",
        description: "file cap (max 50000)",
      },
      {
        name: "max-bytes",
        type: "string",
        arg: "<n>",
        default: "67108864",
        description: "byte cap",
      },
      { name: "no-gitignore", type: "boolean", description: "ignore the root .gitignore" },
      { name: "no-digest", type: "boolean", description: "record sizes only" },
    ],
    examples: ["axiom snapshot --root . -o before.json"],
    run: (a) => cmdSnapshot(a),
  },
  {
    path: ["snapshot", "diff"],
    aliases: [["snapshot-diff"]],
    summary: "compare two RepoSnapshot files: added, removed, changed",
    usage: "axiom snapshot diff <a.json> <b.json>",
    options: [],
    examples: ["axiom snapshot diff before.json after.json"],
    run: (a) => cmdSnapshotDiff(a),
  },
  {
    path: ["gc"],
    summary: "CAS garbage collection + expired undo logs (CLI only)",
    usage:
      "axiom gc --root <dir> [--dry-run] [--older-than <n>(ms|s|m|h|d)] [--keep all-manifests|journal]\n" +
      "         [--undo-ttl <n>(ms|s|m|h|d)]",
    options: [
      rootRequired,
      { name: "dry-run", type: "boolean", description: "report, remove nothing" },
      {
        name: "older-than",
        type: "string",
        arg: "<n>(ms|s|m|h|d)",
        description: "skip candidates younger than this",
      },
      {
        name: "keep",
        type: "string",
        arg: "all-manifests|journal",
        default: "all-manifests",
        description: "which manifests pin blobs",
      },
      {
        name: "undo-ttl",
        type: "string",
        arg: "<n>(ms|s|m|h|d)",
        default: "7d",
        description: "how long undo pre-images stay live",
      },
      {
        name: "decisions-older-than",
        type: "string",
        arg: "<days>",
        description: "drop decision-journal lines older than this many days",
      },
    ],
    examples: ["axiom gc --root . --dry-run", "axiom gc --root . --older-than 30d --keep journal"],
    run: (a) => cmdGc(a),
  },
  {
    path: ["schema"],
    summary: "print the JSON Schema of one wire type",
    usage: `axiom schema <${SCHEMA_KINDS.join("|")}>`,
    options: [],
    examples: ["axiom schema Plan"],
    run: (a) => cmdSchema(a),
  },
];

// ---- resolution ----------------------------------------------------------------------------

export interface Resolved {
  cmd: CommandDef;
  rest: string[];
  /** The words actually typed (canonical path or an alias). */
  invokedAs: readonly string[];
}

/** Longest canonical path or alias that prefixes argv. */
export function resolveCommand(argv: readonly string[]): Resolved | undefined {
  let best: Resolved | undefined;
  for (const cmd of COMMANDS) {
    for (const name of [cmd.path, ...(cmd.aliases ?? [])]) {
      if (name.length <= (best?.invokedAs.length ?? 0)) continue;
      if (name.every((w, i) => argv[i] === w)) {
        best = { cmd, rest: argv.slice(name.length), invokedAs: name };
      }
    }
  }
  return best;
}

export function commandName(cmd: CommandDef): string {
  return cmd.path.join(" ");
}

export function findGroup(name: string | undefined): GroupDef | undefined {
  return GROUPS.find((g) => g.name === name);
}

export function groupCommands(group: string): CommandDef[] {
  return COMMANDS.filter((c) => c.path.length > 1 && c.path[0] === group);
}

export function oneLineUsage(cmd: CommandDef): string {
  return (cmd.usage.split("\n")[0] ?? "").trim();
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      const left = prev[j - 1] ?? 0;
      prev[j] = Math.min(up + 1, left + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** Candidates within edit distance 2 of `word`, closest first (at most 3, de-duplicated). */
export function suggest(
  word: string,
  candidates: readonly { word: string; show: string }[],
): string[] {
  const scored = candidates
    .map((c) => ({ show: c.show, d: levenshtein(word.toLowerCase(), c.word.toLowerCase()) }))
    .filter((c) => c.d <= 2)
    .sort((x, y) => x.d - y.d || x.show.localeCompare(y.show));
  return [...new Set(scored.map((s) => s.show))].slice(0, 3);
}

/** Every first word a user may type, mapped to what to suggest (aliases suggest the new name). */
export function topLevelCandidates(): { word: string; show: string }[] {
  const out: { word: string; show: string }[] = GROUPS.map((g) => ({ word: g.name, show: g.name }));
  for (const c of COMMANDS) {
    if (c.path.length === 1 || findGroup(c.path[0]) === undefined) {
      out.push({ word: c.path[0] ?? "", show: c.path[0] ?? "" });
    }
    for (const a of c.aliases ?? []) out.push({ word: a.join(" "), show: commandName(c) });
  }
  out.push({ word: "help", show: "help" });
  return out;
}

/** argv before a `--` separator. */
export function flagsOf(argv: readonly string[]): readonly string[] {
  const i = argv.indexOf("--");
  return i === -1 ? argv : argv.slice(0, i);
}

export function wantsHelp(argv: readonly string[]): boolean {
  const f = flagsOf(argv);
  return f.includes("--help") || f.includes("-h");
}

/**
 * Validate option NAMES against the table (values are the handler's business). Returns the
 * usage-error message, or undefined when every flag is known.
 */
export function checkOptions(cmd: CommandDef, argv: readonly string[]): string | undefined {
  const byLong = new Map<string, OptionDef>(cmd.options.map((o) => [o.name, o] as const));
  const byShort = new Map<string, OptionDef>();
  for (const o of cmd.options) if (o.short !== undefined) byShort.set(o.short, o);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    if (t === "--") return undefined;
    let opt: OptionDef | undefined;
    let inline = false;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = t.slice(2, eq === -1 ? undefined : eq);
      inline = eq !== -1;
      opt = byLong.get(name);
      if (opt === undefined) {
        const near = suggest(
          name,
          cmd.options.map((o) => ({ word: o.name, show: `--${o.name}` })),
        );
        return `unknown option '--${name}' for 'axiom ${commandName(cmd)}'${near.length > 0 ? ` (did you mean ${near.map((n) => `'${n}'`).join(" or ")}?)` : ""}`;
      }
    } else if (/^-[A-Za-z]$/.test(t)) {
      opt = byShort.get(t.slice(1));
      if (opt === undefined) return `unknown option '${t}' for 'axiom ${commandName(cmd)}'`;
    } else {
      continue;
    }
    if (opt.type !== "boolean" && !inline) {
      if (i + 1 >= argv.length)
        return `option '--${opt.name}' needs a value ${opt.arg ?? ""}`.trim();
      i++;
    }
  }
  return undefined;
}

// ---- help ----------------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? `${s}  ` : s + " ".repeat(n - s.length);
}

function optionLabel(o: OptionDef): string {
  const long = `--${o.name}${o.type === "boolean" ? "" : ` ${o.arg ?? "<value>"}`}`;
  const label = o.short === undefined ? long : `-${o.short}, ${long}`;
  return o.type === "string[]" ? `${label} ...` : label;
}

function optionText(o: OptionDef): string {
  return o.default === undefined ? o.description : `${o.description} (default: ${o.default})`;
}

/** `axiom --help`: grouped overview, kept under 40 lines. */
export function renderOverview(version: string): string {
  const lines = [
    `axiom ${version} - transactional write gate for AI agents`,
    "",
    "Usage: axiom <command> [options]",
    "       axiom <command> --help      usage, options and examples of one command",
    "",
    "Commands:",
  ];
  const W = 16;
  for (const g of GROUPS) {
    const verbs = groupCommands(g.name).map((c) => c.path.slice(1).join(" "));
    lines.push(`  ${pad(g.name, W - 2)}${verbs.join(", ")}`);
    lines.push(`  ${" ".repeat(W - 2)}${g.summary}`);
  }
  for (const c of COMMANDS) {
    if (findGroup(c.path[0]) !== undefined) continue;
    lines.push(`  ${pad(commandName(c), W - 2)}${c.summary}`);
  }
  lines.push(
    "",
    "Old verbs (compile, apply, gate, init, log, keygen, ...) keep working as hidden aliases until 4.0.",
    "Exit codes: 0 ok, 1 verdict fail / apply failed / chain broken, 2 usage or other error.",
    "Errors: one JSON line {code, message, details} on stderr. Reference: docs/reference/cli.md",
  );
  return `${lines.join("\n")}\n`;
}

/** `axiom <noun> --help`: the group's commands only. */
export function renderGroupHelp(group: GroupDef): string {
  const cmds = groupCommands(group.name);
  const W = Math.max(...cmds.map((c) => commandName(c).length)) + 8;
  const lines = [`axiom ${group.name} - ${group.summary}`, "", "Commands:"];
  for (const c of cmds) lines.push(`  ${pad(`axiom ${commandName(c)}`, W)}${c.summary}`);
  lines.push("", `Run 'axiom ${group.name} <command> --help' for options and examples.`);
  return `${lines.join("\n")}\n`;
}

/** `axiom <cmd> --help`: this command's usage, options with defaults and examples only. */
export function renderCommandHelp(cmd: CommandDef): string {
  const lines = [`axiom ${commandName(cmd)} - ${cmd.summary}`, "", "Usage:"];
  for (const u of cmd.usage.split("\n")) lines.push(`  ${u}`);
  if (cmd.aliases !== undefined && cmd.aliases.length > 0) {
    lines.push(
      `  (old name: ${cmd.aliases.map((a) => `axiom ${a.join(" ")}`).join(", ")} - kept until 4.0)`,
    );
  }
  if (cmd.options.length > 0) {
    const W = Math.min(34, Math.max(...cmd.options.map((o) => optionLabel(o).length)) + 2);
    lines.push("", "Options:");
    for (const o of cmd.options) lines.push(`  ${pad(optionLabel(o), W)}${optionText(o)}`);
  }
  lines.push("", "Examples:");
  for (const e of cmd.examples) lines.push(`  ${e}`);
  return `${lines.join("\n")}\n`;
}

// ---- docs/reference/cli.md -----------------------------------------------------------------

export const CLI_DOC_MARKER = "<!-- cli:generated -->";

function mdCell(s: string): string {
  return s.replaceAll("|", "\\|");
}

function mdCommand(cmd: CommandDef, level: string, notes: ReadonlyMap<string, string>): string[] {
  const key = commandName(cmd);
  const out = [`${level} \`axiom ${key}\``, "", `${cmd.summary}.`, "", "```", cmd.usage, "```", ""];
  if (cmd.aliases !== undefined && cmd.aliases.length > 0) {
    out.push(
      `Old verb (hidden alias until 4.0): ${cmd.aliases.map((a) => `\`axiom ${a.join(" ")}\``).join(", ")}.`,
      "",
    );
  }
  if (cmd.options.length > 0) {
    out.push("| Option | Default | Description |", "|---|---|---|");
    for (const o of cmd.options) {
      out.push(
        `| \`${mdCell(optionLabel(o))}\` | ${o.default === undefined ? "-" : `\`${mdCell(o.default)}\``} | ${mdCell(o.description)} |`,
      );
    }
    out.push("");
  }
  out.push("```sh", ...cmd.examples, "```", "");
  const note = notes.get(key)?.trim();
  out.push(`<!-- notes:${key} -->`);
  if (note !== undefined && note !== "") out.push(note);
  out.push("<!-- /notes -->", "");
  return out;
}

/** Hand-written notes blocks (`<!-- notes:<cmd> -->` ... `<!-- /notes -->`) of a cli.md body. */
export function extractNotes(markdown: string): Map<string, string> {
  const notes = new Map<string, string>();
  const re = /<!-- notes:([^>]+?) -->\n([\s\S]*?)<!-- \/notes -->/g;
  for (const m of markdown.replaceAll("\r\n", "\n").matchAll(re)) {
    notes.set((m[1] ?? "").trim(), (m[2] ?? "").trim());
  }
  return notes;
}

/** Everything below `CLI_DOC_MARKER` in docs/reference/cli.md. */
export function renderCliMarkdown(notes: ReadonlyMap<string, string>): string {
  const out = [
    "## Command map",
    "",
    "| Command | Old verb (hidden alias until 4.0) | Summary |",
    "|---|---|---|",
  ];
  for (const c of COMMANDS) {
    const old = (c.aliases ?? []).map((a) => `\`${a.join(" ")}\``).join(", ");
    out.push(`| \`axiom ${commandName(c)}\` | ${old === "" ? "-" : old} | ${mdCell(c.summary)} |`);
  }
  out.push("");
  const sections: string[] = [];
  for (const c of COMMANDS) {
    const s = c.path[0] ?? "";
    if (!sections.includes(s)) sections.push(s);
  }
  for (const s of sections) {
    const group = findGroup(s);
    const cmds = COMMANDS.filter((c) => c.path[0] === s);
    const only = cmds.length === 1 ? cmds[0] : undefined;
    if (group === undefined && only !== undefined && only.path.length === 1) {
      out.push(...mdCommand(only, "##", notes).map((l, i) => (i === 0 ? `## \`${s}\`` : l)));
      continue;
    }
    out.push(`## \`${s}\``, "");
    if (group !== undefined) out.push(`${group.summary}.`, "");
    for (const c of cmds) out.push(...mdCommand(c, "###", notes));
  }
  return `${out.join("\n").trimEnd()}\n`;
}
