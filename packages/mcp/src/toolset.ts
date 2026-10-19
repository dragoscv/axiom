/**
 * MCP tool sets (D-43). Kept dependency-light (schema only) so the eager `cli-main` can parse
 * `--tools core|full` without pulling the tool registry (and its SDK-facing code) into the bin.
 *
 * `core` — the six tools an agent needs to write through the gate — is served by default;
 * `full` adds the plan / manifest / task plumbing.
 */
import { AxiomError } from "@codai/axiom-schema";

export const TOOLSETS = ["core", "full"] as const;
export type Toolset = (typeof TOOLSETS)[number];
export const DEFAULT_TOOLSET: Toolset = "core";

export const CORE_TOOL_NAMES: readonly string[] = [
  "axiom_write",
  "axiom_status",
  "axiom_rollback",
  "axiom_check",
  "axiom_apply",
  "axiom_apply_dry_run",
];

/** `--tools <value>` → Toolset; absent → `core`; anything else → ERR_USAGE. */
export function parseToolset(value: string | undefined): Toolset {
  if (value === undefined) return DEFAULT_TOOLSET;
  const v = value.trim().toLowerCase();
  if ((TOOLSETS as readonly string[]).includes(v)) return v as Toolset;
  throw new AxiomError("ERR_USAGE", `--tools expects core|full, got "${value}"`, {
    details: { value, allowed: [...TOOLSETS] },
  });
}

/** Smallest toolset that contains `name` (`core` tools are also part of `full`). */
export function toolsetOf(name: string): Toolset {
  return CORE_TOOL_NAMES.includes(name) ? "core" : "full";
}
