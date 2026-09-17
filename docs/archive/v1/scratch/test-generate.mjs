import { parse } from "@codai/axiom-core/dist/index.js";
import { generate } from "@codai/axiom-engine/dist/index.js";
import fs from "node:fs";

const ir = parse('agent test { capability net("api") emit service "my-app" }');
const result = await generate(ir, "./test-manifest-output", "edge");

console.log("First 5 artifacts from returned manifest object:");
result.manifest.artifacts.slice(0, 5).forEach((a, i) => {
  console.log(`  ${i+1}. "${a.path}"`);
});

console.log("\nFirst 5 artifacts from manifest.json file:");
const manifestJson = JSON.parse(fs.readFileSync("./test-manifest-output/manifest.json", "utf-8"));
manifestJson.artifacts.slice(0, 5).forEach((a, i) => {
  console.log(`  ${i+1}. "${a.path}"`);
});
