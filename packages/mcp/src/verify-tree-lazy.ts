/**
 * Lazy chunk for `axiom verify --tree` (S-403): tree comparison + in-toto apply attestation.
 * Loaded on demand from `cli-main` so the eager CLI bundle does not pay for it.
 */
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { verifyTree } from "@codai/axiom-apply";
import { buildApplyAttestation, canonicalize } from "@codai/axiom-canon";
import type { ManifestBundle } from "@codai/axiom-schema";

export interface VerifyTreeCliResult {
  ok: boolean;
  result: Record<string, unknown>;
}

/** Everything `cmdVerifyTree` needs after structural verification passed. */
export async function verifyTreeCli(
  bundle: ManifestBundle,
  treeRoot: string,
  pre: boolean,
  attestOut: string | undefined,
  canonical: unknown,
  env: NodeJS.ProcessEnv,
): Promise<VerifyTreeCliResult> {
  const r = await verifyTree(treeRoot, bundle, { pre });
  const result: Record<string, unknown> = {
    ok: r.ok,
    manifestDigest: r.manifestDigest,
    canonical,
    root: r.root,
    tree: r.tree,
    paths: r.paths.length,
    mismatches: r.mismatches,
  };
  if (r.preImageMissing === true) {
    result.note =
      "manifest carries no preImage (compiled without a root); --pre cannot be verified";
  }
  if (r.ok && attestOut !== undefined) {
    const source: Record<string, string> = {};
    if (env.GITHUB_REPOSITORY) source.repository = env.GITHUB_REPOSITORY;
    if (env.GITHUB_REF) source.ref = env.GITHUB_REF;
    if (env.GITHUB_SHA) source.sha = env.GITHUB_SHA;
    if (env.GITHUB_RUN_ID) source.runId = env.GITHUB_RUN_ID;
    const statement = buildApplyAttestation({
      subjectName: bundle.manifest.name,
      manifestDigestHex: bundle.manifestDigest.slice("sha256:".length),
      planDigestHex: bundle.manifest.planDigest.slice("sha256:".length),
      profile: bundle.manifest.profile,
      tree: r.tree,
      paths: r.paths,
      ...(bundle.manifest.preImage === undefined ? {} : { preImage: bundle.manifest.preImage }),
      axiomVersion: bundle.manifest.toolchain.axiom,
      ...(Object.keys(source).length === 0 ? {} : { source }),
    });
    // JCS so the attestation bytes are deterministic for the same inputs (A2A/in-toto practice).
    // Two files: the full in-toto Statement for standalone use, and the bare predicate for
    // `actions/attest` (which builds the Statement itself from `predicate-path` + subject).
    const statementFile = path.resolve(attestOut);
    const predicateFile = `${statementFile.replace(/(\.intoto)?\.json$/i, "")}.predicate.json`;
    await writeFile(statementFile, `${canonicalize(statement)}\n`, "utf8");
    await writeFile(predicateFile, `${canonicalize(statement.predicate)}\n`, "utf8");
    result.attestation = {
      file: statementFile,
      predicateFile,
      predicateType: statement.predicateType,
      subjects: statement.subject.length,
    };
  }
  return { ok: r.ok, result };
}
