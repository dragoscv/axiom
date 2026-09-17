import { describe, expect, it } from "vitest";
import { canonicalHash, sha256Hex } from "./digest.js";
import { canonicalize } from "./jcs.js";
import {
  AXIOM_BUILD_TYPE,
  AXIOM_BUILDER_ID,
  type BuildStatementInput,
  buildStatement,
  IN_TOTO_STATEMENT_V1,
  SLSA_PROVENANCE_V1,
} from "./statement.js";

const base: BuildStatementInput = {
  subjectName: "blog",
  manifestDigestHex: sha256Hex("manifest"),
  planDigestHex: sha256Hex("plan"),
  profile: "default",
  toolchain: { "emitter:webapp": "2.0.0", axiom: "2.0.0" },
  byproducts: [
    { name: "src/b.ts", sha256: sha256Hex("b") },
    { name: "src/a.ts", sha256: sha256Hex("a") },
  ],
};

describe("buildStatement", () => {
  it("emits an in-toto Statement v1 with SLSA v1 predicate", () => {
    const s = buildStatement(base);
    expect(s._type).toBe(IN_TOTO_STATEMENT_V1);
    expect(s.predicateType).toBe(SLSA_PROVENANCE_V1);
    expect(s.subject).toEqual([{ name: "blog", digest: { sha256: base.manifestDigestHex } }]);
    expect(s.predicate.buildDefinition.buildType).toBe(AXIOM_BUILD_TYPE);
    expect(s.predicate.buildDefinition.externalParameters).toEqual({
      plan: { sha256: base.planDigestHex },
      profile: "default",
    });
    expect(s.predicate.runDetails.builder.id).toBe(AXIOM_BUILDER_ID);
    expect(s.predicate.runDetails.metadata).toBeUndefined();
    expect(s.predicate.runDetails.byproducts.map((b) => b.name)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("is deterministic: two builds hash identically regardless of input ordering", () => {
    const a = buildStatement(base);
    const b = buildStatement({
      ...base,
      toolchain: { axiom: "2.0.0", "emitter:webapp": "2.0.0" },
      byproducts: [...(base.byproducts ?? [])].reverse(),
    });
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("omits metadata when none given, includes only provided fields otherwise", () => {
    expect("metadata" in buildStatement(base).predicate.runDetails).toBe(false);
    const s = buildStatement({ ...base, invocationId: "inv-1" });
    expect(s.predicate.runDetails.metadata).toEqual({ invocationId: "inv-1" });
    expect(canonicalHash(s)).not.toBe(canonicalHash(buildStatement(base)));
  });

  it("defaults byproducts to []", () => {
    const { byproducts: _drop, ...rest } = base;
    expect(buildStatement(rest).predicate.runDetails.byproducts).toEqual([]);
  });
});
