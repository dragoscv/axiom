import { parseAxiomSource } from "@codai/axiom-core";
import { generate } from "@codai/axiom-engine";
import { readFileSync } from "node:fs";

// VERIFICARE: Ce modul se încarcă?
const generateModule = await import("@codai/axiom-engine/dist/generate.js");
console.log('[DEBUG] Module URL:', import.meta.url);
console.log('[DEBUG] Generate function:', typeof generateModule.generate);

const source = readFileSync("../../axiom/notes-v2.axm", "utf-8");
const ir = parseAxiomSource(source);
const result = await generate(ir, "./test-debug-output", "default");

console.log("\n=== MANIFEST ARTIFACTS (first 5) ===");
result.manifest.artifacts.slice(0, 5).forEach((a, i) => {
  console.log(`${i + 1}. "${a.path}" [has \\: ${a.path.includes('\\')}]`);
});

console.log("\nOutput directory: ./test-debug-output");
