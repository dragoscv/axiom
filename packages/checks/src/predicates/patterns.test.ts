import { describe, expect, it } from "vitest";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { GLOB_MAX_CHARS, GLOB_MAX_WILDCARD_RUNS, globIssues, globMatcher } from "./util.js";

/**
 * A1-4 regression: the exact adversarial inputs from the audit. Before the caps, `path.deny`
 * with `("*a" × 6) + "b"` took 12.8 s on a 64-character path and 7 groups never returned; the CEL
 * literal `^(a+)+$` took 4.5 s at 26 characters. Both are reachable from `plan.checks[]`, so
 * `plan check`, `axiom_check` and `axiom_apply` stopped answering.
 */
const b = makeBundle([{ path: `${"a".repeat(64)}.txt`, content: "x" }]);

const one = (predicate: string, params: unknown) =>
  profileWith([{ id: predicate, predicate, params: params as never, severity: "error" }]);

describe("adversarial patterns are refused, never evaluated (A1-4)", () => {
  const adversarialGlob = `${"*a".repeat(6)}*b`;

  it("names the reasons a glob is unsafe", () => {
    expect(GLOB_MAX_WILDCARD_RUNS).toBeLessThan(6);
    expect(globIssues(adversarialGlob).join(" ")).toContain("wildcard groups");
    expect(globIssues(`!src/**`).join(" ")).toContain("negated");
    expect(globIssues("a".repeat(GLOB_MAX_CHARS + 1)).join(" ")).toContain("characters");
    expect(globIssues("**/*.ts")).toEqual([]);
  });

  it("globMatcher throws instead of backtracking", () => {
    expect(() => globMatcher([adversarialGlob], false)).toThrow(
      expect.objectContaining({ code: "ERR_PREDICATE_PARAMS" }),
    );
  });

  it("path.deny fails the run with ERR_PREDICATE_PARAMS", async () => {
    const r = await runChecks({
      bundle: b,
      profile: one("path.deny", { globs: [adversarialGlob] }),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
  });

  it("expr.cel fails the run with ERR_PREDICATE_PARAMS", async () => {
    const r = await runChecks({
      bundle: b,
      profile: one("expr.cel", {
        expression: `"${"a".repeat(26)}!".matches("^(a+)+$")`,
      }),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
  });

  it("a benign CEL regex is still evaluated", async () => {
    const r = await runChecks({
      bundle: b,
      profile: one("expr.cel", { expression: `"abc".matches("[a-z]+")` }),
    });
    expect(r.verdict).toBe("pass");
  });
});
