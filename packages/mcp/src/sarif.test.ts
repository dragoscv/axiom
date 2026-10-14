import { createHash } from "node:crypto";
import * as path from "node:path";
import type { CheckReport, Finding } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { reportToSarif, SARIF_SCHEMA_URI, type SarifLog } from "./sarif.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

function report(findings: Finding[], verdict: CheckReport["verdict"] = "fail"): CheckReport {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "CheckReport",
    manifestDigest: DIGEST,
    profile: "default",
    verdict,
    findings,
    factsDigest: `sha256:${"b".repeat(64)}`,
    durationMs: 3,
    providers: [],
  };
}

function finding(id: string, severity: Finding["severity"], message: string, p?: string): Finding {
  return {
    id,
    severity,
    predicate: "path.deny",
    message,
    ...(p === undefined ? {} : { path: p }),
    facts: {},
  };
}

/** Hand-written subset of the SARIF 2.1.0 schema that GitHub's upload-sarif requires. */
function assertSarifShape(log: SarifLog): void {
  expect(log.$schema).toBe(SARIF_SCHEMA_URI);
  expect(log.version).toBe("2.1.0");
  expect(log.runs).toHaveLength(1);
  const run = log.runs[0];
  expect(run.tool.driver.name).toBe("axiom");
  expect(typeof run.tool.driver.version).toBe("string");
  for (const r of run.results) {
    expect(typeof r.ruleId).toBe("string");
    expect(["error", "warning", "note"]).toContain(r.level);
    expect(typeof r.message.text).toBe("string");
    expect(run.tool.driver.rules.some((rule) => rule.id === r.ruleId)).toBe(true);
  }
  // Round-trips through JSON unchanged (no undefined / functions / bigint).
  expect(JSON.parse(JSON.stringify(log))).toEqual(log);
}

describe("reportToSarif (S-1214)", () => {
  it("maps severities to SARIF levels and dedupes rules by finding id", () => {
    const log = reportToSarif(
      report([
        finding("deny-env", "error", "denied .env", ".env"),
        finding("deny-env", "error", "denied .env.local", ".env.local"),
        finding("big", "warn", "too big", "src/a.ts"),
        finding("note", "info", "fyi", "src/b.ts"),
      ]),
      { toolVersion: "2.6.0" },
    );
    assertSarifShape(log);
    const run = log.runs[0];
    expect(run.results.map((r) => r.level)).toEqual(["error", "error", "warning", "note"]);
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["deny-env", "big", "note"]);
    expect(run.tool.driver.rules[1]?.defaultConfiguration.level).toBe("warning");
    expect(run.tool.driver.version).toBe("2.6.0");
    expect(run.tool.driver.informationUri).toBe("https://github.com/dragoscv/axiom");
    expect(run.results[0]?.locations?.[0]?.physicalLocation.artifactLocation).toEqual({
      uri: ".env",
      uriBaseId: "%SRCROOT%",
    });
  });

  it("fingerprints are sha256(id|path|message) and stable across calls", () => {
    const f = finding("deny-env", "error", "denied", ".env");
    const a = reportToSarif(report([f]), { toolVersion: "1" });
    const b = reportToSarif(report([f]), { toolVersion: "2" });
    const want = createHash("sha256").update("deny-env|.env|denied").digest("hex");
    expect(a.runs[0].results[0]?.partialFingerprints["axiom/v1"]).toBe(want);
    expect(b.runs[0].results[0]?.partialFingerprints["axiom/v1"]).toBe(want);
    const other = reportToSarif(report([finding("deny-env", "error", "denied", ".env2")]), {
      toolVersion: "1",
    });
    expect(other.runs[0].results[0]?.partialFingerprints["axiom/v1"]).not.toBe(want);
  });

  it("falls back to the bundle path (relative to root) when a finding has no path", () => {
    const root = path.resolve("/repo");
    const log = reportToSarif(report([finding("sig", "error", "unsigned")]), {
      toolVersion: "1",
      root,
      bundlePath: path.join(root, ".axiom", "manifests", "x.json"),
    });
    expect(log.runs[0].results[0]?.locations?.[0]?.physicalLocation.artifactLocation).toEqual({
      uri: ".axiom/manifests/x.json",
      uriBaseId: "%SRCROOT%",
    });
    expect(log.runs[0].originalUriBaseIds?.["%SRCROOT%"]?.uri.startsWith("file:")).toBe(true);
    expect(log.runs[0].originalUriBaseIds?.["%SRCROOT%"]?.uri.endsWith("/")).toBe(true);

    const rel = reportToSarif(report([finding("sig", "error", "unsigned")]), {
      toolVersion: "1",
      bundlePath: "bundles\\b.json",
    });
    expect(rel.runs[0].results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri).toBe(
      "bundles/b.json",
    );

    const none = reportToSarif(report([finding("sig", "error", "unsigned")]), {
      toolVersion: "1",
    });
    expect(none.runs[0].results[0]?.locations).toBeUndefined();
  });

  it("records verdict/profile/digest and executionSuccessful = verdict !== error", () => {
    const pass = reportToSarif(report([], "pass"), { toolVersion: "1" });
    assertSarifShape(pass);
    expect(pass.runs[0].results).toEqual([]);
    expect(pass.runs[0].invocations[0]?.executionSuccessful).toBe(true);
    expect(pass.runs[0].properties).toEqual({
      manifestDigest: DIGEST,
      verdict: "pass",
      profile: "default",
    });
    const err = reportToSarif(report([], "error"), {
      toolVersion: "1",
      informationUri: "https://example.test/axiom",
    });
    expect(err.runs[0].invocations[0]?.executionSuccessful).toBe(false);
    expect(err.runs[0].tool.driver.informationUri).toBe("https://example.test/axiom");
  });
});
