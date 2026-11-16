import { describe, expect, it } from "vitest";
import {
  findJsonTooDeep,
  MAX_PLAN_JSON_DEPTH,
  PLAN_EDITOR_KEYS,
  stripPlanEditorKeys,
} from "./plan-input.js";

const nest = (levels: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = { a: v };
  return v;
};

describe("stripPlanEditorKeys", () => {
  it("drops a top-level $schema and keeps every other key (including nested ones)", () => {
    const plan = { $schema: "https://example/schema.json", name: "p", metadata: { $schema: 1 } };
    const out = stripPlanEditorKeys(plan) as Record<string, unknown>;
    expect(Object.hasOwn(out, "$schema")).toBe(false);
    expect(out.name).toBe("p");
    expect(out.metadata).toEqual({ $schema: 1 });
  });

  it("returns the same reference when there is nothing to strip", () => {
    const plan = { name: "p" };
    expect(stripPlanEditorKeys(plan)).toBe(plan);
  });

  it("leaves non-objects alone", () => {
    expect(stripPlanEditorKeys(null)).toBeNull();
    expect(stripPlanEditorKeys("x")).toBe("x");
    expect(stripPlanEditorKeys([1, 2])).toEqual([1, 2]);
  });

  it("names only $schema as an editor key", () => {
    expect(PLAN_EDITOR_KEYS).toEqual(["$schema"]);
  });

  it("A1-15: keeps an own `__proto__` key own, so the copy cannot be re-linked", () => {
    const plan = JSON.parse(
      '{"$schema":"x","__proto__":{"artifacts":[{"path":"inherited"}]},"name":"p"}',
    ) as Record<string, unknown>;
    expect(Object.hasOwn(plan, "__proto__")).toBe(true);
    const out = stripPlanEditorKeys(plan) as Record<string, unknown>;
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "$schema")).toBe(false);
    expect(out.name).toBe("p");
    expect(({} as Record<string, unknown>).artifacts).toBeUndefined();
  });
});

describe("findJsonTooDeep", () => {
  it("accepts nesting up to the cap and reports the first value past it", () => {
    expect(findJsonTooDeep(nest(MAX_PLAN_JSON_DEPTH - 1))).toBeUndefined();
    const violation = findJsonTooDeep(nest(MAX_PLAN_JSON_DEPTH + 3));
    expect(violation?.depth).toBeGreaterThan(MAX_PLAN_JSON_DEPTH);
    expect(violation?.at.startsWith("a")).toBe(true);
  });

  it("counts array nesting as well", () => {
    let v: unknown = 1;
    for (let i = 0; i < MAX_PLAN_JSON_DEPTH + 3; i++) v = [v];
    expect(findJsonTooDeep(v)?.depth).toBeGreaterThan(MAX_PLAN_JSON_DEPTH);
  });

  it("terminates on a cyclic object instead of looping", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(findJsonTooDeep(cyclic)?.depth).toBe(MAX_PLAN_JSON_DEPTH + 1);
  });

  it("ignores class instances, which are not JSON", () => {
    const instance = new (class Deep {
      a = nest(MAX_PLAN_JSON_DEPTH + 5);
    })();
    expect(findJsonTooDeep(instance)).toBeUndefined();
  });

  it("honours a caller cap", () => {
    // nest(n) puts the leaf value at depth n + 1
    expect(findJsonTooDeep(nest(3), 2)?.depth).toBe(3);
    expect(findJsonTooDeep(nest(1), 2)).toBeUndefined();
  });
});
