/**
 * Shared verdict shape of the v2.6 gate rule modules (D-39): command rules, session/overwrite
 * rules, coordination and git-state facts. Each module returns `undefined` (no opinion) or one
 * `RuleVerdict`; `gate.ts` turns it into a deny (or an ask) in the harness's own format.
 *
 * `id` is predicate-style (`command.deny`, `session.foreignWrite`, …) — never an `ERR_*` code:
 * those stay a closed enum in `@codai/axiom-schema`.
 */
export interface RuleVerdict {
  /** Predicate-style rule id, e.g. `command.deny`, `coord.frozen`, `git.dirtyTree`. */
  id: string;
  /** One sentence for the agent: what was refused and why. */
  reason: string;
  /** Root-relative POSIX path the verdict is about, when there is one. */
  path?: string;
  /** Exact command or step that does the same thing the sanctioned way. */
  fix?: string;
  /** `ask` = let the human decide (Claude / VS Code / Copilot honour it); default `deny`. */
  decision?: "deny" | "ask";
}

/** Sub-rule ids, for docs and tests. */
export const RULE_IDS = [
  "command.deny",
  "session.foreignWrite",
  "blind.overwrite",
  "blind.staleScript",
  "coord.frozen",
  "coord.leased",
  "coord.queueRequired",
  "git.dirtyTree",
  "git.noPathspec",
  "git.branch",
] as const;
export type RuleId = (typeof RULE_IDS)[number];
