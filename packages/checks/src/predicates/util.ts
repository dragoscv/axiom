import type { Finding, Severity } from "@codai/axiom-schema";
import picomatch from "picomatch";
import type { PredicateId } from "../types.js";

export type Matcher = (path: string) => boolean;

export function globMatcher(globs: readonly string[] | undefined, whenEmpty: boolean): Matcher {
  if (globs === undefined || globs.length === 0) return () => whenEmpty;
  const m = picomatch([...globs], { dot: true });
  return (p) => m(p);
}

export interface FindingInput {
  id: string;
  predicate: PredicateId;
  message: string;
  path?: string;
  severity?: Severity;
  facts?: Record<string, unknown>;
}

/**
 * Predicates emit findings with the severity they judge appropriate; the runner
 * re-labels them with the CheckRef severity unless the finding is `error` from a
 * provider failure. Default here is `error`.
 */
export function finding(f: FindingInput): Finding {
  const out: Finding = {
    id: f.id,
    severity: f.severity ?? "error",
    predicate: f.predicate,
    message: f.message,
    facts: (f.facts ?? {}) as Finding["facts"],
  };
  if (f.path !== undefined) out.path = f.path;
  return out;
}

export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
