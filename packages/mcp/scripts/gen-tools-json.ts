/**
 * Emits spec/tools.json (MCP registry of record) and spec/codai-tools.json
 * (codai agent-core `tools-v2.json` entry shape) from TOOL_DEFS.
 * Run: pnpm --filter @codai/axiom-mcp build:spec
 * Both files are committed; `tools-spec.test.ts` fails when either drifts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCodaiToolsSpec, renderToolsSpec } from "../src/spec.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "spec");
mkdirSync(outDir, { recursive: true });
for (const [name, render] of [
  ["tools.json", renderToolsSpec],
  ["codai-tools.json", renderCodaiToolsSpec],
] as const) {
  const file = join(outDir, name);
  writeFileSync(file, render(), { encoding: "utf8" });
  console.error(`wrote ${file}`);
}
