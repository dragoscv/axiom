/**
 * ONE policy resolver for every consumer of the repository policy (4.0, D-50 / S-1407).
 *
 * Reality check #2 found that the gate, the post hook, `doctor`, `stats`, `explain`, `fleet`
 * and `check`/`apply` each read a different subset of `.axiom/axiom.json`, `.axiom/gate-profile.json`
 * and `.axiom/profiles/*.json`, so a repo could be judged by one file and reported on by another
 * (an `axiom.json` without a `gate` section switched the gate off while doctor stayed green).
 *
 * Contract (every module reads the policy through this file, nothing else re-implements it):
 *   - `resolvePolicy(root, opts)` → the effective gate policy, the raw merged `checks` section,
 *     every source layer in merge order, and a digest of the effective policy
 *     (`policyDigest`, journaled and attested so "which policy decided" is a fact, not a path).
 *   - An `axiom.json` WITHOUT a `gate` key never yields an empty gate policy: the gate section
 *     falls through to `gate-profile.json`, then to the built-in default (never "allow all").
 *   - A linked worktree inherits the main clone's effective policy as a FLOOR; a nested root
 *     takes its ancestor's policy as a floor (stricter wins; deny/ask/hard union).
 *
 * The first version delegates to the 3.0 loaders so every consumer can migrate to this entry
 * point independently; S-1407 replaces the body (floor merge, nested roots, user/org layers).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { canonicalize } from "@codai/axiom-canon";
import { type GateProfile, loadGateProfileForRoot } from "./gate-profile.js";
import { loadAxiomConfig } from "./profile-v3.js";

export interface ResolvedPolicy {
  /** Effective gate policy (schema defaults applied). */
  gate: GateProfile;
  /** Raw merged `checks` section of `axiom.json`, or `undefined` when no v3 file exists. Pass as `loadProfile(name, { config })`. */
  checks: unknown;
  /** Source that decided the gate section (file path, `axiom:<pack>` or `npm:<pkg>`). */
  source: string;
  /** Every layer in merge order (root file last). */
  sources: string[];
  /** Warnings produced while resolving (unknown keys, deprecations). */
  warnings: string[];
  /** `sha256:<hex>` over the JCS form of the effective gate policy + sources. */
  policyDigest: string;
}

export interface ResolvePolicyOptions {
  profilePath?: string;
  home?: string;
}

/** `sha256:<hex>` of the JCS form of `value`. */
export function policyDigestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export async function resolvePolicy(
  root: string,
  opts: ResolvePolicyOptions = {},
): Promise<ResolvedPolicy> {
  const loaded = await loadGateProfileForRoot(root, opts);
  let checks: unknown;
  let sources: string[] = [loaded.source];
  // Warnings are complete sentences: every consumer prints them as `<source>: <warning>`.
  const warnings: string[] =
    loaded.unknownKeys === undefined
      ? []
      : [`ignoring unknown key(s) ${loaded.unknownKeys.join(", ")} (written for a newer axiom?)`];
  if (opts.profilePath === undefined) {
    const cfg = await loadAxiomConfig(root, opts.home === undefined ? {} : { home: opts.home });
    if (cfg !== undefined) {
      checks = cfg.checks;
      sources = cfg.sources.length === 0 ? sources : [...cfg.sources];
    }
  }
  return {
    gate: loaded.profile,
    checks,
    source: loaded.source,
    sources,
    warnings,
    policyDigest: policyDigestOf({
      gate: loaded.profile,
      sources: sources.map((s) => path.basename(s)),
    }),
  };
}
