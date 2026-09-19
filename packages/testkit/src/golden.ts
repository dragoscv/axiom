import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlan } from "@codai/axiom-plan";

/** `packages/testkit/golden` resolved from either `src/` or `dist/`. */
export const GOLDEN_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "..", "golden");

export interface GoldenExpected {
  manifestDigest: string;
  planDigest: string;
  artifacts: Array<{ path: string; sha256: string | null }>;
}

export interface GoldenCase {
  name: string;
  planPath: string;
  expectedPath: string;
}

export async function listGoldenCases(dir: string = GOLDEN_DIR): Promise<GoldenCase[]> {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith(".plan.json"))
    .sort()
    .map((f) => {
      const name = basename(f, ".plan.json");
      return { name, planPath: join(dir, f), expectedPath: join(dir, `${name}.expected.json`) };
    });
}

/**
 * Compile a golden plan with a fixed toolchain; no clock, so the output is fully deterministic.
 * `patch` sources read their pre-image from `<name>.preimage/<relPath>` next to the plan
 * (absent file → `absent`), so a fixture stays self-contained and never touches a real root.
 */
export async function compileGolden(planPath: string): Promise<GoldenExpected> {
  const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
  const preimageDir = planPath.replace(/\.plan\.json$/, ".preimage");
  const hasPreimage = await stat(preimageDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const opts: Parameters<typeof compilePlan>[1] = { toolchain: { axiom: "2.0.0" } };
  if (hasPreimage) {
    // Only fixtures that ship a tree get a pre-image reader, so root-less fixtures
    // (plan-basic) keep their digest and pre-image binding is pinned separately.
    opts.readPreImage = async (rel) => {
      try {
        return new Uint8Array(await readFile(join(preimageDir, ...rel.split("/"))));
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return undefined;
        throw err;
      }
    };
  }
  const { bundle } = await compilePlan(plan, opts);
  return {
    manifestDigest: bundle.manifestDigest,
    planDigest: bundle.manifest.planDigest,
    artifacts: bundle.manifest.artifacts.map((a) => ({
      path: a.path,
      sha256: a.digest?.sha256 ?? null,
    })),
  };
}
