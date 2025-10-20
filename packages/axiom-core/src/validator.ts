
import { TAxiomIR } from "./ir.js";

export interface Diagnostic { message: string; path?: string[] }

export function validateIR(ir: TAxiomIR): { ok: boolean; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  for (const agent of ir.agents) {
    const caps = new Set(agent.capabilities.map(c => c.kind));
    for (const chk of agent.checks) {
      // Test negativ 1: http.* fără net()
      if (/http\./.test(chk.expect) && !caps.has("net")) {
        diags.push({
          message: `Check "${chk.name}" uses http.* but capability net(...) is missing`,
          path: ["agents", agent.name, "checks", chk.name]
        });
      }
      // Test negativ 2: scan.artifacts.* fără fs()
      if (/scan\.artifacts\./.test(chk.expect) && !caps.has("fs")) {
        diags.push({
          message: `Check "${chk.name}" scans artifacts but capability fs(...) is missing`,
          path: ["agents", agent.name, "checks", chk.name]
        });
      }
      // Test negativ 3: ai.* fără ai()
      if (/ai\./.test(chk.expect) && !caps.has("ai")) {
        diags.push({
          message: `Check "${chk.name}" uses ai.* but capability ai(...) is missing`,
          path: ["agents", agent.name, "checks", chk.name]
        });
      }
    }
  }
  return { ok: diags.length === 0, diagnostics: diags };
}
