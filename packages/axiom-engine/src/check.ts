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
  
  // Verifică fiecare agent și checks-urile sale
  for (const agent of ir.agents) {
    // Construiește context pentru evaluare
    const ctx: PolicyContext = {
      metrics: {
        // Metrici default (ar putea fi populate din monitoring real)
        latency_p50_ms: 45, // mock value
        monthly_budget_usd: 2, // mock value
        pii_leak: false,
        cold_start_ms: 80, // mock value
        frontend_bundle_kb: 150 // mock value
      },
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
          message: result ? "Check passed" : "Check failed"
        };
      } catch (err: any) {
        evidence.passed = false;
        evidence.details = {
          expression: check.expect,
          error: err.message,
          message: `Evaluation error: ${err.message}`
        };
      }
      
      report.push(evidence);
    }
  }
  
  const passed = report.every(e => e.passed);
  return { passed, report };
}
