/**
 * Editor hints on a Plan document.
 *
 * `PlanSchema` is `.strict()`, so a top-level `$schema` key — which editors and JSON-Schema
 * tooling add automatically — would be `ERR_INVALID_PLAN` ("Unrecognized key"). The YAML reader
 * has always dropped it; this module makes the same drop available to every front-end that hands
 * a parsed object to `compilePlan`, so a JSON Plan and its YAML/`.axm` twins compile to the SAME
 * `manifestDigest` (the key is an editor hint, never part of the plan).
 */
export const PLAN_EDITOR_KEYS: readonly string[] = Object.freeze(["$schema"]);

/**
 * Maximum JSON nesting depth accepted in a Plan (`metadata`, template `params`). zod's `z.json()`
 * recurses per level and a 2000-deep `metadata` value overflows the stack with a `RangeError`
 * before `PlanSchema` can report an issue; this cap turns that into an `ERR_INVALID_PLAN`.
 * Kept equal to `MAX_CANONICAL_DEPTH` so anything accepted here also canonicalizes.
 */
export const MAX_PLAN_JSON_DEPTH: number = 256;

export interface JsonDepthViolation {
  /** Dotted path of the offending member, for the error details. */
  at: string;
  depth: number;
}

/**
 * Iterative (never recursive) search for a JSON value nested deeper than `max`, so the search
 * itself cannot overflow the stack. Only plain objects and arrays count as nesting; a cyclic
 * input terminates on the cap instead of looping.
 */
export function findJsonTooDeep(
  value: unknown,
  max: number = MAX_PLAN_JSON_DEPTH,
): JsonDepthViolation | undefined {
  const stack: Array<{ node: unknown; depth: number; at: string }> = [
    { node: value, depth: 1, at: "" },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    if (cur.depth > max) return { at: cur.at, depth: cur.depth };
    const node = cur.node;
    if (node === null || typeof node !== "object") continue;
    if (!Array.isArray(node)) {
      const proto: unknown = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) continue;
    }
    for (const [key, child] of Object.entries(node)) {
      stack.push({
        node: child,
        depth: cur.depth + 1,
        at: cur.at === "" ? key : `${cur.at}.${key}`,
      });
    }
  }
  return undefined;
}

/**
 * Drop `$schema` (and only that key) from a top-level Plan object. Non-objects and arrays are
 * returned unchanged; an object without the key is returned unchanged (same reference).
 */
export function stripPlanEditorKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const hasEditorKey = PLAN_EDITOR_KEYS.some((key) => Object.hasOwn(value, key));
  if (!hasEditorKey) return value;
  // Copy by SPREAD, never `out[key] = member`: JSON.parse creates `__proto__` as an OWN
  // property, and assignment would run the inherited setter instead, re-linking the copy's
  // prototype — after which zod would read plan fields through the prototype chain. Spread uses
  // CreateDataProperty (what the YAML reader's rest-destructuring always did), so every own key
  // stays an own key.
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of PLAN_EDITOR_KEYS) delete out[key];
  return out;
}
