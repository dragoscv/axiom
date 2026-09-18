/**
 * Regenerate src/__golden__/<template>.txt from GOLDEN_PARAMS.
 * Run: pnpm --filter @codai/axiom-emitters-web exec tsx scripts/update-golden.ts
 * Review the diff by eye — the goldens ARE the spec of what each template emits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_PARAMS } from "../src/fixtures.js";
import { webEmitter } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "src", "__golden__");
mkdirSync(dir, { recursive: true });
for (const [name, params] of Object.entries(GOLDEN_PARAMS)) {
  const def = webEmitter.templates[name];
  if (def === undefined) throw new Error(`no template ${name}`);
  const parsed = def.params.parse(params);
  writeFileSync(join(dir, `${name}.txt`), def.render(parsed), { encoding: "utf8" });
  console.error(`wrote ${name}.txt`);
}
