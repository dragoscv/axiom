import { canonicalHash, type Sha256Digest } from "./digest.js";

/** in-toto Statement v1 `_type`. */
export const IN_TOTO_STATEMENT_V1: "https://in-toto.io/Statement/v1" =
  "https://in-toto.io/Statement/v1";
/** SLSA Provenance v1 `predicateType`. */
export const SLSA_PROVENANCE_V1: "https://slsa.dev/provenance/v1" =
  "https://slsa.dev/provenance/v1";
/**
 * Base of every AXIOM spec URI (3.0, D-41): the project's own docs site. 2.x used `axiom.dev`,
 * a domain the project does not control.
 */
export const AXIOM_SPEC_BASE: "https://dragoscv.github.io/axiom/spec" =
  "https://dragoscv.github.io/axiom/spec";
/** AXIOM `buildDefinition.buildType`. */
export const AXIOM_BUILD_TYPE: "https://dragoscv.github.io/axiom/spec/build/plan@v2" =
  "https://dragoscv.github.io/axiom/spec/build/plan@v2";
/** AXIOM `runDetails.builder.id`. */
export const AXIOM_BUILDER_ID: "https://dragoscv.github.io/axiom/spec/builder/mcp@v2" =
  "https://dragoscv.github.io/axiom/spec/builder/mcp@v2";
/** AXIOM apply attestation `predicateType` (D-21, S-403; moved in 3.0, D-41). */
export const AXIOM_APPLY_ATTESTATION_V1: "https://dragoscv.github.io/axiom/spec/attestation/apply/v1" =
  "https://dragoscv.github.io/axiom/spec/attestation/apply/v1";
/** The 2.x apply `predicateType` — for verifiers that still accept attestations made by 2.x. */
export const AXIOM_APPLY_ATTESTATION_V1_LEGACY: "https://axiom.dev/attestation/apply/v1" =
  "https://axiom.dev/attestation/apply/v1";
/**
 * Agent decision attestation `predicateType` (Phase 8, D-36; moved to the docs site in 3.0,
 * D-41). in-toto/attestation#554 intends an `in-toto.io` alias once accepted; this is the
 * SINGLE place to change it — every builder and verifier reads this constant.
 */
export const AGENT_DECISION_V0_1: "https://dragoscv.github.io/axiom/spec/attestation/agent-decision/v0.1" =
  "https://dragoscv.github.io/axiom/spec/attestation/agent-decision/v0.1";
/** The 2.x agent-decision `predicateType`. */
export const AGENT_DECISION_V0_1_LEGACY: "https://auxidus.dev/attestation/agent-decision/v0.1" =
  "https://auxidus.dev/attestation/agent-decision/v0.1";

export interface ResourceDescriptor {
  name: string;
  digest: Sha256Digest;
}

export interface ResolvedDependency {
  uri: string;
  digest: Sha256Digest;
}

export interface BuildMetadata {
  invocationId?: string;
  startedOn?: string;
  finishedOn?: string;
}

/** SLSA Provenance v1 predicate as emitted by AXIOM. */
export interface SlsaProvenanceV1Predicate {
  buildDefinition: {
    buildType: typeof AXIOM_BUILD_TYPE;
    externalParameters: { plan: Sha256Digest; profile: string };
    internalParameters: { toolchain: Record<string, string> };
    resolvedDependencies: ResolvedDependency[];
  };
  runDetails: {
    builder: { id: typeof AXIOM_BUILDER_ID; version: Record<string, string> };
    metadata?: BuildMetadata;
    byproducts: ResourceDescriptor[];
  };
}

/** in-toto Statement v1 carrying an AXIOM SLSA provenance predicate. */
export interface InTotoStatementV1 {
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: ResourceDescriptor[];
  predicateType: typeof SLSA_PROVENANCE_V1;
  predicate: SlsaProvenanceV1Predicate;
}

/**
 * AXIOM apply attestation predicate (D-21): "this tree, at these paths, is exactly what
 * manifest M says" — produced by `axiom verify --tree` after checking every artifact digest
 * (and, when the manifest carries one, the declared pre-image set). Subjects are the manifest
 * digest plus one entry per artifact path, so `gh attestation verify` can match either the
 * manifest or a single file.
 */
export interface AxiomApplyAttestationV1Predicate {
  manifest: Sha256Digest;
  plan: Sha256Digest;
  profile: string;
  /** Which state of the tree was verified. */
  tree: "post" | "pre";
  /** Paths verified: artifact path → digest or `absent` (deletes). */
  paths: Array<{ path: string; op: string; sha256: string }>;
  /** Declared pre-image set from the manifest, when present. */
  preImage?: Array<{ path: string; sha256: string }>;
  verifier: { id: typeof AXIOM_BUILDER_ID; version: string };
  /** Optional, from the CI environment; never part of anything content-addressed. */
  source?: { repository?: string; ref?: string; sha?: string; runId?: string };
}

export interface InTotoApplyAttestationV1 {
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: ResourceDescriptor[];
  predicateType: typeof AXIOM_APPLY_ATTESTATION_V1;
  predicate: AxiomApplyAttestationV1Predicate;
}

export interface BuildApplyAttestationInput {
  subjectName: string;
  manifestDigestHex: string;
  planDigestHex: string;
  profile: string;
  tree: "post" | "pre";
  paths: Array<{ path: string; op: string; sha256: string }>;
  preImage?: Array<{ path: string; sha256: string }>;
  axiomVersion: string;
  source?: AxiomApplyAttestationV1Predicate["source"];
}

/** Deterministic: subjects and paths sorted by name; no clock. */
export function buildApplyAttestation(input: BuildApplyAttestationInput): InTotoApplyAttestationV1 {
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const subject: ResourceDescriptor[] = [
    { name: input.subjectName, digest: { sha256: input.manifestDigestHex } },
    ...input.paths
      .filter((p) => p.sha256 !== "absent")
      .map((p) => ({ name: p.path, digest: { sha256: p.sha256 } })),
  ].sort(byName);
  const predicate: AxiomApplyAttestationV1Predicate = {
    manifest: { sha256: input.manifestDigestHex },
    plan: { sha256: input.planDigestHex },
    profile: input.profile,
    tree: input.tree,
    paths: [...input.paths].sort(byPath),
    verifier: { id: AXIOM_BUILDER_ID, version: input.axiomVersion },
  };
  if (input.preImage !== undefined) predicate.preImage = [...input.preImage].sort(byPath);
  if (input.source !== undefined && Object.keys(input.source).length > 0) {
    predicate.source = input.source;
  }
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject,
    predicateType: AXIOM_APPLY_ATTESTATION_V1,
    predicate,
  };
}

export interface BuildStatementInput {
  subjectName: string;
  manifestDigestHex: string;
  planDigestHex: string;
  profile: string;
  toolchain: Record<string, string>;
  byproducts?: Array<{ name: string; sha256: string }>;
  invocationId?: string;
  startedOn?: string;
  finishedOn?: string;
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r).sort()) {
    const v = r[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Build an in-toto Statement v1 for a manifest. Deterministic: with no
 * invocationId/startedOn/finishedOn the output contains no `metadata`, so two
 * builds of the same inputs canonicalize to identical bytes.
 */
export function buildStatement(input: BuildStatementInput): InTotoStatementV1 {
  const metadata: BuildMetadata = {};
  if (input.invocationId !== undefined) metadata.invocationId = input.invocationId;
  if (input.startedOn !== undefined) metadata.startedOn = input.startedOn;
  if (input.finishedOn !== undefined) metadata.finishedOn = input.finishedOn;
  const hasMetadata = Object.keys(metadata).length > 0;

  const toolchain = sortedRecord(input.toolchain);
  const byproducts: ResourceDescriptor[] = (input.byproducts ?? [])
    .map((b) => ({ name: b.name, digest: { sha256: b.sha256 } }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const runDetails: SlsaProvenanceV1Predicate["runDetails"] = {
    builder: { id: AXIOM_BUILDER_ID, version: toolchain },
    byproducts,
  };
  if (hasMetadata) runDetails.metadata = metadata;

  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: input.subjectName, digest: { sha256: input.manifestDigestHex } }],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: AXIOM_BUILD_TYPE,
        externalParameters: { plan: { sha256: input.planDigestHex }, profile: input.profile },
        internalParameters: { toolchain },
        resolvedDependencies: [],
      },
      runDetails,
    },
  };
}

// ------------------------------------------------------- agent decision --

/** `sha256:<hex>` of the JCS (RFC 8785) form of `value`. Throws when `value` is not canonicalizable. */
export function argsHash(value: unknown): `sha256:${string}` {
  return `sha256:${canonicalHash(value)}`;
}

export interface AgentDecisionPolicyEvaluation {
  policy: string;
  decision: "allow" | "deny";
  reason: string;
  policy_ids?: string[];
}

export interface AgentDecisionV0_1Predicate {
  agent_id: string;
  principal: { subject: string };
  policy_evaluations: AgentDecisionPolicyEvaluation[];
  tool_calls: Array<{ name: string; args_hash: `sha256:${string}` }>;
  decided_at: string;
  args_state: "recorded" | "unavailable";
  /** AXIOM extension: root-relative paths judged and the gate profile source. */
  axiom: { paths: string[]; profile: string };
}

export interface InTotoAgentDecisionV0_1 {
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: ResourceDescriptor[];
  predicateType: typeof AGENT_DECISION_V0_1;
  predicate: AgentDecisionV0_1Predicate;
}

export interface BuildAgentDecisionInput {
  agent_id: string;
  principal: { subject: string };
  tool: string;
  args_hash: `sha256:${string}`;
  args_state: "recorded" | "unavailable";
  decision: "allow" | "deny";
  code?: string;
  reason?: string;
  paths: string[];
  profile: string;
  /** ISO timestamp, supplied by the caller (the builder reads no clock). */
  decided_at: string;
}

/**
 * in-toto Statement v1 for one agent tool-call decision. The subject is content-addressed by
 * the invocation: `{name: tool, digest: {sha256: <args hash hex>}}`. Deterministic.
 */
export function buildAgentDecisionStatement(
  input: BuildAgentDecisionInput,
): InTotoAgentDecisionV0_1 {
  const hex = input.args_hash.slice("sha256:".length);
  const evaluation: AgentDecisionPolicyEvaluation = {
    policy: "axiom.gate",
    decision: input.decision,
    reason: input.reason ?? "",
  };
  if (input.code !== undefined) evaluation.policy_ids = [input.code];
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: input.tool, digest: { sha256: hex } }],
    predicateType: AGENT_DECISION_V0_1,
    predicate: {
      agent_id: input.agent_id,
      principal: { subject: input.principal.subject },
      policy_evaluations: [evaluation],
      tool_calls: [{ name: input.tool, args_hash: input.args_hash }],
      decided_at: input.decided_at,
      args_state: input.args_state,
      axiom: { paths: [...input.paths].sort(), profile: input.profile },
    },
  };
}
