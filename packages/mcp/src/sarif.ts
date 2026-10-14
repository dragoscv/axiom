/**
 * S-1214 — `CheckReport` → SARIF 2.1.0 for GitHub code scanning (`axiom check --format sarif`).
 *
 * One run per report; one rule per distinct finding id; `partialFingerprints["axiom/v1"]` =
 * sha256(id|path|message) so code scanning dedupes the same finding across runs. No JSON-schema
 * dependency: the shape is the minimal subset GitHub's `upload-sarif` accepts.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { CheckReport, Finding, Severity } from "@codai/axiom-schema";

export const SARIF_SCHEMA_URI = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_DEFAULT_INFORMATION_URI = "https://github.com/dragoscv/axiom";

export type SarifLevel = "error" | "warning" | "note";

export interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: { physicalLocation: { artifactLocation: SarifArtifactLocation } }[];
  partialFingerprints: { "axiom/v1": string };
  properties: { predicate: string };
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { predicate: string };
}

export interface SarifRun {
  tool: {
    driver: { name: "axiom"; version: string; informationUri: string; rules: SarifRule[] };
  };
  originalUriBaseIds?: Record<string, { uri: string }>;
  invocations: { executionSuccessful: boolean }[];
  results: SarifResult[];
  properties: { manifestDigest: string; verdict: CheckReport["verdict"]; profile: string };
}

export interface SarifLog {
  $schema: typeof SARIF_SCHEMA_URI;
  version: "2.1.0";
  runs: [SarifRun];
}

const LEVEL: Record<Severity, SarifLevel> = { error: "error", warn: "warning", info: "note" };

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

function fingerprint(f: Finding): string {
  return createHash("sha256")
    .update(`${f.id}|${f.path ?? ""}|${f.message}`)
    .digest("hex");
}

/** Bundle path → artifact location: relative to the root when inside it, else a file URI. */
function bundleLocation(bundlePath: string, root: string | undefined): SarifArtifactLocation {
  if (!path.isAbsolute(bundlePath)) {
    return { uri: toPosix(bundlePath).replace(/^\.\//, ""), uriBaseId: "%SRCROOT%" };
  }
  if (root !== undefined) {
    const rel = path.relative(root, bundlePath);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return { uri: toPosix(rel), uriBaseId: "%SRCROOT%" };
    }
  }
  return { uri: pathToFileURL(bundlePath).href };
}

export function reportToSarif(
  report: CheckReport,
  o: { toolVersion: string; root?: string; bundlePath?: string; informationUri?: string },
): SarifLog {
  const bundleLoc = o.bundlePath === undefined ? undefined : bundleLocation(o.bundlePath, o.root);
  const rules = new Map<string, SarifRule>();
  const results: SarifResult[] = [];
  for (const f of report.findings) {
    const level = LEVEL[f.severity];
    if (!rules.has(f.id)) {
      rules.set(f.id, {
        id: f.id,
        name: f.id,
        shortDescription: { text: `AXIOM check ${f.id} (${f.predicate})` },
        defaultConfiguration: { level },
        properties: { predicate: f.predicate },
      });
    }
    const loc: SarifArtifactLocation | undefined =
      f.path !== undefined ? { uri: toPosix(f.path), uriBaseId: "%SRCROOT%" } : bundleLoc;
    results.push({
      ruleId: f.id,
      level,
      message: { text: f.message },
      ...(loc === undefined
        ? {}
        : { locations: [{ physicalLocation: { artifactLocation: loc } }] }),
      partialFingerprints: { "axiom/v1": fingerprint(f) },
      properties: { predicate: f.predicate },
    });
  }
  const run: SarifRun = {
    tool: {
      driver: {
        name: "axiom",
        version: o.toolVersion,
        informationUri: o.informationUri ?? SARIF_DEFAULT_INFORMATION_URI,
        rules: [...rules.values()],
      },
    },
    ...(o.root === undefined
      ? {}
      : {
          originalUriBaseIds: {
            "%SRCROOT%": {
              uri: pathToFileURL(o.root.endsWith(path.sep) ? o.root : o.root + path.sep).href,
            },
          },
        }),
    invocations: [{ executionSuccessful: report.verdict !== "error" }],
    results,
    properties: {
      manifestDigest: report.manifestDigest,
      verdict: report.verdict,
      profile: report.profile,
    },
  };
  return { $schema: SARIF_SCHEMA_URI, version: "2.1.0", runs: [run] };
}
