import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompileOptions, type CompileResult, compilePlan } from "@codai/axiom-plan";
import type { ManifestBundle, PlanInput } from "@codai/axiom-schema";

export interface MakeBundleOptions extends CompileOptions {
  name?: string;
  intent?: string;
  profile?: string;
  checks?: PlanInput["checks"];
}

/** Build a `PlanInput` from a `{ path: content }` map (strings → utf8, bytes → base64). */
export function makePlan(
  files: Record<string, string | Uint8Array>,
  opts: Pick<MakeBundleOptions, "name" | "intent" | "profile" | "checks"> = {},
): PlanInput {
  const artifacts: PlanInput["artifacts"] = Object.entries(files).map(([path, content]) =>
    typeof content === "string"
      ? { path, source: { type: "inline", content } }
      : {
          path,
          source: {
            type: "inline",
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          },
        },
  );
  const plan: PlanInput = {
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: opts.name ?? "fixture",
    intent: opts.intent ?? "testkit fixture",
    artifacts,
  };
  if (opts.profile !== undefined) plan.profile = opts.profile;
  if (opts.checks !== undefined) plan.checks = opts.checks;
  return plan;
}

/** Compile a `{ path: content }` map into a `ManifestBundle`. */
export async function makeBundle(
  files: Record<string, string | Uint8Array>,
  opts: MakeBundleOptions = {},
): Promise<ManifestBundle> {
  return (await makeBundleResult(files, opts)).bundle;
}

export async function makeBundleResult(
  files: Record<string, string | Uint8Array>,
  opts: MakeBundleOptions = {},
): Promise<CompileResult> {
  const { name, intent, profile, checks, ...compile } = opts;
  const planOpts: Pick<MakeBundleOptions, "name" | "intent" | "profile" | "checks"> = {};
  if (name !== undefined) planOpts.name = name;
  if (intent !== undefined) planOpts.intent = intent;
  if (profile !== undefined) planOpts.profile = profile;
  if (checks !== undefined) planOpts.checks = checks;
  return compilePlan(makePlan(files, planOpts), compile);
}

export interface TmpRepo {
  root: string;
  cleanup: () => Promise<void>;
}

/** Fresh temp directory under the OS tmpdir; `cleanup()` removes it recursively. */
export async function tmpRepo(prefix = "axiom-"): Promise<TmpRepo> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}
