import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { canonicalDigestRef } from "@codai/axiom-canon";
import {
  API_VERSION,
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
import { deriveManifestFacts, verifyContentSizes } from "./facts/manifest.js";
import { preImageCovers, verifyPreImage } from "./facts/preimage.js";
import { createRepoFacts } from "./facts/repo.js";
import { checksIdentical } from "./profile.js";
import { builtinRegistry, type PredicateRegistry } from "./registry.js";
import type { AnyPredicate, FactContext, GuardOptions } from "./types.js";

export interface RunChecksOptions extends GuardOptions {
  bundle: ManifestBundle;
  /** Already resolved (no `extends`) — see `loadProfile`. */
  profile: Profile;
  /** Plan-level checks. 4.0 (D-50): a check whose id exists in the profile is refused unless it
   * is structurally identical, and a `guard.external` check needs `facts.allowPlanGuards`. */
  checks?: readonly CheckRef[];
  /** realpath'd, authorised repo root. Repo facts are built only if given AND profile allows. */
  root?: string;
  registry?: PredicateRegistry;
  casDir?: string;
  /** Wall-clock budget for one non-guard predicate (A1-4); expiry is `ERR_PROVIDER_FAILED`. */
  predicateTimeoutMs?: number;
}

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 } as const;

/** A1-4 default: a predicate that has not answered in this long is a provider failure. */
export const PREDICATE_TIMEOUT_MS = 30_000;

/** The LESS severe of two severities: a predicate may downgrade a finding, a check may not block
 * a downgrade it did not ask for (A1-23: `params.severity` of `expr.cel` was overwritten by the
 * CheckRef default `error`; A1-10: an `ok:true` guard's informational finding failed the run). */
function lessSevere(a: Finding["severity"], b: Finding["severity"]): Finding["severity"] {
  return SEVERITY_RANK[a] > SEVERITY_RANK[b] ? a : b;
}

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

const PREDICATE_TIMEOUT_MARK: unique symbol = Symbol("axiom.predicate-timeout");

function floorFinding(check: CheckRef, message: string): Finding {
  return {
    id: check.id,
    severity: "error",
    predicate: check.predicate,
    message,
    facts: { code: "ERR_POLICY_FLOOR", __provider: true },
  };
}

/**
 * A1-6 / A2-6 (D-50): the repository policy is a FLOOR. A plan may only ADD checks — one whose
 * id already exists in the profile is refused unless it is structurally identical (otherwise a
 * plan could disable `content.noSecrets` or `manifest.requireSigned` by shipping a check with the
 * same id and a harmless predicate) — and a plan may not add `guard.external` unless the profile
 * opts in (`facts.allowPlanGuards`). A refusal fails the run with `ERR_POLICY_FLOOR`; the
 * profile's own check stays in effect.
 */
function reviewPlanChecks(
  planChecks: readonly CheckRef[],
  profile: Profile,
): { accepted: CheckRef[]; findings: Finding[] } {
  const floor = new Map<string, CheckRef>();
  for (const c of profile.checks) floor.set(c.id, c);
  const accepted: CheckRef[] = [];
  const findings: Finding[] = [];
  for (const c of planChecks) {
    const existing = floor.get(c.id);
    if (existing !== undefined) {
      if (checksIdentical(existing, c)) continue; // identical: the profile's copy already ran
      findings.push(floorFinding(c, "the plan redefines a check of the repository policy"));
      continue;
    }
    if (c.predicate === "guard.external" && profile.facts.allowPlanGuards !== true) {
      findings.push(
        floorFinding(
          c,
          "a plan may not add a guard.external check unless the profile sets facts.allowPlanGuards",
        ),
      );
      continue;
    }
    accepted.push(c);
  }
  return { accepted, findings };
}

/**
 * A1-4: a wall-clock budget for one predicate. A predicate that never answers must fail the run
 * (an adversarial pattern used to block `plan check` / `axiom_check` / `axiom_apply` forever).
 * The abandoned promise cannot be cancelled: the run reports `ERR_PROVIDER_FAILED` and moves on.
 */
async function withBudget(
  run: Promise<Finding[]>,
  ms: number,
): Promise<Finding[] | typeof PREDICATE_TIMEOUT_MARK> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof PREDICATE_TIMEOUT_MARK>((resolve) => {
    timer = setTimeout(() => resolve(PREDICATE_TIMEOUT_MARK), ms);
  });
  try {
    return await Promise.race([run, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function ms(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

/** §3.2: external guards run in a pool of `min(4, cpus)`. */
export const GUARD_POOL_SIZE = Math.max(1, Math.min(4, cpus().length));

async function runPool<T>(items: readonly T[], size: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
    }),
  );
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckReport> {
  const t0 = performance.now();
  const { bundle, profile } = opts;
  const registry = opts.registry ?? builtinRegistry();
  const review = reviewPlanChecks(opts.checks ?? [], profile);
  const checks: CheckRef[] = [...profile.checks];
  const seenIds = new Set(checks.map((c) => c.id));
  for (const c of review.accepted) {
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    checks.push(c);
  }
  const providers: ProviderStatus[] = [];
  const findings: Finding[] = [...review.findings];
  let providerFailed = review.findings.length > 0;

  const predicateFor = (check: CheckRef): AnyPredicate | undefined => {
    try {
      return registry.get(check.predicate);
    } catch {
      return undefined;
    }
  };
  const repoNeeded = checks.some((c) => predicateFor(c)?.requires.includes("repo") === true);

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

  // A1-8: `bytes` must be declared and true, and `profile.limits` must bind.
  const tz = performance.now();
  const sizeIssues = await verifyContentSizes(bundle, profile.limits, content);
  for (const issue of sizeIssues) {
    providerFailed = true;
    const f: Finding = {
      id: "manifest.sizes",
      severity: "error",
      predicate: "manifest.sizes",
      message: issue.message,
      facts: { code: issue.code, __provider: true, ...issue.facts } as Finding["facts"],
    };
    if (issue.path !== undefined) f.path = issue.path;
    findings.push(f);
  }
  providers.push({
    name: "manifest.sizes",
    status: sizeIssues.length > 0 ? "error" : "ok",
    ms: ms(tz),
  });

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
    // A1-30: `allowRepo` with no authorised root is a missing REQUIRED fact -> error, never a
    // silent "skipped" (invariant 7). "skipped" is reserved for `facts.allowRepo: false`.
    providers.push({
      name: "repo",
      status: profile.facts.allowRepo && repoNeeded ? "error" : "skipped",
      ms: 0,
    });
  }

  // S-402: the manifest names the tree it was compiled against; a check against a different
  // tree is judging something that will not be applied → `error` finding, verdict error.
  let preImageStatus: CheckReport["preImage"] = "unverified";
  // A1-20: `preImage` is bound to the artifacts. An empty (or partial) list compares nothing and
  // must never read as `verified`; the manifest is refused instead.
  const coverage = preImageCovers(bundle.manifest);
  if (!coverage.ok) {
    providerFailed = true;
    findings.push({
      id: "manifest.preImage",
      severity: "error",
      predicate: "manifest.preImage",
      message: `manifest preImage does not cover the artifacts (missing: ${coverage.missing.join(", ") || "-"}; unexpected: ${coverage.unexpected.join(", ") || "-"}; duplicated: ${coverage.duplicates.join(", ") || "-"})`,
      facts: {
        code: "ERR_INVALID_MANIFEST",
        __provider: true,
        missing: coverage.missing,
        unexpected: coverage.unexpected,
        duplicates: coverage.duplicates,
      },
    });
  } else if (opts.root !== undefined && bundle.manifest.preImage !== undefined) {
    const drifted = await verifyPreImage(opts.root, bundle.manifest.preImage);
    preImageStatus = drifted.length === 0 ? "verified" : "drifted";
    for (const d of drifted) {
      providerFailed = true;
      findings.push({
        id: "manifest.preImage",
        severity: "error",
        predicate: "manifest.preImage",
        message: `tree differs from the manifest pre-image (expected ${d.expected}, found ${d.actual})`,
        path: d.path,
        facts: {
          code: "ERR_PREIMAGE_CHANGED",
          __provider: true,
          expected: d.expected,
          actual: d.actual,
        },
      });
    }
  }
  const guardsEnabled =
    opts.allowGuards === true && profile.facts.allowGuards && opts.root !== undefined;
  if (guardsEnabled && opts.root !== undefined) {
    const guard: NonNullable<FactContext["facts"]["guard"]> = {
      enabled: true,
      root: opts.root,
      allowlist: [...(opts.guardAllowlist ?? [])],
    };
    if (opts.stagingDir !== undefined) guard.stagingDir = opts.stagingDir;
    if (opts.signal !== undefined) guard.signal = opts.signal;
    ctx.facts.guard = guard;
  }
  Object.freeze(ctx.facts);
  Object.freeze(ctx);

  const budget = opts.predicateTimeoutMs ?? PREDICATE_TIMEOUT_MS;

  // --- predicates: sequential in check order; guard.external in a pool ------
  const guardChecks: { check: CheckRef; predicate: AnyPredicate; params: unknown }[] = [];
  let guardFailed = false;

  const collect = (check: CheckRef, predicate: AnyPredicate, result: Finding[]) => {
    for (const f of result) {
      if (isProviderFailure(f)) {
        providerFailed = true;
        if (predicate.requires.includes("guard")) guardFailed = true;
        findings.push({ ...f, id: f.id === predicate.id ? check.id : f.id });
      } else {
        // A1-10 / A1-23: keep the predicate's own severity (a guard's `info`, a CEL
        // `params.severity`) — the CheckRef only ever overrides with a MORE severe one.
        findings.push({ ...f, severity: lessSevere(f.severity, check.severity) });
      }
    }
  };

  const execute = async (
    check: CheckRef,
    predicate: AnyPredicate,
    params: unknown,
    budgetMs: number | undefined,
  ) => {
    let result: Finding[];
    try {
      const r =
        budgetMs === undefined
          ? await predicate.run(ctx, params)
          : await withBudget(predicate.run(ctx, params), budgetMs);
      // A1-4: a predicate that never answers (an adversarial pattern) fails the run instead of
      // blocking it. The abandoned promise cannot be cancelled — it is reported, not awaited.
      if (r === PREDICATE_TIMEOUT_MARK) {
        providerFailed = true;
        if (predicate.requires.includes("guard")) guardFailed = true;
        findings.push(
          providerFinding(
            check,
            predicate.id,
            "ERR_PROVIDER_FAILED",
            `predicate exceeded its ${budgetMs} ms budget`,
          ),
        );
        return;
      }
      result = r;
    } catch (e) {
      providerFailed = true;
      if (predicate.requires.includes("guard")) guardFailed = true;
      findings.push(
        providerFinding(
          check,
          predicate.id,
          "ERR_PROVIDER_FAILED",
          `predicate threw: ${errorMessage(e)}`,
        ),
      );
      return;
    }
    collect(check, predicate, result);
  };

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
      // A1-30: a required repo fact that is absent fails the run. Only an explicit
      // `facts.allowRepo: false` keeps a repo predicate out of the run ("skipped").
      if (profile.facts.allowRepo) {
        providerFailed = true;
        findings.push(
          providerFinding(
            check,
            predicate.id,
            "ERR_FACT_DISABLED",
            "repo facts are unavailable: no authorised root was given to the runner",
          ),
        );
      }
      continue;
    }
    if (predicate.requires.includes("guard") && !profile.facts.allowGuards) {
      providerFailed = true;
      guardFailed = true;
      findings.push(
        providerFinding(
          check,
          predicate.id,
          "ERR_FACT_DISABLED",
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

    if (predicate.requires.includes("guard")) {
      guardChecks.push({ check, predicate, params: params.params });
      continue;
    }
    await execute(check, predicate, params.params, budget);
  }

  const tg = performance.now();
  if (guardChecks.length > 0 || guardFailed) {
    // Guards carry their own per-guard timeout (up to 15 min), so the predicate budget does not
    // apply to them.
    await runPool(guardChecks, GUARD_POOL_SIZE, (g) =>
      execute(g.check, g.predicate, g.params, undefined),
    );
    providers.push({
      name: "guard",
      status: !guardsEnabled || guardFailed ? "error" : "ok",
      ms: ms(tg),
    });
  } else {
    providers.push({ name: "guard", status: "skipped", ms: 0 });
  }

  const sorted = sortFindings(findings);
  const verdict: CheckReport["verdict"] = providerFailed
    ? "error"
    : sorted.some((f) => f.severity === "error")
      ? "fail"
      : "pass";

  return {
    apiVersion: API_VERSION,
    kind: "CheckReport",
    manifestDigest: bundle.manifestDigest,
    profile: profile.name,
    verdict,
    findings: sorted,
    // 4.0 (D-50, A1-6): the digest covers the identity of every check that RAN, not just its id —
    // two runs that agreed on ids but not on predicates/params/severity used to hash the same, so
    // a report could not be told apart from the report of the policy the plan had replaced.
    factsDigest: canonicalDigestRef({
      manifestFacts,
      profileName: profile.name,
      checks: checks.map((c) => ({
        id: c.id,
        predicate: c.predicate,
        params: c.params ?? null,
        severity: c.severity ?? "error",
      })),
    }),
    durationMs: ms(t0),
    providers,
    preImage: preImageStatus,
  };
}
