
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAxiomSource } from "@axiom/core/dist/parser.js";
import { validateIR } from "@axiom/core/dist/validator.js";
import { generate } from "@axiom/engine/dist/generate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const axmPath = path.join(repoRoot, "examples/blog.axm");
const source = fs.readFileSync(axmPath, "utf-8");

const parsed = parseAxiomSource(source);
if (parsed.diagnostics.length) {
  console.error("Parse diagnostics:", parsed.diagnostics);
  process.exit(1);
}
if (!parsed.ir) {
  console.error("No IR produced");
  process.exit(1);
}

const val = validateIR(parsed.ir);
if (!val.ok) {
  console.error("Validation diagnostics:", val.diagnostics);
  process.exit(1);
}

const outRoot = path.join(repoRoot, "tmp_artifacts");
if (!fs.existsSync(outRoot)) fs.mkdirSync(outRoot, { recursive: true });
process.chdir(outRoot);

const { manifest, artifacts } = await generate(parsed.ir, process.cwd(), "default");
console.log("Artifacts:", artifacts.length, "Manifest:", manifest.buildId);
console.log("OK");
