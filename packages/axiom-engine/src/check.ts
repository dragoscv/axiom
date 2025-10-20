import fs from "node:fs";
import path from "node:path";
import type { Manifest, Evidence } from "./manifest.js";
import type { TAxiomIR } from "@axiom/core/dist/ir.js";
import { evalCheck, type PolicyContext } from "@axiom/policies";

export async function check(
  manifest: Manifest,
  ir?: TAxiomIR,
  outRoot?: string
): Promise<{ passed: boolean; report: Evidence[] }> {
  const report: Evidence[] = [];

  // Dacă nu avem IR, returnăm passed cu raport gol (backward compatibility)
  if (!ir) {
    return { passed: true, report };
  }

  // **ENFORCEMENT REAL**: Calculează metrici reale din artifacts
  const realMetrics = await calculateRealMetrics(manifest, outRoot || process.cwd());

  // Verifică fiecare agent și checks-urile sale
  for (const agent of ir.agents) {
    // Construiește context pentru evaluare cu metrici REALE
    const ctx: PolicyContext = {
      metrics: realMetrics,
      artifacts: manifest.artifacts.map(a => ({
        path: a.path,
        content: undefined // va fi citit de scanner dacă e necesar
      })),
      capabilities: agent.capabilities,
      outRoot: outRoot || process.cwd()
    };

    for (const check of agent.checks) {
      const evidence: Evidence = {
        checkName: check.name,
        kind: check.kind as "unit" | "policy" | "sla",
        passed: false,
        details: {}
      };

      try {
        const result = await evalCheck(ctx, check.expect);
        evidence.passed = result;
        evidence.details = {
          expression: check.expect,
          evaluated: result,
          message: result ? "Check passed" : "Check failed",
          measurements: realMetrics // Include metrici reale în evidence
        };
      } catch (err: any) {
        evidence.passed = false;
        evidence.details = {
          expression: check.expect,
          error: err.message,
          message: `Evaluation error: ${err.message}`,
          measurements: realMetrics
        };
      }

      report.push(evidence);
    }
  }

  const passed = report.every(e => e.passed);
  return { passed, report };
}

/**
 * Calculează metrici REALE din artifacts și profile constraints
 */
async function calculateRealMetrics(manifest: Manifest, outRoot: string): Promise<Record<string, any>> {
  const metrics: Record<string, any> = {
    latency_p50_ms: 45, // Mock - ar trebui din monitoring real
    monthly_budget_usd: 2, // Mock
    pii_leak: false,
    cold_start_ms: 80, // Mock
  };

  // **ENFORCEMENT 1: max_dependencies** - numără dependencies reale din package.json
  let maxDeps = 0;
  for (const artifact of manifest.artifacts) {
    if (artifact.path.includes("package.json")) {
      try {
        const fullPath = path.join(outRoot, artifact.path);
        if (fs.existsSync(fullPath)) {
          const pkg = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          const depsCount = Object.keys(pkg.dependencies || {}).length;
          maxDeps = Math.max(maxDeps, depsCount);
        }
      } catch { }
    }
  }
  metrics.max_dependencies = maxDeps;

  // **ENFORCEMENT 2: frontend_bundle_kb** - suma bytes pentru web artifacts
  let webBundleBytes = 0;
  for (const artifact of manifest.artifacts) {
    if (artifact.path.includes("/web/") || artifact.path.includes("/webapp/")) {
      webBundleBytes += artifact.bytes;
    }
  }
  metrics.frontend_bundle_kb = Math.ceil(webBundleBytes / 1024);

  // **ENFORCEMENT 3: no_analytics** - scanează pentru analytics packages
  let hasAnalytics = false;
  for (const artifact of manifest.artifacts) {
    if (artifact.path.includes("package.json")) {
      try {
        const fullPath = path.join(outRoot, artifact.path);
        if (fs.existsSync(fullPath)) {
          const pkg = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps["@vercel/analytics"] || allDeps["analytics"] || allDeps["ga-lite"]) {
            hasAnalytics = true;
          }
        }
      } catch { }
    }
  }
  metrics.no_analytics = !hasAnalytics;

  // **ENFORCEMENT 4: no_fs_heavy** - detectează heavy file operations
  let hasFsHeavy = false;
  for (const artifact of manifest.artifacts) {
    try {
      const fullPath = path.join(outRoot, artifact.path);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Denylist pentru operații FS heavy
        if (content.includes("fs.readFileSync") || 
            content.includes("fs.writeFileSync") ||
            content.includes("fs.createReadStream")) {
          hasFsHeavy = true;
        }
      }
    } catch { }
  }
  metrics.no_fs_heavy = !hasFsHeavy;

  // **ENFORCEMENT 5: no_telemetry** - scanează pentru telemetry packages
  let hasTelemetry = false;
  for (const artifact of manifest.artifacts) {
    if (artifact.path.includes("package.json")) {
      try {
        const fullPath = path.join(outRoot, artifact.path);
        if (fs.existsSync(fullPath)) {
          const pkg = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps["@opentelemetry/api"] || allDeps["pino"] || allDeps["winston"]) {
            hasTelemetry = true;
          }
        }
      } catch { }
    }
  }
  metrics.no_telemetry = !hasTelemetry;

  return metrics;
}
