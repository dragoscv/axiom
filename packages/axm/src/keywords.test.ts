import { PlanSchema } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { formatAxm, KEYWORD_IMAGES, parseAxm } from "./index.js";

/** Plan names must match `^[a-z0-9][a-z0-9-]*$`; every keyword does. */
const PLAN_NAME = /^[a-z0-9][a-z0-9-]*$/;

const srcWithName = (name: string) =>
  `axiom "2"\nplan ${name} {\n  intent "keyword as plan name"\n  artifact "a.txt" { inline <<EOF\nhi\nEOF\n  }\n  meta {"k":1}\n}\n`;

describe("keywords as plan names (the lexer must not mistake them for JSON openers)", () => {
  it("covers every keyword the lexer declares", () => {
    expect(KEYWORD_IMAGES.length).toBe(25);
    for (const k of ["meta", "using", "template", "plan", "patch", "axiom"]) {
      expect(KEYWORD_IMAGES).toContain(k);
    }
  });

  it.each([...KEYWORD_IMAGES])("plan %s parses and round-trips formatAxm → parseAxm", (kw) => {
    expect(kw).toMatch(PLAN_NAME);
    const first = parseAxm(srcWithName(kw));
    expect(first.diagnostics, kw).toEqual([]);
    expect(first.plan?.name).toBe(kw);
    expect(first.plan?.metadata).toEqual({ k: 1 });

    const plan = PlanSchema.parse({
      apiVersion: "axiom.codai.ro/v3",
      kind: "Plan",
      name: kw,
      intent: "round-trip",
      metadata: { nested: { a: [1, 2] } },
      artifacts: [{ path: "a.txt", source: { type: "inline", content: "hi\n" } }],
    });
    const again = parseAxm(formatAxm(plan));
    expect(again.diagnostics, kw).toEqual([]);
    expect(again.plan).toStrictEqual(plan);
  });

  it("`meta` as plan name followed by a real meta item still lexes the JSON block", () => {
    const r = parseAxm(
      `axiom "2"\nplan meta {\n  intent "x"\n  artifact "a.txt" { inline <<EOF\nhi\nEOF\n  }\n  meta {"a":[1,{"b":2}]}\n}\n`,
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.plan?.metadata).toEqual({ a: [1, { b: 2 }] });
  });
});
