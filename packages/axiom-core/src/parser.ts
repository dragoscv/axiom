
import { AxiomIR, type TAxiomIR, type TAgentIR } from "./ir.js";

function between(src: string, start: string, end: string): string[] {
  const results: string[] = [];
  let i = 0;
  while (i < src.length) {
    const s = src.indexOf(start, i);
    if (s < 0) break;
    const e = src.indexOf(end, s + start.length);
    if (e < 0) break;
    results.push(src.slice(s + start.length, e));
    i = e + end.length;
  }
  return results;
}

export function parseAxiomSource(source: string): { ir?: TAxiomIR, diagnostics: string[] } {
  const diags: string[] = [];
  const agentNameMatch = source.match(/agent\s+"([^"]+)"/);
  if (!agentNameMatch) {
    diags.push("Missing agent name: use agent \"name\" { ... }");
    return { diagnostics: diags };
  }
  const name = agentNameMatch[1];

  const intentMatch = source.match(/intent\s+"([^"]+)"/);
  const intent = intentMatch ? intentMatch[1] : "";

  // constraints
  const constraintsBlock = between(source, "constraints {", "}")[0] ?? "";
  const constraints = constraintsBlock.split(/\n|;|,/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^([a-zA-Z0-9_\.\-]+)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
    if (!m) return null;
    let rhs: any = m[3].trim();
    if (rhs === "true") rhs = true;
    else if (rhs === "false") rhs = false;
    else if (!isNaN(Number(rhs))) rhs = Number(rhs);
    else rhs = rhs.replace(/^"|"$/g, "");
    return { lhs: m[1], op: m[2] as any, rhs };
  }).filter(Boolean) as any[];

  // capabilities
  const capsBlock = between(source, "capabilities {", "}")[0] ?? "";
  const capabilities = capsBlock.split(/\n|;|,/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^([a-zA-Z_]+)\(([^)]*)\)\??$/);
    if (!m) return null;
    const kind = m[1];
    const argsRaw = m[2].trim();
    const args = argsRaw ? argsRaw.split(/\s*,\s*/).map(s => s.replace(/^"|"$/g, "")) : [];
    const optional = line.endsWith("?");
    return { kind, args, optional };
  }).filter(Boolean) as any[];

  // checks
  const checksBlock = between(source, "checks {", "}")[0] ?? "";
  const checks = checksBlock.split(/\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(unit|policy|sla)\s+"([^"]+)"\s+expect\s+(.+)$/);
    if (!m) return null;
    return { kind: m[1], name: m[2], expect: m[3] };
  }).filter(Boolean) as any[];

  // emit
  const emitBlock = between(source, "emit {", "}")[0] ?? "";
  const emit = emitBlock.split(/\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(service|tests|report|manifest)\s+(.*)$/);
    if (!m) return null;
    const type = m[1];
    const rest = m[2];
    // Support both "subtype=" and "type=" for specifying subtype (but type= only AFTER the keyword)
    let subtype: string | undefined;
    const subtypeM = rest.match(/subtype\s*=\s*"([^"]+)"/);
    const typeM = rest.match(/type\s*=\s*"([^"]+)"/);
    subtype = subtypeM ? subtypeM[1] : (typeM ? typeM[1] : undefined);
    const targetM = rest.match(/target\s*=\s*"([^"]+)"/);
    const target = targetM ? targetM[1] : undefined;
    if (!target) return null;
    return { type, subtype, target };
  }).filter(Boolean) as any[];

  const agent: TAgentIR = {
    name, intent, constraints, capabilities, checks, emit
  };

  const ir: TAxiomIR = {
    version: "1.0.0",
    agents: [agent]
  };
  const parsed = AxiomIR.safeParse(ir);
  if (!parsed.success) {
    diags.push(...parsed.error.issues.map(i => i.message));
    return { diagnostics: diags };
  }
  return { ir, diagnostics: [] };
}
