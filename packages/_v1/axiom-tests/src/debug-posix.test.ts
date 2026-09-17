import { describe, it } from "vitest";
import { parseAxiomSource } from "@codai/axiom-core";
import { generate } from "@codai/axiom-engine";
import fs from "node:fs";

describe("Debug POSIX paths", () => {
  it("should show artifact paths in memory vs JSON", async () => {
    const { ir } = parseAxiomSource('agent "test" { intent "x" capability net("api") emit service "my-app" }');
    if (!ir) throw new Error("Parse failed");
    const result = await generate(ir, "./test-posix-debug", "edge");
    
    console.log("\n=== IN-MEMORY ARTIFACT PATHS ===");
    result.manifest.artifacts.slice(0, 5).forEach((a, i) => {
      console.log(`${i+1}. "${a.path}" [backslash: ${a.path.includes('\\')}]`);
    });
    
    console.log("\n=== FROM JSON FILE ===");
    const manifestJson = JSON.parse(fs.readFileSync("./test-posix-debug/manifest.json", "utf-8"));
    manifestJson.artifacts.slice(0, 5).forEach((a, i) => {
      console.log(`${i+1}. "${a.path}" [backslash: ${a.path.includes('\\')}]`);
    });
    
    // Cleanup
    fs.rmSync("./test-posix-debug", { recursive: true, force: true });
  });
});
