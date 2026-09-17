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
