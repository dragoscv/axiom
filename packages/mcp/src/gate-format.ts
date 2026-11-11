/** Per-harness allow / deny documents of the gate and the `GateDeny` verdict (moved out of gate.ts in 4.0). */
import { allowStdout, type GateFormat, type ToolClass } from "./gate-fast.js";
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
  const exit = (dflt: 0 | 2): 0 | 2 => extra.denyExit ?? dflt;
  // `ask` hands the decision to the human where the harness has a prompt for it; every other
  // format gets a plain deny (fail-closed).
  const decision = d.ask && ASK_FORMATS.has(format) ? "ask" : "deny";
  switch (format) {
    case "codex":
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
        exitCode: exit(0),
      };
    case "cursor":
      return {
        stdout: JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }),
        exitCode: exit(0),
      };
    case "windsurf":
    case "kiro":
      // Cascade/Devin hooks block only on exit 2, Kiro on any non-zero exit; stdout is not read.
      return { stdout: undefined, exitCode: exit(GATE_EXIT_DENY) };
    case "gemini":
      return { stdout: JSON.stringify({ decision: "deny", reason }), exitCode: exit(0) };
    case "junie":
      // Junie pauses and asks the user on `decision: "ask"`.
      return { stdout: JSON.stringify({ decision, reason }), exitCode: exit(0) };
    case "claude":
      // Claude validates the hook document against its schema: only `hookSpecificOutput`
      // (extra top-level keys can turn a deny into a non-blocking hook error).
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason,
          },
        }),
        exitCode: exit(GATE_DENY_EXIT_DEFAULT),
      };
    case "cline":
      return { stdout: JSON.stringify({ cancel: true, errorMessage: reason }), exitCode: exit(0) };
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
        exitCode: exit(GATE_DENY_EXIT_DEFAULT),
      };
  }
}

/** Formats whose PreToolUse contract has `permissionDecision: "ask"` (Claude, VS Code, Copilot). */
export const ASK_FORMATS: ReadonlySet<GateFormat> = new Set<GateFormat>([
  "auto",
  "claude",
  "copilot",
  "vscode",
  "junie",
]);

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
