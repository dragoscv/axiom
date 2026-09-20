import type { Finding, ManifestArtifact, ManifestBody } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import { buildContentMap, buildRepoMap, type ContentEntry, TEXT_MAX_BYTES } from "./cel.js";
import { finding } from "./util.js";

/**
 * `expr.cedar` — Cedar policies over the same facts `expr.cel` sees (PLAN.md S-411, D-25).
 *
 * Evaluated by `@cedar-policy/cedar-wasm` (Apache-2.0, ~4.3 MB WASM), an **optional**
 * dependency loaded lazily on first use: a host without it makes every `expr.cedar` check a
 * provider error (`ERR_PROVIDER_FAILED`) — fail closed, never a silent pass. Cedar itself is
 * deterministic and total (no I/O, no clock, every evaluation terminates), so unlike `expr.cel`
 * no function allowlist is needed; the caps here are structural (policy text ≤ 64 KiB, ≤ 256
 * policies) plus a wall-clock budget per manifest.
 *
 * One authorization request per artifact:
 *   principal = `Axiom::Plan::"<manifest.name>"`, action = `Axiom::Action::"<op>"`,
 *   resource = `Axiom::Artifact::"<path>"`, context = `{ manifest, repo? }`.
 * Entities: the manifest (parent of every artifact) and every artifact with its manifest
 * fields, plus `bytes`/`sha256`/`text` from the content provider when the policy mentions
 * `text`, and `exists` from the repo provider when it mentions `exists`.
 *
 * `mode: "forbid"` (default) injects `permit(principal, action, resource);` so a policy set is
 * a list of forbid rules and a `deny` is a finding for that artifact — the same shape as
 * `path.deny`. `mode: "permit"` is spec-pure Cedar: the profile author writes the permits and
 * anything not permitted is a finding. Evaluation errors (missing attribute, type error) are
 * provider errors, not findings — Cedar's own diagnostics are surfaced verbatim.
 *
 * OWASP Agent Control Standard mapping (docs/checks.md §expr.cedar): a Cedar `deny` here is an
 * ACS Guardian `deny` on the *write set*; AXIOM never emits `modify`/`ask`/`defer` from a check.
 */
export const CEDAR_POLICY_MAX_CHARS = 64 * 1024;
export const CEDAR_MAX_POLICIES = 256;
/** Wall clock for the whole manifest (all artifacts); first-call WASM init is excluded. */
export const CEDAR_EVAL_BUDGET_MS = 2_000;
export const CEDAR_NAMESPACE = "Axiom";

export const CedarParams = z
  .object({
    /** Cedar policy text (one or more policies). */
    policies: z.string().min(1).max(CEDAR_POLICY_MAX_CHARS),
    /** `forbid` (default): a permit-all is injected; `permit`: spec-pure default-deny. */
    mode: z.enum(["forbid", "permit"]).default("forbid"),
    message: z.string().max(2000).optional(),
    severity: z.enum(["error", "warn", "info"]).optional(),
  })
  .strict();

export type CedarParamsT = z.infer<typeof CedarParams>;

const PREDICATE = "expr.cedar" as const;
const PERMIT_ALL = "permit(principal, action, resource);";

// ---------------------------------------------------------------------------
// cedar-wasm bridge (lazy, optional)

type CedarValue =
  | boolean
  | number
  | string
  | null
  | CedarValue[]
  | { [key: string]: CedarValue }
  | { __entity: { type: string; id: string } };

interface EntityUid {
  type: string;
  id: string;
}

interface CedarEntity {
  uid: EntityUid;
  attrs: Record<string, CedarValue>;
  parents: EntityUid[];
}

interface DetailedError {
  message: string;
  help?: string | null;
  sourceLocations?: { label?: string | null; start: number; end: number }[];
}

interface AuthorizationCall {
  principal: EntityUid;
  action: EntityUid;
  resource: EntityUid;
  context: Record<string, CedarValue>;
  policies: { staticPolicies: string; templates: Record<string, string>; templateLinks: [] };
  entities: CedarEntity[];
}

type AuthorizationAnswer =
  | { type: "failure"; errors: DetailedError[] }
  | {
      type: "success";
      response: {
        decision: "allow" | "deny";
        diagnostics: {
          reason: string[];
          errors: { policyId: string; error: DetailedError }[];
        };
      };
    };

type CheckParseAnswer = { type: "success" } | { type: "failure"; errors: DetailedError[] };

interface CedarModule {
  isAuthorized(call: AuthorizationCall): AuthorizationAnswer;
  checkParsePolicySet(policies: AuthorizationCall["policies"]): CheckParseAnswer;
  policySetTextToParts(
    text: string,
  ): { type: "success"; policies: string[]; policy_templates: string[] } | { type: "failure" };
  getCedarVersion(): string;
}

let modPromise: Promise<CedarModule | undefined> | undefined;

/** Resolve the WASM once; `undefined` when the optional dependency is not installed. */
export function cedarModule(): Promise<CedarModule | undefined> {
  if (modPromise === undefined) {
    modPromise = import("@cedar-policy/cedar-wasm/nodejs").then(
      (m) => m as unknown as CedarModule,
      (err: unknown) => {
        const code = (err as { code?: unknown }).code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return undefined;
        throw err;
      },
    );
  }
  return modPromise;
}

/** Test seam: force the "not installed" path without uninstalling anything. */
export function __setCedarModuleForTests(m: CedarModule | undefined | null): void {
  modPromise = m === null ? undefined : Promise.resolve(m);
}

// ---------------------------------------------------------------------------
// entities

const UID = {
  plan: (name: string): EntityUid => ({ type: `${CEDAR_NAMESPACE}::Plan`, id: name }),
  action: (op: string): EntityUid => ({ type: `${CEDAR_NAMESPACE}::Action`, id: op }),
  manifest: (digest: string): EntityUid => ({ type: `${CEDAR_NAMESPACE}::Manifest`, id: digest }),
  artifact: (path: string): EntityUid => ({ type: `${CEDAR_NAMESPACE}::Artifact`, id: path }),
};

/** Plain JSON → Cedar value: integral numbers stay numbers (Cedar `Long`); everything else as is. */
function toCedarValue(v: unknown): CedarValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? v : String(v);
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(toCedarValue);
  if (typeof v === "object") {
    const out: Record<string, CedarValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toCedarValue(val);
    return out;
  }
  return String(v);
}

export interface CedarActivation {
  manifest: ManifestBody;
  manifestDigest: string;
  content: Record<string, ContentEntry>;
  repo?: Record<string, unknown>;
}

function artifactAttrs(
  a: ManifestArtifact,
  content: ContentEntry | undefined,
  exists: boolean | undefined,
): Record<string, CedarValue> {
  const attrs: Record<string, CedarValue> = { path: a.path, op: a.op, mode: a.mode };
  const ext = a.path.includes(".") ? (a.path.split(".").pop() ?? "") : "";
  attrs.ext = ext;
  attrs.dir = a.path.includes("/") ? a.path.slice(0, a.path.lastIndexOf("/")) : "";
  if (a.digest !== undefined) attrs.sha256 = a.digest.sha256;
  if (a.bytes !== undefined) attrs.bytes = a.bytes;
  if (a.origin !== undefined) attrs.origin = a.origin;
  if (content?.text !== undefined) attrs.text = content.text;
  if (exists !== undefined) attrs.exists = exists;
  return attrs;
}

/** Build the entity store + per-artifact requests for one manifest. */
export function buildCedarRequests(
  act: CedarActivation,
  policies: string,
): { entities: CedarEntity[]; requests: AuthorizationCall[] } {
  const { manifest } = act;
  const manifestUid = UID.manifest(act.manifestDigest);
  const manifestAttrs: Record<string, CedarValue> = {
    name: manifest.name,
    profile: manifest.profile,
    planDigest: manifest.planDigest,
    artifactCount: manifest.artifacts.length,
    checks: manifest.checks.map((c) => c.id),
    toolchain: toCedarValue(manifest.toolchain),
  };
  if (manifest.counter !== undefined) manifestAttrs.counter = manifest.counter;
  if (manifest.preImage !== undefined) {
    manifestAttrs.preImage = toCedarValue(manifest.preImage);
  }
  const entities: CedarEntity[] = [{ uid: manifestUid, attrs: manifestAttrs, parents: [] }];
  const exists = act.repo?.exists as Record<string, boolean> | undefined;
  for (const a of manifest.artifacts) {
    entities.push({
      uid: UID.artifact(a.path),
      attrs: artifactAttrs(a, act.content[a.path], exists?.[a.path]),
      parents: [manifestUid],
    });
  }
  const context: Record<string, CedarValue> = {
    manifest: { name: manifest.name, profile: manifest.profile },
  };
  if (act.repo !== undefined) {
    const repo: Record<string, CedarValue> = {};
    if (act.repo.gitHead !== undefined) repo.gitHead = String(act.repo.gitHead);
    if (act.repo.gitDirty !== undefined) repo.gitDirty = Boolean(act.repo.gitDirty);
    context.repo = repo;
  }
  const policySet: AuthorizationCall["policies"] = {
    staticPolicies: policies,
    templates: {},
    templateLinks: [],
  };
  const requests = manifest.artifacts.map((a) => ({
    principal: UID.plan(manifest.name),
    action: UID.action(a.op),
    resource: UID.artifact(a.path),
    context,
    policies: policySet,
    entities,
  }));
  return { entities, requests };
}

// ---------------------------------------------------------------------------
// evaluation

export type CedarOutcome =
  | { kind: "value"; denied: { path: string; reason: string[] }[]; ms: number }
  | { kind: "error"; code: "ERR_PREDICATE_PARAMS" | "ERR_PROVIDER_FAILED"; message: string };

function fmt(e: DetailedError): string {
  const loc = e.sourceLocations?.[0];
  const where = loc === undefined ? "" : ` @${loc.start}-${loc.end}`;
  return `${e.message}${where}`;
}

/**
 * Parse + evaluate `params.policies` for every artifact of the activation.
 * `denied` lists the artifacts whose decision was `deny` (mode-adjusted), with the policy ids.
 */
export async function evaluateCedar(
  params: Pick<CedarParamsT, "policies" | "mode">,
  act: CedarActivation,
  budgetMs: number = CEDAR_EVAL_BUDGET_MS,
): Promise<CedarOutcome> {
  const mod = await cedarModule();
  if (mod === undefined) {
    return {
      kind: "error",
      code: "ERR_PROVIDER_FAILED",
      message:
        "expr.cedar needs the optional dependency @cedar-policy/cedar-wasm, which is not installed",
    };
  }
  // Appended, not prepended, so the author's policies keep their natural ids (policy0…n-1).
  const text = params.mode === "forbid" ? `${params.policies}\n${PERMIT_ALL}` : params.policies;
  const parts = mod.policySetTextToParts(text);
  if (parts.type === "failure") {
    // Fall through to checkParsePolicySet for the detailed error.
  } else if (parts.policies.length > CEDAR_MAX_POLICIES) {
    return {
      kind: "error",
      code: "ERR_PREDICATE_PARAMS",
      message: `policy set has ${parts.policies.length} policies; max ${CEDAR_MAX_POLICIES}`,
    };
  } else if (parts.policy_templates.length > 0) {
    return {
      kind: "error",
      code: "ERR_PREDICATE_PARAMS",
      message: "policy templates are not supported; write static policies",
    };
  }
  const parsed = mod.checkParsePolicySet({
    staticPolicies: text,
    templates: {},
    templateLinks: [],
  });
  if (parsed.type === "failure") {
    return {
      kind: "error",
      code: "ERR_PREDICATE_PARAMS",
      message: `parse: ${parsed.errors.map(fmt).join("; ")}`,
    };
  }
  const { requests } = buildCedarRequests(act, text);
  const denied: { path: string; reason: string[] }[] = [];
  const t0 = performance.now();
  for (const req of requests) {
    const r = mod.isAuthorized(req);
    if (r.type === "failure") {
      return {
        kind: "error",
        code: "ERR_PROVIDER_FAILED",
        message: `authorize ${req.resource.id}: ${r.errors.map(fmt).join("; ")}`,
      };
    }
    const errs = r.response.diagnostics.errors;
    if (errs.length > 0) {
      // Cedar treats an erroring policy as not applying; AXIOM does not — fail closed.
      return {
        kind: "error",
        code: "ERR_PROVIDER_FAILED",
        message: `eval ${req.resource.id}: ${errs.map((e) => `${e.policyId}: ${fmt(e.error)}`).join("; ")}`,
      };
    }
    if (r.response.decision === "deny") {
      // Cedar returns the determining set in hash order; sort for a stable finding.
      denied.push({ path: req.resource.id, reason: [...r.response.diagnostics.reason].sort() });
    }
    if (performance.now() - t0 > budgetMs) {
      return {
        kind: "error",
        code: "ERR_PROVIDER_FAILED",
        message: `evaluation exceeded ${budgetMs} ms after ${denied.length} denials`,
      };
    }
  }
  return { kind: "value", denied, ms: performance.now() - t0 };
}

function providerError(code: string, message: string): Finding {
  return finding({
    id: PREDICATE,
    predicate: PREDICATE,
    message,
    facts: { code, __provider: true },
  });
}

export async function buildCedarActivation(
  ctx: Pick<FactContext, "manifest" | "bundle" | "facts">,
  policies: string,
): Promise<CedarActivation> {
  const mentions = (name: string) => new RegExp(`\\b${name}\\b`).test(policies);
  const act: CedarActivation = {
    manifest: ctx.manifest,
    manifestDigest: ctx.bundle.manifestDigest,
    content: mentions("text") ? await buildContentMap(ctx) : {},
  };
  if (mentions("exists") || mentions("repo")) {
    const repo = await buildRepoMap(ctx);
    if (repo !== undefined) act.repo = repo;
  }
  return act;
}

export const exprCedar = definePredicate<CedarParamsT>({
  id: PREDICATE,
  params: CedarParams,
  // `repo` is optional input (same contract as `expr.cel`): a policy that mentions `exists` or
  // `repo` without an authorised root is a provider error, not a skip.
  requires: ["manifest", "content"],
  async run(ctx, params) {
    const needsRepo = /\b(exists|repo)\b/.test(params.policies);
    const act = await buildCedarActivation(ctx, params.policies);
    if (needsRepo && act.repo === undefined) {
      return [
        providerError(
          "ERR_PROVIDER_FAILED",
          "policies reference `exists`/`repo` but repo facts are unavailable (no authorised root)",
        ),
      ];
    }
    const r = await evaluateCedar(params, act);
    if (r.kind === "error") return [providerError(r.code, r.message)];
    return r.denied.map((d) => {
      const f = finding({
        id: PREDICATE,
        predicate: PREDICATE,
        message:
          params.message ?? `denied by cedar policy ${d.reason.join(", ") || "(default deny)"}`,
        path: d.path,
        facts: { mode: params.mode, reason: d.reason },
      });
      if (params.severity !== undefined) f.severity = params.severity;
      return f;
    });
  },
});

export { TEXT_MAX_BYTES as CEDAR_TEXT_MAX_BYTES };
