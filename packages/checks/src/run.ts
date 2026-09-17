import { performance } from "node:perf_hooks";
import { canonicalDigestRef } from "@codai/axiom-canon";
import {
  type CheckRef,
  type CheckReport,
  compareUtf8,
  type Finding,
  isAxiomError,
  type ManifestBundle,
  type Profile,
  type ProviderStatus,
} from "@codai/axiom-schema";
import { contentReader } from "./facts/content.js";
import { deriveManifestFacts } from "./facts/manifest.js";
import { createRepoFacts } from "./facts/repo.js";
import { mergeChecks } from "./profile.js";
import { builtinRegistry, type PredicateRegistry } from "./registry.js";
import type { AnyPredicate, FactContext } from "./types.js";

export interface RunChecksOptions {
  bundle: ManifestBundle;
  /** Already resolved (no `extends`) — see `loadProfile`. */
  profile: Profile;
  /** Plan-level checks, merged after the profile's (same id → plan wins). */
  checks?: readonly CheckRef[];
  /** realpath'd, authorised repo root. Repo facts are built only if given AND profile allows. */
  root?: string;
  registry?: PredicateRegistry;
  casDir?: string;
}

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 } as const;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const i = compareUtf8(a.id, b.id);
    if (i !== 0) return i;
    return compareUtf8(a.path ?? "", b.path ?? "");
  });
}

function isProviderFailure(f: Finding): boolean {
  return f.severity === "error" && f.facts.__provider === true;
}

function providerFinding(
  check: CheckRef,
  predicate: string,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Finding {
  return {
    id: check.id,
    severity: "error",
    predicate,
    message,
    facts: { code, __provider: true, ...extra } as Finding["facts"],
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ms(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckReport> {
  const t0 = performance.now();
  const { bundle, profile } = opts;
  const registry = opts.registry ?? builtinRegistry();
  const checks = mergeChecks(profile.checks, opts.checks ?? []);
  const providers: ProviderStatus[] = [];
  const findings: Finding[] = [];
  let providerFailed = false;

  // --- fact providers -------------------------------------------------------
  const tm = performance.now();
  const manifestFacts = deriveManifestFacts(bundle);
  providers.push({ name: "manifest", status: "ok", ms: ms(tm) });

  const tc = performance.now();
  const content = contentReader(bundle, opts.casDir);
  providers.push({ name: "content", status: "ok", ms: ms(tc) });

  const ctx: FactContext = {
    manifest: bundle.manifest,
    bundle,
    facts: { manifest: manifestFacts, content, profile: profile.facts },
  };

  const tr = performance.now();
  if (opts.root !== undefined && profile.facts.allowRepo) {
    try {
      ctx.facts.repo = await createRepoFacts(opts.root);
      providers.push({ name: "repo", status: "ok", ms: ms(tr) });
    } catch (e) {
      providerFailed = true;
      providers.push({ name: "repo", status: "error", ms: ms(tr) });
      findings.push({
        id: "repo",
        severity: "error",
        predicate: "repo",
        message: `repo facts provider failed: ${errorMessage(e)}`,
        facts: { code: "ERR_PROVIDER_FAILED", __provider: true },
      });
    }
  } else {
    providers.push({ name: "repo", status: "skipped", ms: 0 });
  }
  providers.push({ name: "guard", status: "skipped", ms: 0 });
  Object.freeze(ctx.facts);
  Object.freeze(ctx);

  // --- predicates, sequential in check order --------------------------------
  for (const check of checks) {
    let predicate: AnyPredicate;
    try {
      predicate = registry.get(check.predicate);
    } catch (e) {
      providerFailed = true;
      findings.push(
        providerFinding(
          check,
          check.predicate,
          isAxiomError(e) ? e.code : "ERR_PREDICATE_UNKNOWN",
          errorMessage(e),
        ),
      );
      continue;
    }

    if (predicate.requires.includes("repo") && ctx.facts.repo === undefined) {
      // Repo predicates without a root are not evaluable; skipped, not failed.
      continue;
    }
    if (predicate.requires.includes("guard") && !profile.facts.allowGuards) {
      providerFailed = true;
      findings.push(
        providerFinding(
          check,
          predicate.id,
          "ERR_UNSUPPORTED_OP",
          "guards are not allowed by this profile",
        ),
      );
      continue;
    }

    const params = registry.validateParams(check.id, predicate, check.params);
    if (!params.ok) {
      providerFailed = true;
      findings.push(params.finding);
      continue;
    }

    let result: Finding[];
    try {
      result = await predicate.run(ctx, params.params);
    } catch (e) {
      providerFailed = true;
      findings.push(
        providerFinding(
          check,
          predicate.id,
          "ERR_PROVIDER_FAILED",
          `predicate threw: ${errorMessage(e)}`,
        ),
      );
      continue;
    }
    for (const f of result) {
      if (isProviderFailure(f)) {
        providerFailed = true;
        findings.push({ ...f, id: f.id === predicate.id ? check.id : f.id });
      } else {
        findings.push({ ...f, severity: check.severity });
      }
    }
  }

  const sorted = sortFindings(findings);
  const verdict: CheckReport["verdict"] = providerFailed
    ? "error"
    : sorted.some((f) => f.severity === "error")
      ? "fail"
      : "pass";

  return {
    apiVersion: "axiom.dev/v2",
    kind: "CheckReport",
    manifestDigest: bundle.manifestDigest,
    profile: profile.name,
    verdict,
    findings: sorted,
    factsDigest: canonicalDigestRef({
      manifestFacts,
      profileName: profile.name,
      checkIds: checks.map((c) => c.id),
    }),
    durationMs: ms(t0),
    providers,
  };
}
