import type { Sha256Digest } from "./digest.js";

/** in-toto Statement v1 `_type`. */
export const IN_TOTO_STATEMENT_V1: "https://in-toto.io/Statement/v1" =
  "https://in-toto.io/Statement/v1";
/** SLSA Provenance v1 `predicateType`. */
export const SLSA_PROVENANCE_V1: "https://slsa.dev/provenance/v1" =
  "https://slsa.dev/provenance/v1";
/** AXIOM `buildDefinition.buildType`. */
export const AXIOM_BUILD_TYPE: "https://axiom.dev/build/plan@v2" =
  "https://axiom.dev/build/plan@v2";
/** AXIOM `runDetails.builder.id`. */
export const AXIOM_BUILDER_ID: "https://axiom.dev/builder/mcp@v2" =
  "https://axiom.dev/builder/mcp@v2";
/** AXIOM apply attestation `predicateType` (D-21, S-403). */
export const AXIOM_APPLY_ATTESTATION_V1: "https://axiom.dev/attestation/apply/v1" =
  "https://axiom.dev/attestation/apply/v1";

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
