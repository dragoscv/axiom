/**
 * Emits spec/tools.json (codai agent-core shape) from TOOL_DEFS.
 * Run: pnpm --filter @codai/axiom-mcp build:spec
 * The file is committed; `tools-spec.test.ts` fails when it drifts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToolsSpec } from "../src/spec.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "spec");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, "tools.json");
writeFileSync(file, renderToolsSpec(), { encoding: "utf8" });
console.error(`wrote ${file}`);
