import type { Finding, ManifestBody } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import { finding, isUtf8 } from "./util.js";

/**
 * `expr.cel` — a boolean CEL expression over the frozen facts (PLAN.md S-301, D-15).
 *
 * Evaluated by `@marcbachmann/cel-js` (loaded lazily on first use so the MCP eager
 * bundle does not pay for it). Determinism bar enforced here, not trusted from the lib:
 *   - closed allowlist of callable functions (no timestamp/duration/encoding families);
 *   - `matches()` only with a literal, RE2-safe pattern (no lookaround, no backrefs);
 *   - only four variables (`manifest`, `artifacts`, `content`, `repo`) — anything else is
 *     an evaluation error;
 *   - structural caps (expression ≤ 4 KiB, AST depth ≤ 24, ≤ 2000 nodes) and a wall-clock
 *     guard (≤ 100 ms) that turns a slow evaluation into `verdict: error`.
 * Every failure is a provider-style `error` finding — never a pass.
 */
export const EXPRESSION_MAX_CHARS = 4096;
export const EVAL_BUDGET_MS = 100;
/** Text is exposed in `content[path].text` only when UTF-8 and at most this many bytes. */
export const TEXT_MAX_BYTES = 256 * 1024;

export const CEL_LIMITS = {
  maxDepth: 24,
  maxAstNodes: 2000,
  maxListElements: 256,
  maxMapEntries: 256,
  maxCallArguments: 8,
} as const;

/** Functions/macros an expression may call. Everything else → `ERR_PREDICATE_PARAMS`. */
export const CEL_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // macros
  "has",
  "all",
  "exists",
  "exists_one",
  "map",
  "filter",
  // aggregates
  "size",
  // strings
  "contains",
  "startsWith",
  "endsWith",
  "matches",
  "lowerAscii",
  "upperAscii",
  "trim",
  "split",
  "join",
  "indexOf",
  "lastIndexOf",
  "substring",
  // conversions / types
  "string",
  "int",
  "uint",
  "double",
  "bool",
  "bytes",
  "dyn",
  "type",
]);

export const CelParams = z
  .object({
    expression: z.string().min(1).max(EXPRESSION_MAX_CHARS),
    message: z.string().max(2000).optional(),
    severity: z.enum(["error", "warn", "info"]).optional(),
  })
  .strict();

export type CelParamsT = z.infer<typeof CelParams>;

const PREDICATE = "expr.cel" as const;
const VARIABLES = ["manifest", "artifacts", "content", "repo"] as const;

/** Lookaround, backreferences and named backreferences are not RE2 — reject the literal. */
const UNSAFE_REGEX = /\(\?<?[=!]|\\[1-9]|\\k</;

// ---------------------------------------------------------------------------
// cel-js bridge (lazy)

interface CelAst {
  op: string;
  args: unknown;
}

interface CelEnvironment {
  registerVariable(name: string, type: string): CelEnvironment;
  parse(expression: string): { (context: Record<string, unknown>): unknown; ast: CelAst };
}

interface CelModule {
  Environment: new (opts: {
    limits: typeof CEL_LIMITS;
    unlistedVariablesAreDyn: boolean;
  }) => CelEnvironment;
}

let envPromise: Promise<CelEnvironment> | undefined;

function celEnvironment(): Promise<CelEnvironment> {
  if (envPromise === undefined) {
    envPromise = import("@marcbachmann/cel-js").then((m) => {
      const mod = m as unknown as CelModule;
      let env = new mod.Environment({ limits: CEL_LIMITS, unlistedVariablesAreDyn: false });
      env = env.registerVariable("manifest", "map");
      env = env.registerVariable("artifacts", "list");
      env = env.registerVariable("content", "map");
      env = env.registerVariable("repo", "map");
      return env;
    });
  }
  return envPromise;
}

// ---------------------------------------------------------------------------
// static analysis of the parsed AST

export interface AstAnalysis {
  /** Names of calls outside `CEL_ALLOWED_FUNCTIONS`, in source order. */
  deniedCalls: string[];
  /** `matches()` calls whose pattern is not a literal, or is a literal but not RE2-safe. */
  unsafeRegex: string[];
  /** Root identifiers referenced (`manifest`, `content`, …). */
  variables: Set<string>;
}

function isNode(v: unknown): v is CelAst {
  return typeof v === "object" && v !== null && "op" in v && "args" in v;
}

function children(n: CelAst): CelAst[] {
  const a = n.args;
  switch (n.op) {
    case "value":
    case "id":
      return [];
    case ".":
    case ".?":
      return Array.isArray(a) && isNode(a[0]) ? [a[0]] : [];
    case "call":
      return Array.isArray(a) && Array.isArray(a[1]) ? a[1].filter(isNode) : [];
    case "rcall": {
      if (!Array.isArray(a)) return [];
      const out: CelAst[] = [];
      if (isNode(a[1])) out.push(a[1]);
      if (Array.isArray(a[2])) out.push(...a[2].filter(isNode));
      return out;
    }
    case "map":
      return Array.isArray(a)
        ? a.flatMap((e) => (Array.isArray(e) ? e.filter(isNode) : isNode(e) ? [e] : []))
        : [];
    default:
      if (isNode(a)) return [a];
      return Array.isArray(a) ? a.filter(isNode) : [];
  }
}

export function analyzeAst(root: CelAst): AstAnalysis {
  const out: AstAnalysis = { deniedCalls: [], unsafeRegex: [], variables: new Set() };
  const stack: CelAst[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (n.op === "id" && typeof n.args === "string") out.variables.add(n.args);
    if (n.op === "call" || n.op === "rcall") {
      const args = n.args as unknown[];
      const name = typeof args[0] === "string" ? args[0] : "";
      if (!CEL_ALLOWED_FUNCTIONS.has(name)) out.deniedCalls.push(name);
      if (name === "matches") {
        const params = n.op === "rcall" ? args[2] : (args[1] as unknown[]).slice(1);
        const pat = Array.isArray(params) ? params[0] : undefined;
        if (!isNode(pat) || pat.op !== "value" || typeof pat.args !== "string") {
          out.unsafeRegex.push("<non-literal pattern>");
        } else if (UNSAFE_REGEX.test(pat.args)) {
          out.unsafeRegex.push(pat.args);
        }
      }
    }
    // Reverse so the traversal is source order.
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k !== undefined) stack.push(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// activation

/** Deep-copy JSON data, turning integral numbers into CEL ints (BigInt). */
export function toCelValue(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : v;
  if (Array.isArray(v)) return v.map(toCelValue);
  if (v instanceof Uint8Array) return v;
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toCelValue(val);
    return out;
  }
  return v;
}

export interface ContentEntry {
  bytes: bigint;
  sha256: string;
  text?: string;
}

export async function buildContentMap(
  ctx: Pick<FactContext, "manifest" | "facts">,
): Promise<Record<string, ContentEntry>> {
  const out: Record<string, ContentEntry> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const a of ctx.manifest.artifacts) {
    if (a.op === "delete" || a.digest === undefined) continue;
    const bytes = await ctx.facts.content(a.path);
    if (bytes === undefined) continue;
    const entry: ContentEntry = { bytes: BigInt(bytes.length), sha256: a.digest.sha256 };
    if (bytes.length <= TEXT_MAX_BYTES && isUtf8(bytes)) entry.text = decoder.decode(bytes);
    out[a.path] = entry;
  }
  return out;
}

export async function buildRepoMap(
  ctx: Pick<FactContext, "manifest" | "facts">,
): Promise<Record<string, unknown> | undefined> {
  const repo = ctx.facts.repo;
  if (repo === undefined) return undefined;
  const exists: Record<string, boolean> = {};
  for (const a of ctx.manifest.artifacts) exists[a.path] = await repo.exists(a.path);
  const out: Record<string, unknown> = { exists };
  if (repo.packageJson !== undefined) out.packageJson = toCelValue(repo.packageJson);
  if (repo.gitHead !== undefined) out.gitHead = repo.gitHead;
  if (repo.gitDirty !== undefined) out.gitDirty = repo.gitDirty;
  return out;
}

export function manifestActivation(manifest: ManifestBody): {
  manifest: Record<string, unknown>;
  artifacts: unknown[];
} {
  const m = toCelValue(manifest) as Record<string, unknown>;
  return { manifest: m, artifacts: m.artifacts as unknown[] };
}

// ---------------------------------------------------------------------------
// evaluation

export type CelOutcome =
  | { kind: "value"; value: boolean; ms: number }
  | { kind: "error"; code: "ERR_PREDICATE_PARAMS" | "ERR_PROVIDER_FAILED"; message: string };

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const first = e.message.split("\n")[0] ?? e.message;
    return typeof code === "string" ? `${code}: ${first}` : first;
  }
  return String(e);
}

/**
 * Parse, statically vet and evaluate `expression` against `activation`.
 * `activation.repo` may be `undefined`; referencing `repo` then is an error.
 */
export async function evaluateCel(
  expression: string,
  activation: {
    manifest: Record<string, unknown>;
    artifacts: unknown[];
    content: Record<string, unknown>;
    repo?: Record<string, unknown>;
  },
  budgetMs: number = EVAL_BUDGET_MS,
): Promise<CelOutcome> {
  if (expression.length > EXPRESSION_MAX_CHARS) {
    return {
      kind: "error",
      code: "ERR_PREDICATE_PARAMS",
      message: `expression exceeds ${EXPRESSION_MAX_CHARS} characters`,
    };
  }
  const env = await celEnvironment();
  let compiled: ReturnType<CelEnvironment["parse"]>;
  try {
    compiled = env.parse(expression);
  } catch (e) {
    return { kind: "error", code: "ERR_PREDICATE_PARAMS", message: `parse: ${errorMessage(e)}` };
  }
  const analysis = analyzeAst(compiled.ast);
  if (analysis.deniedCalls.length > 0) {
    return {
      kind: "error",
      code: "ERR_PREDICATE_PARAMS",
      message: `function not allowed: ${[...new Set(analysis.deniedCalls)].join(", ")}`,
    };
  }
  if (analysis.unsafeRegex.length > 0) {
    return {
      kind: "error",
      code: "ERR_PREDICATE_PARAMS",
      message: `matches() pattern must be a literal RE2-safe regex: ${analysis.unsafeRegex.join(", ")}`,
    };
  }
  if (analysis.variables.has("repo") && activation.repo === undefined) {
    return {
      kind: "error",
      code: "ERR_PROVIDER_FAILED",
      message: "expression references `repo` but repo facts are unavailable (no authorised root)",
    };
  }
  const context: Record<string, unknown> = {
    manifest: activation.manifest,
    artifacts: activation.artifacts,
    content: activation.content,
  };
  if (activation.repo !== undefined) context.repo = activation.repo;
  const t0 = performance.now();
  let value: unknown;
  try {
    value = compiled(context);
  } catch (e) {
    return { kind: "error", code: "ERR_PROVIDER_FAILED", message: `eval: ${errorMessage(e)}` };
  }
  const ms = performance.now() - t0;
  if (ms > budgetMs) {
    return {
      kind: "error",
      code: "ERR_PROVIDER_FAILED",
      message: `evaluation took ${Math.round(ms)} ms (budget ${budgetMs} ms)`,
    };
  }
  if (typeof value !== "boolean") {
    return {
      kind: "error",
      code: "ERR_PROVIDER_FAILED",
      message: `expression must evaluate to bool, got ${celTypeName(value)}`,
    };
  }
  return { kind: "value", value, ms };
}

function celTypeName(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "bigint") return "int";
  if (typeof v === "number") return "double";
  if (Array.isArray(v)) return "list";
  if (v instanceof Uint8Array) return "bytes";
  return typeof v;
}

function providerError(code: string, message: string, expression: string): Finding {
  return finding({
    id: PREDICATE,
    predicate: PREDICATE,
    message,
    facts: { code, __provider: true, expression },
  });
}

export const exprCel = definePredicate<CelParamsT>({
  id: PREDICATE,
  params: CelParams,
  // `repo` is optional input: referencing it without a root is an error, not a skip.
  requires: ["manifest", "content"],
  async run(ctx, { expression, message, severity }) {
    const { manifest, artifacts } = manifestActivation(ctx.manifest);
    // Only pay for blob decoding / repo stats when the expression can observe them.
    const mentions = (name: string) => new RegExp(`\\b${name}\\b`).test(expression);
    const content = mentions("content") ? await buildContentMap(ctx) : {};
    const activation: Parameters<typeof evaluateCel>[1] = { manifest, artifacts, content };
    if (mentions("repo")) {
      const repo = await buildRepoMap(ctx);
      if (repo !== undefined) activation.repo = repo;
    }
    const r = await evaluateCel(expression, activation);
    if (r.kind === "error") return [providerError(r.code, r.message, expression)];
    if (r.value) return [];
    const f = finding({
      id: PREDICATE,
      predicate: PREDICATE,
      message: message ?? `expression evaluated to false: ${expression}`,
      facts: { expression },
    });
    if (severity !== undefined) f.severity = severity;
    return [f];
  },
});

export { VARIABLES as CEL_VARIABLES };
