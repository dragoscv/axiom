import { describe, expect, it } from "vitest";
import { canonicalHash, sha256Hex } from "./digest.js";
import { canonicalize } from "./jcs.js";
import {
  AGENT_DECISION_V0_1,
  AXIOM_APPLY_ATTESTATION_V1,
  AXIOM_APPLY_ATTESTATION_V1_LEGACY,
  AXIOM_BUILD_TYPE,
  AXIOM_BUILDER_ID,
  AXIOM_SPEC_BASE,
  argsHash,
  type BuildAgentDecisionInput,
  type BuildApplyAttestationInput,
  type BuildStatementInput,
  buildAgentDecisionStatement,
  buildApplyAttestation,
  buildStatement,
  IN_TOTO_STATEMENT_V1,
  SLSA_PROVENANCE_V1,
} from "./statement.js";

describe("D-41 spec URIs", () => {
  it("every AXIOM URI lives under the docs site; the 2.x apply URI stays exported", () => {
    for (const u of [
      AXIOM_APPLY_ATTESTATION_V1,
      AXIOM_BUILD_TYPE,
      AXIOM_BUILDER_ID,
      AGENT_DECISION_V0_1,
    ]) {
      expect(u.startsWith(`${AXIOM_SPEC_BASE}/`)).toBe(true);
    }
    expect(AXIOM_APPLY_ATTESTATION_V1).toBe(
      "https://dragoscv.github.io/axiom/spec/attestation/apply/v1",
    );
    expect(AXIOM_APPLY_ATTESTATION_V1_LEGACY).toBe("https://axiom.dev/attestation/apply/v1");
  });
});

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

describe("buildApplyAttestation (S-403, D-21)", () => {
  const input: BuildApplyAttestationInput = {
    subjectName: "blog",
    manifestDigestHex: sha256Hex("manifest"),
    planDigestHex: sha256Hex("plan"),
    profile: "default",
    tree: "post",
    paths: [
      { path: "src/b.ts", op: "create", sha256: sha256Hex("b") },
      { path: "old.txt", op: "delete", sha256: "absent" },
      { path: "src/a.ts", op: "overwrite", sha256: sha256Hex("a") },
    ],
    preImage: [
      { path: "src/a.ts", sha256: sha256Hex("a0") },
      { path: "old.txt", sha256: sha256Hex("bye") },
      { path: "src/b.ts", sha256: "absent" },
    ],
    axiomVersion: "2.2.0",
  };

  it("subjects = manifest + every present path (deletes excluded), sorted; predicate carries paths/preImage sorted", () => {
    const s = buildApplyAttestation(input);
    expect(s._type).toBe(IN_TOTO_STATEMENT_V1);
    expect(s.predicateType).toBe(AXIOM_APPLY_ATTESTATION_V1);
    expect(s.subject.map((x) => x.name)).toEqual(["blog", "src/a.ts", "src/b.ts"]);
    expect(s.subject[0]?.digest.sha256).toBe(input.manifestDigestHex);
    expect(s.predicate.paths.map((p) => p.path)).toEqual(["old.txt", "src/a.ts", "src/b.ts"]);
    expect(s.predicate.preImage?.map((p) => p.path)).toEqual(["old.txt", "src/a.ts", "src/b.ts"]);
    expect(s.predicate.verifier).toEqual({ id: AXIOM_BUILDER_ID, version: "2.2.0" });
    expect(s.predicate.tree).toBe("post");
    expect(s.predicate.source).toBeUndefined();
  });

  it("is deterministic under input reordering and has no clock; source is included only when non-empty", () => {
    const a = canonicalHash(buildApplyAttestation(input));
    const shuffled: BuildApplyAttestationInput = {
      ...input,
      paths: [...input.paths].reverse(),
      preImage: input.preImage === undefined ? undefined : [...input.preImage].reverse(),
    };
    expect(canonicalHash(buildApplyAttestation(shuffled))).toBe(a);
    expect(canonicalize(buildApplyAttestation(input))).not.toMatch(/startedOn|finishedOn|"time/);
    const withSrc = buildApplyAttestation({
      ...input,
      source: { repository: "dragoscv/axiom", sha: "abc" },
    });
    expect(withSrc.predicate.source).toEqual({ repository: "dragoscv/axiom", sha: "abc" });
    expect(buildApplyAttestation({ ...input, source: {} }).predicate.source).toBeUndefined();
    const noPre = buildApplyAttestation({ ...input, preImage: undefined });
    expect(noPre.predicate.preImage).toBeUndefined();
  });
});

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

describe("argsHash (JCS, RFC 8785)", () => {
  it("hashes the canonical form: key order and whitespace do not matter", () => {
    expect(argsHash({ b: 1, a: "x" })).toBe(`sha256:${sha256Hex('{"a":"x","b":1}')}`);
    expect(argsHash({ a: "x", b: 1 })).toBe(argsHash({ b: 1, a: "x" }));
  });

  it("uses ECMAScript number serialisation (1e21 → 1e+21)", () => {
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(argsHash({ n: 1e21 })).toBe(`sha256:${sha256Hex('{"n":1e+21}')}`);
  });

  it("throws on a non-canonicalizable value", () => {
    expect(() => argsHash({ n: Number.NaN })).toThrow();
  });
});

describe("buildAgentDecisionStatement (Phase 8)", () => {
  const input: BuildAgentDecisionInput = {
    agent_id: "claude:s1",
    principal: { subject: "dev" },
    tool: "Write",
    args_hash: argsHash({ file_path: ".env", content: "X=1" }),
    args_state: "recorded",
    decision: "deny",
    code: "path.deny",
    reason: "path matches a denied glob",
    paths: ["src/b.ts", ".env"],
    profile: "builtin",
    decided_at: "2026-10-14T00:00:00.000Z",
  };

  it("emits an in-toto Statement v1 whose subject is the content-addressed invocation", () => {
    const s = buildAgentDecisionStatement(input);
    expect(s._type).toBe(IN_TOTO_STATEMENT_V1);
    expect(s.predicateType).toBe(AGENT_DECISION_V0_1);
    expect(AGENT_DECISION_V0_1).toBe(
      "https://dragoscv.github.io/axiom/spec/attestation/agent-decision/v0.1",
    );
    expect(s.subject).toEqual([
      { name: "Write", digest: { sha256: input.args_hash.slice("sha256:".length) } },
    ]);
    expect(s.predicate.policy_evaluations).toEqual([
      {
        policy: "axiom.gate",
        decision: "deny",
        reason: "path matches a denied glob",
        policy_ids: ["path.deny"],
      },
    ]);
    expect(s.predicate.tool_calls).toEqual([{ name: "Write", args_hash: input.args_hash }]);
    expect(s.predicate.axiom).toEqual({ paths: [".env", "src/b.ts"], profile: "builtin" });
    expect(s.predicate.args_state).toBe("recorded");
    expect("evaluation_results" in s.predicate).toBe(false);
  });

  it("omits policy_ids without a code, reason defaults to empty; deterministic", () => {
    const { code: _c, reason: _r, ...allow } = input;
    const s = buildAgentDecisionStatement({ ...allow, decision: "allow" });
    expect(s.predicate.policy_evaluations[0]).toEqual({
      policy: "axiom.gate",
      decision: "allow",
      reason: "",
    });
    expect(canonicalHash(buildAgentDecisionStatement(input))).toBe(
      canonicalHash(buildAgentDecisionStatement({ ...input, paths: [...input.paths].reverse() })),
    );
  });
});
