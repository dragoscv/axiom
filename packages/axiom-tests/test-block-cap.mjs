import { parseAxiomSource } from "@codai/axiom-core";

const source = `
agent "block-agent" {
  intent "Test block parsing"
  
  capabilities {
    net("http","https")
    fs("./data")?
    ai("gpt-4")
  }
}
`.trim();

const { ir, diagnostics } = parseAxiomSource(source);
console.log("Diagnostics:", diagnostics);
console.log("Capabilities count:", ir?.agents[0].capabilities.length);
console.log("Capabilities:", JSON.stringify(ir?.agents[0].capabilities, null, 2));
