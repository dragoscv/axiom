import { parseAxiomSource } from "@codai/axiom-core";
import { generate } from "@codai/axiom-engine";
import fs from "node:fs";
import path from "node:path";

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
const ir = parseResult.ir;
const tmpDir = "./test-debug-output";

// Cleanup
if (fs.existsSync(tmpDir)) {
  fs.rmSync(tmpDir, { recursive: true });
}

const result = await generate(ir, tmpDir, "edge");

console.log("\n=== MANIFEST ARTIFACTS (first 5) ===");
result.manifest.artifacts.slice(0, 5).forEach((a, i) => {
  console.log(`${i+1}. "${a.path}" [has \\: ${a.path.includes('\\')}]`);
});

console.log("\n=== DEBUG LOG ===");
const logPath = path.join(tmpDir, "debug-writer.log");
if (fs.existsSync(logPath)) {
  const lines = fs.readFileSync(logPath, "utf-8").split('\n');
  lines.slice(0, 20).forEach(line => console.log(line));
} else {
  console.log("No debug log found!");
}

// Keep tmpDir for inspection
console.log(`\nOutput directory: ${tmpDir}`);
