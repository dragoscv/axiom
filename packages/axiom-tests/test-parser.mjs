import { parseAxiomSource } from "@codai/axiom-core";

const parseResult = parseAxiomSource(`
agent "webapp" {
  intent "Test webapp"
  capability net("api")
  emit {
    service type="web-app" target="my-webapp"
  }
}
`);

if (!parseResult.ir) {
  console.error("Parse failed:", parseResult.diagnostics);
  process.exit(1);
}

console.log("IR:");
console.log(JSON.stringify(parseResult.ir, null, 2));

console.log("\nEmit target:", parseResult.ir.agents[0].emit[0].target);
console.log("Contains backslash?", parseResult.ir.agents[0].emit[0].target.includes('\\'));
