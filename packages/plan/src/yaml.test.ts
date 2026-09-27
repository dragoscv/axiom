import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type AxiomError, isAxiomError } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { compilePlan } from "./compile.js";
import { isYamlPath, parsePlanYaml } from "./yaml.js";

const GOLDEN = new URL("../../testkit/golden/", import.meta.url);

async function expectInvalid(text: string): Promise<AxiomError> {
  try {
    await parsePlanYaml(text);
  } catch (err) {
    expect(isAxiomError(err)).toBe(true);
    expect((err as AxiomError).code).toBe("ERR_INVALID_PLAN");
    return err as AxiomError;
  }
  throw new Error("expected ERR_INVALID_PLAN");
}

/** YAML rendering of packages/testkit/golden/plan-basic.plan.json. */
const BASIC_YAML = `# yaml-language-server: $schema=https://axiom.dev/schemas/plan.json
$schema: https://axiom.dev/schemas/plan.json
apiVersion: axiom.dev/v2
kind: Plan
name: golden-basic
intent: "Three inline files: text, nested path, and a binary payload. Cross-OS determinism guard."
artifacts:
  - path: src/index.ts
    source:
      type: inline
      content: "export const answer = 42;\\n"
  - path: README.md
    mode: "0644"
    op: overwrite
    source:
      type: inline
      content: "# golden\\n\\nhéllo — ✓ 日本語\\n"
  - path: bin/run.sh
    mode: "0755"
    source:
      type: inline
      content: IyEvYmluL3NoCmVjaG8gAGJpbmFyeQo=
      encoding: base64
checks:
  - id: no-secrets
    predicate: content.noSecrets
    params: {}
  - id: deny-env
    predicate: path.deny
    params: [".env*"]
    severity: error
`;

describe("parsePlanYaml — equivalence", () => {
  it("compiles a YAML plan to the same manifestDigest as its JSON golden form", async () => {
    const json: unknown = JSON.parse(
      await readFile(fileURLToPath(new URL("plan-basic.plan.json", GOLDEN)), "utf8"),
    );
    const expected = JSON.parse(
      await readFile(fileURLToPath(new URL("plan-basic.expected.json", GOLDEN)), "utf8"),
    ) as { manifestDigest: string };
    const fromYaml = await compilePlan(await parsePlanYaml(BASIC_YAML));
    const fromJson = await compilePlan(json);
    expect(fromYaml.bundle.manifestDigest).toBe(fromJson.bundle.manifestDigest);
    expect(fromYaml.bundle.manifestDigest).toBe(expected.manifestDigest);
  });

  it("strips a top-level $schema key and accepts the yaml-language-server comment", async () => {
    const out = (await parsePlanYaml(BASIC_YAML)) as Record<string, unknown>;
    expect(Object.hasOwn(out, "$schema")).toBe(false);
    expect(out.name).toBe("golden-basic");
  });

  it("accepts CRLF line endings", async () => {
    const out = (await parsePlanYaml(BASIC_YAML.replace(/\n/g, "\r\n"))) as Record<string, unknown>;
    expect(out.kind).toBe("Plan");
  });
});

describe("parsePlanYaml — hardening", () => {
  it("rejects a billion-laughs alias bomb", async () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    const names = "bcdefghij";
    let prev = "a";
    for (const n of names) {
      lines.push(
        `${n}: &${n} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`,
      );
      prev = n;
    }
    await expectInvalid(`${lines.join("\n")}\n`);
  });

  it("rejects duplicate keys with a line/column", async () => {
    const err = await expectInvalid("apiVersion: axiom.dev/v2\nkind: Plan\nkind: Plan\n");
    expect(err.details?.line).toBe(3);
    expect(typeof err.details?.column).toBe("number");
  });

  it("rejects multi-document input", async () => {
    const err = await expectInvalid("kind: Plan\n---\nkind: Plan\n");
    expect(err.details?.line).toBe(2);
  });

  it("rejects non-mapping roots", async () => {
    await expectInvalid("- a\n- b\n");
    await expectInvalid("just a string\n");
  });

  it("rejects an empty document", async () => {
    await expectInvalid("");
    await expectInvalid("# only a comment\n");
  });

  it("reports line and column for syntax errors", async () => {
    const err = await expectInvalid('name: x\nintent: "unterminated\n');
    expect(typeof err.details?.line).toBe("number");
    expect(typeof err.details?.column).toBe("number");
  });

  it("rejects custom and non-core tags", async () => {
    await expectInvalid("name: !!binary aGVsbG8=\n");
    await expectInvalid("name: !js/function 'x'\n");
  });

  it("does not resolve merge keys", async () => {
    const out = (await parsePlanYaml("base: &b {x: 1}\nobj:\n  <<: *b\n")) as {
      obj: Record<string, unknown>;
    };
    expect(out.obj.x).toBeUndefined();
    expect(Object.hasOwn(out.obj, "<<")).toBe(true);
  });

  it("does not pollute prototypes via a __proto__ key", async () => {
    const out = (await parsePlanYaml("__proto__:\n  polluted: true\n")) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("isYamlPath", () => {
  it("matches .yaml/.yml case-insensitively only", () => {
    expect(isYamlPath("plan.yaml")).toBe(true);
    expect(isYamlPath("dir/Plan.YML")).toBe(true);
    expect(isYamlPath("plan.json")).toBe(false);
    expect(isYamlPath("plan.yaml.json")).toBe(false);
  });
});
