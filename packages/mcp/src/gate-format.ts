/** Per-harness allow / deny documents of the gate and the `GateDeny` verdict (moved out of gate.ts in 4.0). */
import { allowStdout, GATE_FORMATS, type GateFormat, type ToolClass } from "./gate-fast.js";
import type { RuleVerdict } from "./gate-verdict.js";

export const GATE_EXIT_ALLOW = 0;
/** Hard-deny exit: usage errors, and every deny under `--deny-exit 2`. */
export const GATE_EXIT_DENY = 2;
/** Default exit for a deny (D-35): the JSON document on stdout carries the decision. */
export const GATE_DENY_EXIT_DEFAULT = 0;

export class GateDeny extends Error {
  readonly code: string;
  readonly relPath: string | undefined;
  /** Sanctioned command/step that does the same thing (v2.6 rule verdicts). */
  readonly fix: string | undefined;
  /** Let the human decide instead of refusing (formats that support `ask`; deny elsewhere). */
  readonly ask: boolean;
  constructor(
    code: string,
    message: string,
    relPath?: string,
    opts: { fix?: string; ask?: boolean } = {},
  ) {
    super(message);
    this.name = "GateDeny";
    this.code = code;
    this.relPath = relPath;
    this.fix = opts.fix;
    this.ask = opts.ask === true;
  }
}

/** A v2.6 rule verdict (`command.deny`, `coord.frozen`, …) as a gate deny. */
export function verdictDeny(v: RuleVerdict): GateDeny {
  return new GateDeny(v.id, v.reason, v.path, {
    ...(v.fix === undefined ? {} : { fix: v.fix }),
    ask: v.decision === "ask",
  });
}

// ---------------------------------------------------------------- formats --

/**
 * The deny document a harness reads, and where it expects it.
 *
 *   `none`     — the exit code is the whole verdict, stdout is not read (Windsurf, Kiro).
 *   `hook`     — `{"hookSpecificOutput": {hookEventName: "PreToolUse", permissionDecision,
 *                permissionDecisionReason}}` and NOTHING else (Claude validates the document
 *                against its schema: an extra top-level key turns the deny into a non-blocking
 *                hook error; Codex reads the same field and ignores the exit code).
 *   `cursor`   — `{"permission": "deny", "user_message", "agent_message"}`.
 *   `decision` — `{"decision": "deny"|"ask", "reason"}` (Gemini, Junie).
 *   `cline`    — `{"cancel": true, "errorMessage"}`.
 *   `combined` — the `hook` document PLUS the flat `{permissionDecision, permissionDecisionReason}`
 *                and the `axiom` block (auto, Copilot CLI, VS Code).
 */
export type DenyDocumentKind = "none" | "hook" | "cursor" | "decision" | "cline" | "combined";

/** One row of {@link GATE_FORMAT_TABLE}: the per-harness deny contract, in one place. */
export interface GateFormatRow {
  /** Where the deny document goes. */
  document: DenyDocumentKind;
  /** Default exit code of a deny; `--deny-exit 2` overrides it (D-35). */
  exit: 0 | 2;
  /** The harness has a prompt for `permissionDecision: "ask"` (the human decides). */
  ask: boolean;
  /** The harness' exit-code contract, as a sentence: emitted into both renderers. */
  note: string;
}

/**
 * THE per-format table (4.0, A3-5/A2-19): the deny documents and exit codes of every harness
 * AXIOM wires into, in one place. `gate-format.ts` renders from it, the native client
 * (`crates/axiom-hook`) gets the same rows compiled from it by `scripts/gen-deny-table.mjs`
 * (`crates/axiom-hook/src/deny_table.rs`) and a parity test compares the two over every entry of
 * `GATE_FORMATS`. Until 4.0 the same three tables existed separately and drifted: the native
 * client had no `kiro` case (exit 0 = allow for Kiro) and its Claude document carried the extra
 * top-level keys Claude rejects (A2-19, A3-5).
 */
export const GATE_FORMAT_TABLE: Readonly<Record<GateFormat, GateFormatRow>> = {
  auto: {
    document: "combined",
    exit: 0,
    ask: true,
    note: "auto = the combined document (Claude hookSpecificOutput + flat Copilot shape + axiom block); every JSON-reading harness honours it on exit 0.",
  },
  claude: {
    document: "hook",
    exit: 0,
    ask: true,
    note: "Claude Code validates the hook document: ONLY hookSpecificOutput (extra top-level keys make the deny a non-blocking hook error). Blocks on the document at exit 0.",
  },
  copilot: {
    document: "combined",
    exit: 0,
    ask: true,
    note: "Copilot CLI / VS Code merge the flat permissionDecision + permissionDecisionReason from stdout and block at exit 0 (a non-zero exit alone is a warning: 129 of 134 production denies were dropped that way, D-35).",
  },
  vscode: {
    document: "combined",
    exit: 0,
    ask: true,
    note: "VS Code reads the same flat shape as the Copilot CLI and blocks at exit 0.",
  },
  codex: {
    document: "hook",
    exit: 0,
    ask: false,
    note: "Codex reads hookSpecificOutput.permissionDecision from stdout; the exit code is ignored.",
  },
  cursor: {
    document: "cursor",
    exit: 0,
    ask: false,
    note: 'Cursor\'s failClosed treats an empty hook output as a failure, so deny is explicit: {permission: "deny"} at exit 0.',
  },
  windsurf: {
    document: "none",
    exit: 2,
    ask: false,
    note: "Cascade/Devin hooks block on exit 2 ONLY and do not read stdout (exit 1 is non-blocking).",
  },
  kiro: {
    document: "none",
    exit: 2,
    ask: false,
    note: "Kiro blocks on any non-zero exit and does not read stdout: exit 2 with an EMPTY stdout. Exit 0 is an allow (the 3.0 native client and the daemon client printed JSON and exited 0 here, A2-19).",
  },
  gemini: {
    document: "decision",
    exit: 0,
    ask: false,
    note: 'Gemini CLI reads {decision: "deny", reason} from stdout at exit 0.',
  },
  junie: {
    document: "decision",
    exit: 0,
    ask: true,
    note: 'Junie reads {decision, reason} from stdout; decision "ask" pauses and asks the Human.',
  },
  cline: {
    document: "cline",
    exit: 0,
    ask: false,
    note: "Cline blocks on {cancel: true, errorMessage} from stdout at exit 0.",
  },
};

/** Formats that can carry a hint on an allow. */
export const HINT_FORMATS: ReadonlySet<GateFormat> = new Set<GateFormat>([
  "auto",
  "claude",
  "copilot",
  "vscode",
  "codex",
  "junie",
  "cursor",
  "cline",
]);

/** stdout for an ALLOW in `format`, carrying `hint` when given. */
export function allowDocument(format: GateFormat, hint?: string): string | undefined {
  if (hint === undefined || !HINT_FORMATS.has(format)) return allowStdout(format);
  if (format === "cursor") return JSON.stringify({ permission: "allow", agent_message: hint });
  if (format === "cline") return JSON.stringify({ cancel: false, contextModification: hint });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: hint },
  });
}

/** stdout (undefined = none) and exit code of a DENY in `format`. */
export function renderDeny(
  format: GateFormat,
  d: GateDeny,
  reason: string,
  extra: { toolClass?: ToolClass; denyExit?: 0 | 2 },
): { stdout: string | undefined; exitCode: 0 | 2 } {
  const row: GateFormatRow = GATE_FORMAT_TABLE[format] ?? GATE_FORMAT_TABLE.auto;
  const exitCode: 0 | 2 = extra.denyExit ?? row.exit;
  // `ask` hands the decision to the human where the harness has a prompt for it; every other
  // format gets a plain deny (fail-closed).
  const decision = d.ask && row.ask ? "ask" : "deny";
  switch (row.document) {
    // Windsurf/Cascade and Kiro: exit code only, stdout is never read.
    case "none":
      return { stdout: undefined, exitCode };
    case "cursor":
      return {
        stdout: JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }),
        exitCode,
      };
    case "decision":
      // Junie pauses and asks the user on `decision: "ask"`; Gemini only denies.
      return { stdout: JSON.stringify({ decision, reason }), exitCode };
    case "cline":
      return { stdout: JSON.stringify({ cancel: true, errorMessage: reason }), exitCode };
    case "hook":
      // Claude validates the hook document against its schema: ONLY `hookSpecificOutput`
      // (extra top-level keys can turn a deny into a non-blocking hook error). Codex reads
      // the same field and ignores the exit code.
      return {
        stdout: JSON.stringify({ hookSpecificOutput: hookDocument(decision, reason) }),
        exitCode,
      };
    default:
      return {
        stdout: JSON.stringify(
          denyDocument(
            d,
            reason,
            extra.toolClass === undefined ? {} : { toolClass: extra.toolClass },
            decision,
          ),
        ),
        exitCode,
      };
  }
}

/** The Claude/Copilot `hookSpecificOutput` object shared by the `hook` and `combined` documents. */
export function hookDocument(
  decision: "deny" | "ask",
  reason: string,
): {
  hookEventName: "PreToolUse";
  permissionDecision: "deny" | "ask";
  permissionDecisionReason: string;
} {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
    permissionDecisionReason: reason,
  };
}

/** Formats whose PreToolUse contract has `permissionDecision: "ask"` (Claude, VS Code, Copilot). */
export const ASK_FORMATS: ReadonlySet<GateFormat> = new Set<GateFormat>(
  (Object.keys(GATE_FORMAT_TABLE) as GateFormat[]).filter((f) => GATE_FORMAT_TABLE[f].ask),
);

// ------------------------------------------------- the native client's copy --

/**
 * The code and reason the parity goldens use. Both renderers (this module and
 * `crates/axiom-hook`) are run with exactly this pair and the results are compared, so a
 * format added or changed on one side alone fails a test.
 */
export const DENY_PARITY_CODE = "ERR_INTERNAL";
export const DENY_PARITY_REASON = "parity probe";

/** One golden row: `GATE_FORMATS` order, the deny stdout (undefined = nothing) and the exit. */
export interface DenyParityRow {
  format: GateFormat;
  stdout: string | undefined;
  exit: 0 | 2;
}

/** The deny both renderers must produce for {@link DENY_PARITY_CODE}/{@link DENY_PARITY_REASON}. */
export function denyParityGolden(): DenyParityRow[] {
  return GATE_FORMATS.map((format) => {
    const r = renderDeny(
      format,
      new GateDeny(DENY_PARITY_CODE, DENY_PARITY_REASON),
      DENY_PARITY_REASON,
      {},
    );
    return { format, stdout: r.stdout, exit: r.exitCode };
  });
}

/** `GATE_FORMATS`, re-exported for the generator and the parity test. */
export const DENY_FORMATS: readonly GateFormat[] = GATE_FORMATS;

function rustString(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) {
    throw new Error(`the deny table must stay ASCII: ${JSON.stringify(s)}`);
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The Rust source of `crates/axiom-hook/src/deny_table.rs`, generated from
 * {@link GATE_FORMAT_TABLE} and {@link denyParityGolden}. `scripts/gen-deny-table.mjs` writes it;
 * `gate-format.test.ts` regenerates it in-process and compares, so the committed file can never
 * drift from the table (A3-5).
 */
export function renderDenyTableRust(): string {
  const rows = GATE_FORMATS.map((f) => {
    const r = GATE_FORMAT_TABLE[f];
    const ask = r.ask ? "true" : "false";
    return `    FormatRow { format: ${rustString(f)}, document: ${rustString(r.document)}, exit: ${r.exit}, ask: ${ask}, note: ${rustString(r.note)} },`;
  }).join("\n");
  const golden = denyParityGolden()
    .map((f) => {
      const out = f.stdout === undefined ? "None" : `Some(${rustString(f.stdout)})`;
      return `    (${rustString(f.format)}, ${out}, ${f.exit}),`;
    })
    .join("\n");
  return `// @generated by scripts/gen-deny-table.mjs from packages/mcp/src/gate-format.ts. DO NOT EDIT.
//!
//! The per-harness deny contract, generated from \`GATE_FORMAT_TABLE\` so the native client and
//! the gate can no longer drift (A3-5/A2-19). Regenerate with:
//!
//!     node scripts/gen-deny-table.mjs
//!
//! \`deny.rs\` renders from \`FORMAT_ROWS\`; \`PARITY_GOLDEN\` is the deny both renderers must
//! produce for \`PARITY_CODE\`/\`PARITY_REASON\` (stdout compared as parsed JSON, so key order in
//! a document does not matter). \`packages/mcp/src/gate-format.test.ts\` runs the TS renderer over
//! the same rows and this crate's \`deny.rs\` tests run the Rust one.

/// One harness: how it reads the deny (see the gate-format.ts docs for each \`document\` kind).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FormatRow {
    /// \`--format\` name, as in \`GATE_FORMATS\`.
    pub format: &'static str,
    /// \`none\` | \`hook\` | \`cursor\` | \`decision\` | \`cline\` | \`combined\`.
    pub document: &'static str,
    /// Default exit code of a deny; \`--deny-exit 2\` overrides it.
    pub exit: i32,
    /// The harness has a human prompt for \`permissionDecision: "ask"\`.
    pub ask: bool,
    /// The harness' exit-code contract.
    pub note: &'static str,
}

pub const FORMAT_ROWS: [FormatRow; ${String(GATE_FORMATS.length)}] = [
${rows}
];

/// The row every unknown \`--format\` falls back to (\`auto\`: the combined document).
pub const AUTO_ROW: FormatRow = FORMAT_ROWS[0];

/// Code and reason of the parity goldens (\`DENY_PARITY_CODE\`/\`DENY_PARITY_REASON\`).
pub const PARITY_CODE: &str = "ERR_INTERNAL";
pub const PARITY_REASON: &str = "parity probe";

/// \`(format, stdout (None = nothing printed), exit)\` at the default deny exit.
pub const PARITY_GOLDEN: &[(&str, Option<&str>, i32)] = &[
${golden}
];
`;
}
/**
 * The single stdout document for a deny. Claude reads `hookSpecificOutput.permissionDecision`;
 * Copilot CLI/VS Code read the flat `permissionDecision`/`permissionDecisionReason` and merge
 * them into their own deny; `axiom` carries the machine-readable verdict (OWASP ACS
 * vocabulary) plus code/path for log consumers. Unknown keys are ignored by both harnesses.
 */
export function denyDocument(
  d: GateDeny,
  reason: string,
  extra: { toolClass?: ToolClass },
  decision: "deny" | "ask" = "deny",
) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
    permissionDecision: decision,
    permissionDecisionReason: reason,
    axiom: {
      verdict: decision,
      code: d.code,
      ...(d.relPath === undefined ? {} : { path: d.relPath }),
      ...(d.fix === undefined ? {} : { fix: d.fix }),
      ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
      standard: "owasp-acs/0.1",
    },
  };
}
