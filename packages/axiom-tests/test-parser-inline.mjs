import { parseAxiomSource } from "@codai/axiom-core";

const source = `
agent "roundtrip-agent" {
  intent "Golden IR comparison"
  capability net("api")
  check sla "latency" { expect "cold_start_ms <= 50" }
  emit service "app"
}
`.trim();

const { ir } = parseAxiomSource(source);

console.log(JSON.stringify(ir.agents[0], null, 2));
console.log("\n✓ Capabilities:", ir.agents[0].capabilities.length);
console.log("✓ Checks:", ir.agents[0].checks.length);
console.log("✓ Emit:", ir.agents[0].emit.length);
