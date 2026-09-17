/**
 * Regenerate `golden/*.expected.json` from `golden/*.plan.json`.
 * Run: `pnpm --filter @codai/axiom-testkit update-golden`
 * Only commit the result when a manifest-format change is intentional.
 */
import { writeFile } from "node:fs/promises";
import { compileGolden, listGoldenCases } from "../src/golden.js";

const cases = await listGoldenCases();
for (const c of cases) {
  const expected = await compileGolden(c.planPath);
  await writeFile(c.expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
  // Root biome.json only allows console.error/warn outside root scripts/**.
  console.error(`${c.name}: ${expected.manifestDigest}`);
}
