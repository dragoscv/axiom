import { access, constants, lstat, stat } from "node:fs/promises";
import * as path from "node:path";
import { appliedPath, apply, rollback } from "@codai/axiom-apply";
import { type GuardOptions, loadProfile, runChecks } from "@codai/axiom-checks";
import { compilePlan, diffManifests, type EmitterRegistry, verifyBundle } from "@codai/axiom-plan";
import {
  API_VERSION,
  ApplyResultSchema,
  ArtifactModeSchema,
  AxiomError,
  type CheckReport,
  CheckReportSchema,
  type DigestRef,
  DigestRefSchema,
  ErrorCodeSchema,
  JournalPhaseSchema,
  type ManifestBundle,
  ManifestBundleSchema,
  PlanArtifactSchema,
  PlanSchema,
  RelPathSchema,
  RepoSnapshotSchema,
} from "@codai/axiom-schema";
import { z } from "zod";
import type { ElicitConfirmRequest, ElicitConfirmResult } from "./adapter.js";
import { NO_EMITTERS, withEmitterHint } from "./emitters.js";
import { advanceTrustState, profileWantsAntiRollback, verifyBundleAgainstRoot } from "./keys.js";
import type { Logger } from "./log.js";
import { type RootsPolicy, resolveRoot } from "./roots.js";
import {
  SNAPSHOT_MAX_BYTES_DEFAULT,
  SNAPSHOT_MAX_FILES_CAP,
  SNAPSHOT_MAX_FILES_DEFAULT,
  snapshotRoot,
} from "./snapshot.js";
import { collectStatus } from "./status.js";
import { loadManifest, saveManifest, saveReport, toDigestRef } from "./store.js";
import {
  type PlanSessionStore,
  TaskErrorSchema,
  TaskStatusSchema,
  type TaskStore,
} from "./tasks.js";
import { CORE_TOOL_NAMES, type Toolset } from "./toolset.js";

export {
  CORE_TOOL_NAMES,
  DEFAULT_TOOLSET,
  parseToolset,
  TOOLSETS,
  type Toolset,
  toolsetOf,
} from "./toolset.js";

/** Hard cap on any single `bundle`/`plan` argument, measured as UTF-8 JSON bytes (§(f) payload size). */
export const BUNDLE_BYTES_MAX = 4 * 1024 * 1024;
/** Findings/errors echoed in the text summary. */
export const SUMMARY_LIST_MAX = 20;

export type RiskClass = "READ" | "ACT" | "SENSITIVE";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolContext {
  policy: RootsPolicy;
  log: Logger;
  /** Roots that received a stored manifest/report during this process (for DigestRef lookups). */
  seenRoots: Set<string>;
  /** `--allow-guards` / `--guard-allowlist` from startup (§3.2); absent = guards disabled. */
  guards?: GuardOptions;
  /** Long-running checks (`axiom_check_start` / `axiom_task_*`), shared across a factory's instances (S-406). */
  tasks: TaskStore;
  /** Chunked plan sessions (`axiom_plan_begin` / `add` / `seal`), shared like `tasks`. */
  planSessions: PlanSessionStore;
  /** Template emitters loaded via `--emitter <pkg>`; absent → `template` sources fail with a hint. */
  emitters?: EmitterRegistry;
  /**
   * `--require-human` (S-1206): the confirm step of `axiom_apply` / `axiom_write` must be a human
   * elicitation answer; a client without form elicitation gets ERR_CONFIRM_DIGEST_MISMATCH
   * `{ reason: "elicitation-unsupported" }` instead of the confirmDigest echo.
   */
  requireHuman?: boolean;
  /** Per-call elicitation seam, set by `wrapHandler`; absent outside an MCP request. */
  elicit?: (req: ElicitConfirmRequest) => Promise<ElicitConfirmResult>;
}

export interface ToolDef<I extends z.ZodRawShape = z.ZodRawShape, O extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations: ToolAnnotations;
  riskClass: RiskClass;
  /** Tool-definition `_meta` advertised in tools/list (e.g. `anthropic/requiresUserInteraction`). */
  meta?: Record<string, unknown>;
  handler: (ctx: ToolContext, input: z.output<z.ZodObject<I>>) => Promise<z.output<O>>;
  /** Small text projection of the output for `content[0].text`. Never the whole bundle. */
  summarize: (output: z.output<O>) => unknown;
}

export type AnyToolDef = ToolDef<z.ZodRawShape, z.ZodType>;

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Writes only under `<root>/.axiom/` (CAS blobs, stored manifests) — never the working tree. */
const ACT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export function riskClassOf(a: ToolAnnotations): RiskClass {
  if (a.readOnlyHint) return "READ";
  return a.destructiveHint ? "SENSITIVE" : "ACT";
}

function defineTool<I extends z.ZodRawShape, O extends z.ZodType>(
  def: Omit<ToolDef<I, O>, "riskClass">,
): AnyToolDef {
  return { ...def, riskClass: riskClassOf(def.annotations) } as unknown as AnyToolDef;
}

// --- shared input pieces ------------------------------------------------------

const LooseObject = z.record(z.string(), z.unknown());
const RootArg = z
  .string()
  .optional()
  .describe("Absolute repository root; must equal or lie inside an allowlisted --root");
const ProfileArg = z
  .string()
  .optional()
  .describe(
    "Profile name (builtin default|strict|permissive, or <root>/.axiom/profiles/<name>.json)",
  );

/** Reject oversized payloads before any deeper parsing. */
export function guardPayloadSize(label: string, value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  if (bytes > BUNDLE_BYTES_MAX) {
    throw new AxiomError(
      "ERR_BUNDLE_TOO_LARGE",
      `${label} is ${bytes} bytes; max ${BUNDLE_BYTES_MAX}`,
      {
        details: { bytes, max: BUNDLE_BYTES_MAX },
      },
    );
  }
}

function parseBundle(raw: unknown): ManifestBundle {
  guardPayloadSize("bundle", raw);
  const parsed = ManifestBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_MANIFEST", "bundle does not match ManifestBundleSchema", {
      details: {
        issues: parsed.error.issues
          .slice(0, SUMMARY_LIST_MAX)
          .map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      },
    });
  }
  return parsed.data;
}

async function profileFor(
  ctx: ToolContext,
  bundle: ManifestBundle,
  name: string | undefined,
  rootReal: string | undefined,
) {
  const searchDirs = rootReal === undefined ? [] : [path.join(rootReal, ".axiom", "profiles")];
  const profileName = name ?? bundle.manifest.profile;
  ctx.log.debug("profile", { name: profileName, searchDirs });
  return loadProfile(profileName, { searchDirs });
}

async function checkBundle(
  ctx: ToolContext,
  bundle: ManifestBundle,
  profileName: string | undefined,
  rootReal: string | undefined,
  signal?: AbortSignal,
): Promise<CheckReport> {
  const profile = await profileFor(ctx, bundle, profileName, rootReal);
  const opts: Parameters<typeof runChecks>[0] = {
    bundle,
    profile,
    checks: bundle.manifest.checks,
    ...ctx.guards,
  };
  if (signal !== undefined) opts.signal = signal;
  if (rootReal !== undefined) {
    opts.root = rootReal;
    opts.casDir = path.join(rootReal, ".axiom", "cas");
  }
  const report = await runChecks(opts);
  if (signal?.aborted) {
    throw new AxiomError("ERR_TASK_CANCELLED", "check cancelled", {
      details: { manifestDigest: bundle.manifestDigest },
    });
  }
  if (rootReal !== undefined) {
    await saveReport(rootReal, report);
    ctx.seenRoots.add(rootReal);
  }
  return report;
}

/** Optional root: explicit → allowlist check; absent → the single root if there is one, else none. */
async function optionalRoot(ctx: ToolContext, requested?: string): Promise<string | undefined> {
  if (requested !== undefined && requested !== "")
    return (await resolveRoot(ctx.policy, requested)).rootReal;
  if (ctx.policy.roots.size === 1) return (await resolveRoot(ctx.policy)).rootReal;
  return undefined;
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

// --- output schemas -------------------------------------------------------------

const IssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export const PlanValidateOutput = z.object({
  ok: z.boolean(),
  planDigest: DigestRefSchema.optional(),
  errors: z.array(IssueSchema),
});

export const ManifestVerifyOutput = z.object({
  ok: z.boolean(),
  manifestDigest: DigestRefSchema.optional(),
  canonical: z.boolean(),
  signed: z.boolean(),
  missing: z.array(z.string()),
  errors: z.array(
    z.object({ code: ErrorCodeSchema, message: z.string(), path: z.string().optional() }),
  ),
  /** Present only when a root with `.axiom/trust/keys.json` was available (D-16). */
  signatures: z
    .object({
      trustFile: z.string(),
      /** Trusted keyids whose signature verified over this manifest. */
      keyids: z.array(z.string()),
      findings: z.array(z.object({ id: z.string(), message: z.string() })),
      ok: z.boolean(),
      /** `ERR_SIGNATURE_MISSING` (no signatures at all) or `ERR_SIGNATURE_INVALID`; absent when `ok`. */
      code: z.enum(["ERR_SIGNATURE_MISSING", "ERR_SIGNATURE_INVALID"]).optional(),
    })
    .optional(),
});

export const RollbackOutput = z.object({
  manifestDigest: DigestRefSchema,
  status: z.literal("rolled-back"),
  phase: JournalPhaseSchema,
  steps: z.int().nonnegative(),
  root: z.string(),
});

export const ManifestDiffOutput = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(
    z.object({ path: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
});

/** `lockStatus()` of `@codai/axiom-apply` — also the body of the `axiom://lock` resource. */
export const LockStatusOutput = z.object({
  held: z.boolean(),
  holder: z
    .object({
      pid: z.int(),
      host: z.string().optional(),
      digest: z.string().optional(),
      since: z.string().optional(),
      stale: z.boolean(),
    })
    .optional(),
  queue: z.array(z.object({ pid: z.int(), since: z.string() })),
  intents: z.array(
    z.object({ digest: z.string(), paths: z.array(z.string()), pid: z.int(), since: z.string() }),
  ),
});

const ChainEntryOutput = z.object({
  seq: z.int().positive(),
  manifestDigest: DigestRefSchema,
  state: z.enum(["committed", "rolled-back", "failed"]),
  at: z.string(),
  prev: DigestRefSchema,
  files: z.int().nonnegative(),
  code: z.string().optional(),
});

/** Same document as `axiom status --json` (S-706). */
export const StatusOutput = z.object({
  root: z.string(),
  lock: LockStatusOutput,
  interrupted: z.array(
    z.object({
      manifestDigest: DigestRefSchema,
      phase: JournalPhaseSchema,
      startedAt: z.string(),
      pid: z.int(),
      files: z.int().nonnegative(),
      done: z.int().nonnegative(),
    }),
  ),
  corrupt: z.array(z.string()),
  lastApplied: ChainEntryOutput.optional(),
  chain: z.object({
    ok: z.boolean(),
    entries: z.int().nonnegative(),
    head: DigestRefSchema,
    firstBad: z
      .object({ seq: z.int().positive(), reason: z.enum(["prev-mismatch", "seq-gap", "parse"]) })
      .optional(),
    missingJournals: z.int().nonnegative(),
  }),
});

export const RootsListOutput = z.object({
  roots: z.array(z.object({ path: z.string(), writable: z.boolean(), hasGit: z.boolean() })),
});

const Pos = z.object({ line: z.int().positive(), column: z.int().positive() });
export const AxmParseOutput = z.object({
  plan: PlanSchema.optional(),
  diagnostics: z.array(
    z.object({
      severity: z.enum(["error", "warning"]),
      code: ErrorCodeSchema,
      message: z.string(),
      range: z.object({ start: Pos, end: Pos }),
    }),
  ),
});

const BundleOrRef = z
  .union([DigestRefSchema, LooseObject])
  .describe(
    "A ManifestBundle object, or `sha256:<hex>` of a bundle stored under <root>/.axiom/manifests",
  );

// --- tasks + chunked plans (S-406, D-24) ------------------------------------------------------

export const TaskDescriptorOutput = z.object({
  taskId: z.string(),
  tool: z.string(),
  status: TaskStatusSchema,
  pollIntervalMs: z.int().positive(),
  ttlMs: z.int().positive(),
  elapsedMs: z.int().nonnegative(),
});

/** `axiom_task_get`: the descriptor plus, once terminal, the result or the error. */
export const TaskGetOutput = TaskDescriptorOutput.extend({
  /** Present iff `status === "completed"`; for `axiom_check` tasks a `CheckReport`. */
  result: CheckReportSchema.optional(),
  /** Present iff `status` is `failed` or `cancelled`. */
  error: TaskErrorSchema.optional(),
});

const PlanHeaderShape = {
  name: PlanSchema.shape.name,
  intent: PlanSchema.shape.intent,
  profile: PlanSchema.shape.profile.optional(),
  capabilities: PlanSchema.shape.capabilities.optional(),
  checks: PlanSchema.shape.checks.optional(),
  counter: PlanSchema.shape.counter,
  metadata: PlanSchema.shape.metadata.optional(),
};

export const PlanSessionOutput = z.object({
  sessionId: z.string(),
  artifacts: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  /** Remaining budget before `axiom_plan_add` refuses with `ERR_PLAN_SESSION_STATE`. */
  limits: z.object({ maxArtifacts: z.int().positive(), maxBytes: z.int().positive() }),
  ttlMs: z.int().positive(),
});

const SessionIdArg = z.string().min(1).describe("sessionId returned by axiom_plan_begin");
const TaskIdArg = z.string().min(1).describe("taskId returned by axiom_check_start");

// axiom_write ------------------------------------------------------------------

/** Plan name every `axiom_write` compiles under (part of the manifestDigest). */
export const WRITE_PLAN_NAME = "agent-write";
export const WRITE_FILES_MAX = 2000;

const WriteFileArg = z
  .object({
    path: RelPathSchema,
    content: z
      .string()
      .optional()
      .describe("New file content; required for op write, forbidden for op delete"),
    encoding: z
      .enum(["utf8", "base64"])
      .optional()
      .describe("Encoding of `content` (default utf8)"),
    op: z.enum(["write", "delete"]).optional().describe("write (default) or delete"),
    mode: ArtifactModeSchema.optional().describe("File mode (default 0644)"),
  })
  .strict();
type WriteFile = z.output<typeof WriteFileArg>;

/**
 * `axiom_write` output: an ApplyResult whose `status` may also be `preview` (no confirmDigest:
 * a dry-run, nothing outside .axiom/ touched), plus the pre-apply check summary and, for a
 * preview, the instruction for the confirming call.
 */
export const WriteOutput = z
  .object({
    ...ApplyResultSchema.shape,
    status: z.enum(["preview", "applied", "noop", "rolled-back", "failed"]),
    checks: z
      .object({
        verdict: z.enum(["pass", "fail", "error"]),
        profile: z.string(),
        findings: z.record(z.string(), z.int().nonnegative()),
      })
      .strict()
      .optional(),
    next: z.string().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.status === "failed" && r.error === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required when status is failed",
      });
    }
  });
type WriteOutputT = z.output<typeof WriteOutput>;

/**
 * `create` when the target is absent now, `overwrite` when it exists: rollback of a `create`
 * removes the file, while an `overwrite` without a backup would leave it behind. The choice is
 * bound by `manifest.preImage`, so a target appearing after the preview changes the digest.
 */
function writeArtifact(f: WriteFile, exists: boolean): Record<string, unknown> {
  const mode = f.mode === undefined ? {} : { mode: f.mode };
  if ((f.op ?? "write") === "delete") {
    if (f.content !== undefined) {
      throw new AxiomError("ERR_INVALID_PLAN", "content must be absent when op is delete", {
        path: f.path,
      });
    }
    return { path: f.path, op: "delete", ...mode };
  }
  if (f.content === undefined) {
    throw new AxiomError("ERR_INVALID_PLAN", "content is required unless op is delete", {
      path: f.path,
    });
  }
  return {
    path: f.path,
    op: exists ? "overwrite" : "create",
    ...mode,
    source: { type: "inline", content: f.content, encoding: f.encoding ?? "utf8" },
  };
}

/** Deterministic: same files + same tree state → same manifestDigest (pre-images are bound). */
async function compileWrite(
  files: readonly WriteFile[],
  intent: string | undefined,
  profile: string | undefined,
  rootReal: string,
): Promise<ManifestBundle> {
  const artifacts: Record<string, unknown>[] = [];
  for (const f of files) {
    const st = await lstat(path.join(rootReal, ...f.path.split("/"))).catch(() => null);
    artifacts.push(writeArtifact(f, st !== null));
  }
  const plan = {
    apiVersion: API_VERSION,
    kind: "Plan",
    name: WRITE_PLAN_NAME,
    intent: intent ?? "axiom_write",
    ...(profile === undefined ? {} : { profile }),
    artifacts,
  };
  const { bundle } = await compilePlan(plan, {
    store: "inline",
    emitters: NO_EMITTERS,
    root: rootReal,
  });
  return bundle;
}

/**
 * Idempotent re-call: `confirmDigest` was already applied, it carried exactly these artifacts
 * and the tree still holds them → the stored bundle (whose re-apply is a noop). Anything else
 * is `undefined` and the caller reports ERR_CONFIRM_DIGEST_MISMATCH.
 */
async function priorAppliedBundle(
  rootReal: string,
  confirmDigest: string,
  fresh: ManifestBundle,
): Promise<ManifestBundle | undefined> {
  const ref = DigestRefSchema.safeParse(confirmDigest);
  if (!ref.success || fresh.manifest.preImage === undefined) return undefined;
  const marker = await lstat(appliedPath(rootReal, ref.data)).catch(() => null);
  if (marker === null) return undefined;
  const prior = await loadManifest([rootReal], ref.data);
  // After the first apply a `create` target exists, so a fresh compile says `overwrite`.
  const shape = (b: ManifestBundle) =>
    JSON.stringify(
      b.manifest.artifacts.map((a) => ({ ...a, op: a.op === "create" ? "overwrite" : a.op })),
    );
  if (
    prior === undefined ||
    prior.manifest.name !== WRITE_PLAN_NAME ||
    prior.manifest.profile !== fresh.manifest.profile ||
    shape(prior) !== shape(fresh)
  ) {
    return undefined;
  }
  const target = new Map(
    fresh.manifest.artifacts.map((a) => [
      a.path,
      a.op === "delete" ? "absent" : (a.digest?.sha256 ?? ""),
    ]),
  );
  return fresh.manifest.preImage.every((p) => target.get(p.path) === p.sha256) ? prior : undefined;
}

function checksSummary(r: CheckReport | undefined): WriteOutputT["checks"] {
  if (r === undefined) return undefined;
  return {
    verdict: r.verdict,
    profile: r.profile,
    findings: countBy(r.findings, (f) => f.severity),
  };
}

// --- human confirmation (S-1206) ------------------------------------------------

/** Tool `_meta` that makes Claude Code always prompt the user before the call. */
export const HUMAN_ONLY_META: Readonly<Record<string, unknown>> = Object.freeze({
  "anthropic/requiresUserInteraction": true,
});
/** Paths listed in the elicitation message (the rest is summarised as a count). */
export const CONFIRM_PATHS_MAX = 20;
/** Hex characters of the manifestDigest the human must type. */
export const CONFIRM_DIGEST_CHARS = 12;

export type HumanConfirmReason = "declined" | "cancelled" | "mismatch" | "elicitation-unsupported";

function confirmRefused(reason: HumanConfirmReason, manifestDigest: string): never {
  throw new AxiomError("ERR_CONFIRM_DIGEST_MISMATCH", `human confirmation refused: ${reason}`, {
    details: { reason, manifestDigest },
  });
}

/** The elicitation sent before a write: digest, root, file count, ≤ 20 `op path` lines. */
export function humanConfirmRequest(
  bundle: ManifestBundle,
  rootReal: string,
): ElicitConfirmRequest {
  const hex = bundle.manifestDigest.slice("sha256:".length);
  const arts = bundle.manifest.artifacts;
  const lines = arts.slice(0, CONFIRM_PATHS_MAX).map((a) => `  ${a.op} ${a.path}`);
  if (arts.length > CONFIRM_PATHS_MAX)
    lines.push(`  … and ${arts.length - CONFIRM_PATHS_MAX} more`);
  return {
    binding: bundle.manifestDigest,
    message: [
      `AXIOM wants to write ${arts.length} file(s) under ${rootReal}`,
      `manifest ${bundle.manifestDigest}`,
      ...lines,
      `To approve, tick confirm and type the first ${CONFIRM_DIGEST_CHARS} hex characters of the digest: ${hex.slice(0, CONFIRM_DIGEST_CHARS)}`,
    ].join("\n"),
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Apply this change set",
          description: "Writes the listed files atomically (rollback with axiom_rollback)",
        },
        digest12: {
          type: "string",
          title: `First ${CONFIRM_DIGEST_CHARS} hex characters of the manifest digest`,
          minLength: CONFIRM_DIGEST_CHARS,
          maxLength: CONFIRM_DIGEST_CHARS,
        },
      },
      required: ["confirm", "digest12"],
    },
  };
}

/**
 * S-1206 gate in front of every apply: when the client can elicit, a human must accept with
 * `confirm: true` and the digest's first 12 hex chars; without elicitation the confirmDigest
 * echo stands alone unless `--require-human`. Refusals are ERR_CONFIRM_DIGEST_MISMATCH with
 * `details.reason`. An `ElicitPending` from the seam propagates (wrapHandler returns it).
 */
async function requireHumanConfirm(
  ctx: ToolContext,
  bundle: ManifestBundle,
  rootReal: string,
): Promise<void> {
  const answer =
    ctx.elicit === undefined
      ? ({ action: "unsupported" } as const)
      : await ctx.elicit(humanConfirmRequest(bundle, rootReal));
  switch (answer.action) {
    case "unsupported":
      if (ctx.requireHuman === true)
        confirmRefused("elicitation-unsupported", bundle.manifestDigest);
      return;
    case "decline":
      confirmRefused("declined", bundle.manifestDigest);
      break;
    case "cancel":
      confirmRefused("cancelled", bundle.manifestDigest);
      break;
    case "accept": {
      const content = answer.content ?? {};
      if (content.confirm === false) confirmRefused("declined", bundle.manifestDigest);
      const want = bundle.manifestDigest.slice(7, 7 + CONFIRM_DIGEST_CHARS);
      const typed =
        typeof content.digest12 === "string" ? content.digest12.trim().toLowerCase() : "";
      if (content.confirm !== true || typed !== want)
        confirmRefused("mismatch", bundle.manifestDigest);
      ctx.log.info("human confirmed", { manifestDigest: bundle.manifestDigest });
      return;
    }
  }
}

// --- tool definitions -----------------------------------------------------------

export const TOOL_DEFS: readonly AnyToolDef[] = [
  defineTool({
    name: "axiom_plan_validate",
    title: "Validate a Plan",
    description:
      "Validate a Plan against PlanSchema and, when all sources are inline, compute its planDigest. Read-only; touches no files.",
    inputSchema: {
      plan: LooseObject.describe(
        "Plan document (apiVersion axiom.codai.ro/v3 or axiom.dev/v2, kind Plan)",
      ),
    },
    outputSchema: PlanValidateOutput,
    annotations: READ,
    async handler(ctx, { plan }) {
      guardPayloadSize("plan", plan);
      const parsed = PlanSchema.safeParse(plan);
      if (!parsed.success) {
        return {
          ok: false,
          errors: parsed.error.issues.map((i) => {
            const code = (i as { params?: { code?: unknown } }).params?.code;
            const out: z.output<typeof IssueSchema> = {
              path: i.path.map(String).join("."),
              message: i.message,
            };
            if (typeof code === "string") out.code = code;
            return out;
          }),
        };
      }
      try {
        const { bundle } = await withEmitterHint(
          compilePlan(parsed.data, { store: "inline", emitters: ctx.emitters ?? NO_EMITTERS }),
        );
        return { ok: true, planDigest: bundle.manifest.planDigest, errors: [] };
      } catch (err) {
        if (err instanceof AxiomError && err.code === "ERR_BLOB_MISSING")
          return { ok: true, errors: [] };
        throw err;
      }
    },
    summarize: (o) => ({
      ok: o.ok,
      planDigest: o.planDigest,
      errors: o.errors.slice(0, SUMMARY_LIST_MAX),
    }),
  }),

  defineTool({
    name: "axiom_plan_compile",
    title: "Compile a Plan into a ManifestBundle",
    description:
      "Compile a Plan into a content-addressed ManifestBundle (sorted artifacts, sha256 digests, in-toto planDigest). `store: cas` writes blobs under <root>/.axiom/cas instead of inlining them. When a root is given the bundle is stored under <root>/.axiom/manifests/<hex>.json so later tools can reference it by digest. `template` sources need an emitter package loaded with `axiom mcp --emitter <pkg>` (e.g. @codai/axiom-emitters-web); its version is recorded in toolchain.emitters.",
    inputSchema: {
      plan: LooseObject.describe("Plan document"),
      store: z.enum(["inline", "cas"]).optional().describe("Blob transport; default inline"),
      root: RootArg,
    },
    outputSchema: ManifestBundleSchema,
    annotations: ACT,
    async handler(ctx, { plan, store, root }) {
      guardPayloadSize("plan", plan);
      return compileToBundle(ctx, plan, store, root);
    },
    summarize: summarizeBundle,
  }),

  defineTool({
    name: "axiom_manifest_verify",
    title: "Verify a ManifestBundle",
    description:
      "Structural and content-address verification: schema, recomputed manifestDigest, every inline blob hashes to its key, attestation subject matches. When a root with .axiom/trust/keys.json is available, detached DSSE signatures are verified and the trusted keyids are reported under `signatures`. Never writes.",
    inputSchema: { bundle: LooseObject.describe("ManifestBundle"), root: RootArg },
    outputSchema: ManifestVerifyOutput,
    annotations: READ,
    async handler(ctx, { bundle, root }) {
      guardPayloadSize("bundle", bundle);
      const r = verifyBundle(bundle);
      const out: z.output<typeof ManifestVerifyOutput> = {
        ok: r.ok,
        canonical: r.canonical,
        signed: r.signed,
        missing: r.missing,
        errors: r.errors,
      };
      if (r.manifestDigest !== undefined) out.manifestDigest = r.manifestDigest;
      if (r.ok) {
        const rootReal = await optionalRoot(ctx, root);
        if (rootReal !== undefined) {
          const sig = await verifyBundleAgainstRoot(rootReal, parseBundle(bundle));
          if (sig !== undefined) {
            out.signatures = sig;
            out.signed = sig.keyids.length > 0;
            if (!sig.ok) out.ok = false;
          }
        }
      }
      return out;
    },
    summarize: (o) => ({
      ok: o.ok,
      manifestDigest: o.manifestDigest,
      canonical: o.canonical,
      signed: o.signed,
      keyids: o.signatures?.keyids,
      missing: o.missing.length,
      errors: o.errors.slice(0, SUMMARY_LIST_MAX),
    }),
  }),

  defineTool({
    name: "axiom_check",
    title: "Run policy checks on a bundle",
    description:
      "Evaluate the profile's predicates (plus the manifest's own checks) against the bundle. Repo facts are read from the root when one is available and the profile allows it. Verdict `error` means a provider could not run — never a silent pass.",
    inputSchema: {
      bundle: LooseObject.describe("ManifestBundle"),
      profile: ProfileArg,
      root: RootArg,
    },
    outputSchema: CheckReportSchema,
    annotations: READ,
    async handler(ctx, { bundle, profile, root }) {
      const parsed = parseBundle(bundle);
      const rootReal = await optionalRoot(ctx, root);
      return checkBundle(ctx, parsed, profile, rootReal);
    },
    summarize: summarizeReport,
  }),

  defineTool({
    name: "axiom_check_start",
    title: "Start policy checks as a background task",
    description:
      "Same evaluation as axiom_check, but returned immediately as a task so long `guard.external` suites (up to 15 min per guard) outlive the client's per-call timeout. Poll axiom_task_get with the returned taskId every pollIntervalMs until status is completed|failed|cancelled; the CheckReport is in `result`. Finished tasks are pollable for ttlMs, then forgotten. Tasks live in this server process only (D-24 — tool-level tasks, not the io.modelcontextprotocol/tasks wire extension).",
    inputSchema: {
      bundle: LooseObject.describe("ManifestBundle"),
      profile: ProfileArg,
      root: RootArg,
    },
    outputSchema: TaskDescriptorOutput,
    annotations: READ,
    async handler(ctx, { bundle, profile, root }) {
      // Validate synchronously so a malformed bundle / disallowed root is an immediate error,
      // not a task that fails two seconds later.
      const parsed = parseBundle(bundle);
      const rootReal = await optionalRoot(ctx, root);
      const meta: { root?: string } = {};
      if (rootReal !== undefined) meta.root = rootReal;
      const rec = ctx.tasks.start(
        "axiom_check",
        (signal) => checkBundle(ctx, parsed, profile, rootReal, signal),
        meta,
      );
      ctx.log.info("task started", {
        taskId: rec.taskId,
        manifestDigest: parsed.manifestDigest,
        root: rootReal,
      });
      return ctx.tasks.describe(rec);
    },
    summarize: (o) => o,
  }),

  defineTool({
    name: "axiom_task_get",
    title: "Poll a task",
    description:
      "Status of a task created by axiom_check_start. While `working` only the descriptor is returned; once terminal, `result` (completed) or `error` (failed|cancelled) is attached. Unknown or expired taskId → ERR_TASK_NOT_FOUND.",
    inputSchema: { taskId: TaskIdArg },
    outputSchema: TaskGetOutput,
    annotations: READ,
    async handler(ctx, { taskId }) {
      const rec = ctx.tasks.get(taskId);
      const out: z.output<typeof TaskGetOutput> = ctx.tasks.describe(rec);
      if (rec.status === "completed") out.result = CheckReportSchema.parse(rec.result);
      else if (rec.error !== undefined) out.error = rec.error;
      return out;
    },
    summarize: (o) => ({
      taskId: o.taskId,
      status: o.status,
      elapsedMs: o.elapsedMs,
      pollIntervalMs: o.pollIntervalMs,
      result: o.result === undefined ? undefined : summarizeReport(o.result),
      error: o.error,
    }),
  }),

  defineTool({
    name: "axiom_task_cancel",
    title: "Cancel a task",
    description:
      "Abort a `working` task: every running guard process tree is killed and the task ends `cancelled` with error ERR_TASK_CANCELLED. Idempotent — a terminal task is returned unchanged.",
    inputSchema: { taskId: TaskIdArg },
    outputSchema: TaskDescriptorOutput,
    annotations: ACT,
    async handler(ctx, { taskId }) {
      const rec = ctx.tasks.cancel(taskId);
      ctx.log.info("task cancelled", { taskId, status: rec.status });
      return ctx.tasks.describe(rec);
    },
    summarize: (o) => o,
  }),

  defineTool({
    name: "axiom_plan_begin",
    title: "Open a chunked plan session",
    description:
      "Start assembling a Plan whose JSON would exceed the 4 MiB per-call cap: send the header here (everything except `artifacts`), append artifacts in chunks with axiom_plan_add, then axiom_plan_seal compiles the whole. The sealed bundle's manifestDigest is identical to a one-shot axiom_plan_compile of the same Plan. Sessions are in-memory, expire after 30 min idle, and hold at most 2000 artifacts / 64 MiB.",
    inputSchema: PlanHeaderShape,
    outputSchema: PlanSessionOutput,
    annotations: ACT,
    async handler(ctx, header) {
      const s = ctx.planSessions.begin(header);
      ctx.log.debug("plan session opened", { sessionId: s.sessionId, name: header.name });
      return describeSession(ctx.planSessions, s);
    },
    summarize: (o) => o,
  }),

  defineTool({
    name: "axiom_plan_add",
    title: "Append artifacts to a plan session",
    description:
      "Add a chunk of Plan artifacts (each ≤ 4 MiB call, inline content ≤ 256 KiB per artifact as in a Plan) to an open session. Paths must be unique across every chunk (ERR_INVALID_PLAN otherwise); a sealed or over-budget session is ERR_PLAN_SESSION_STATE.",
    inputSchema: {
      sessionId: SessionIdArg,
      artifacts: z
        .array(LooseObject)
        .min(1)
        .describe("Plan artifacts, same shape as Plan.artifacts[]"),
    },
    outputSchema: PlanSessionOutput,
    annotations: ACT,
    async handler(ctx, { sessionId, artifacts }) {
      guardPayloadSize("artifacts", artifacts);
      const parsed = z.array(PlanArtifactSchema).safeParse(artifacts);
      if (!parsed.success) {
        throw new AxiomError("ERR_INVALID_PLAN", "artifacts do not match PlanArtifactSchema", {
          details: {
            issues: parsed.error.issues
              .slice(0, SUMMARY_LIST_MAX)
              .map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
          },
        });
      }
      const bytes = Buffer.byteLength(JSON.stringify(artifacts), "utf8");
      const s = ctx.planSessions.add(sessionId, parsed.data, bytes);
      return describeSession(ctx.planSessions, s);
    },
    summarize: (o) => o,
  }),

  defineTool({
    name: "axiom_plan_seal",
    title: "Seal a plan session and compile it",
    description:
      "Assemble the session's header + every added artifact into one Plan and compile it exactly like axiom_plan_compile (same options, same digest). The session is consumed whether or not compilation succeeds. Bundles whose inline blobs exceed 4 MiB need `store: cas` (and therefore a root).",
    inputSchema: {
      sessionId: SessionIdArg,
      store: z.enum(["inline", "cas"]).optional().describe("Blob transport; default inline"),
      root: RootArg,
    },
    outputSchema: ManifestBundleSchema,
    annotations: ACT,
    async handler(ctx, { sessionId, store, root }) {
      const { plan, session } = ctx.planSessions.seal(sessionId);
      const bundle = await compileToBundle(ctx, plan, store, root);
      ctx.log.info("plan session sealed", {
        sessionId,
        artifacts: session.artifacts.length,
        manifestDigest: bundle.manifestDigest,
      });
      return bundle;
    },
    summarize: summarizeBundle,
  }),

  defineTool({
    name: "axiom_apply_dry_run",
    title: "Dry-run apply (stage + diff, no writes to the tree)",
    description:
      "Stage the bundle under <root>/.axiom/staging, run pre-apply checks and produce a unified diff against the current tree. Nothing outside .axiom/ is touched. Echo the returned manifestDigest as `confirmDigest` to axiom_apply.",
    inputSchema: {
      bundle: LooseObject.describe("ManifestBundle"),
      root: RootArg,
      profile: ProfileArg,
    },
    outputSchema: ApplyResultSchema,
    annotations: READ,
    async handler(ctx, { bundle, root, profile }) {
      const parsed = parseBundle(bundle);
      const { rootReal } = await resolveRoot(ctx.policy, root);
      const result = await apply({
        bundle: parsed,
        root: rootReal,
        mode: "dry-run",
        preChecks: () => checkBundle(ctx, parsed, profile, rootReal),
      });
      return result;
    },
    summarize: summarizeApply,
  }),

  defineTool({
    name: "axiom_apply",
    title: "Apply a bundle to the filesystem (two-phase commit)",
    description:
      "Transactionally write the bundle into the root: pre-image verification, staging, journal, atomic renames, scoped rollback on failure. Requires `confirmDigest === bundle.manifestDigest` (echo the digest you saw in dry-run); when the client supports elicitation the user must also confirm by typing the digest's first 12 hex characters. Idempotent: re-applying an applied digest is a no-op.",
    inputSchema: {
      bundle: LooseObject.describe("ManifestBundle"),
      root: RootArg,
      profile: ProfileArg,
      confirmDigest: z.string().optional().describe("Must equal bundle.manifestDigest"),
      mode: z
        .enum(["fs", "pr"])
        .optional()
        .describe(
          "fs (default) writes files; pr additionally creates a git branch and commits exactly the touched paths (no push, no PR creation)",
        ),
      branch: z
        .string()
        .optional()
        .describe("pr mode: branch name (default axiom/<name>/<digest12>)"),
      commitMessage: z
        .string()
        .optional()
        .describe("pr mode: commit message (passed to git on stdin)"),
      lockTimeoutMs: z
        .int()
        .min(0)
        .max(600_000)
        .optional()
        .describe(
          "How long to wait in the root's lock queue (ms); timeout → ERR_LOCKED with details { holder, waitedMs, queuePosition }",
        ),
      keepBackups: z
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe("Pre-image backup sets kept under .axiom/backup after commit (default 3)"),
    },
    outputSchema: ApplyResultSchema,
    annotations: WRITE,
    meta: HUMAN_ONLY_META,
    async handler(
      ctx,
      {
        bundle,
        root,
        profile,
        confirmDigest,
        mode,
        branch,
        commitMessage,
        lockTimeoutMs,
        keepBackups,
      },
    ) {
      const parsed = parseBundle(bundle);
      if (confirmDigest !== parsed.manifestDigest) {
        throw new AxiomError(
          "ERR_CONFIRM_DIGEST_MISMATCH",
          "confirmDigest must equal bundle.manifestDigest",
          {
            details: {
              confirmDigest: confirmDigest ?? null,
              manifestDigest: parsed.manifestDigest,
            },
          },
        );
      }
      const { rootReal } = await resolveRoot(ctx.policy, root);
      await requireHumanConfirm(ctx, parsed, rootReal);
      const profileDoc = await profileFor(ctx, parsed, profile, rootReal);
      const result = await apply({
        bundle: parsed,
        root: rootReal,
        mode: mode ?? "fs",
        confirmDigest,
        ...(branch === undefined ? {} : { branch }),
        ...(commitMessage === undefined ? {} : { commitMessage }),
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
        ...(keepBackups === undefined ? {} : { keepBackups }),
        preChecks: () => checkBundle(ctx, parsed, profile, rootReal),
      });
      if (result.status === "applied" || result.status === "noop") {
        await saveManifest(rootReal, parsed);
        ctx.seenRoots.add(rootReal);
      }
      if (
        result.status === "applied" &&
        profileWantsAntiRollback([...profileDoc.checks, ...parsed.manifest.checks])
      ) {
        await advanceTrustState(rootReal, parsed);
      }
      ctx.log.info("apply", {
        manifestDigest: parsed.manifestDigest,
        status: result.status,
        root: rootReal,
      });
      return result;
    },
    summarize: summarizeApply,
  }),

  defineTool({
    name: "axiom_write",
    title: "Write files through the gate (preview, then confirm)",
    description:
      "One-tool transactional write: send the files you want written/deleted. Without confirmDigest it compiles them against the current tree, runs the pre-apply checks and returns status `preview` with the manifestDigest and a unified diff (nothing outside .axiom/ touched). Call again with the SAME files, intent and profile plus confirmDigest=<manifestDigest> to apply atomically (when the client supports elicitation the user confirms first): pre-image verification, journal, two-phase commit, one-step rollback via axiom_rollback. If any target changed since the preview the digest changes → ERR_CONFIRM_DIGEST_MISMATCH (re-preview). Prefer it over plain file writes for multi-file or sensitive changes.",
    inputSchema: {
      root: RootArg,
      files: z
        .array(WriteFileArg)
        .min(1)
        .max(WRITE_FILES_MAX)
        .describe("Files to write (whole new content) or delete; paths are relative POSIX"),
      intent: z.string().max(2000).optional().describe("Why — recorded in the Plan"),
      profile: ProfileArg,
      confirmDigest: z
        .string()
        .optional()
        .describe("Absent → preview; the manifestDigest returned by the preview → apply"),
      lockTimeoutMs: z
        .int()
        .min(0)
        .max(600_000)
        .optional()
        .describe(
          "How long to wait in the root's lock queue (ms); timeout → ERR_LOCKED with details { holder, waitedMs, queuePosition }",
        ),
      keepBackups: z
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe("Pre-image backup sets kept under .axiom/backup after commit (default 3)"),
    },
    outputSchema: WriteOutput,
    annotations: WRITE,
    meta: HUMAN_ONLY_META,
    async handler(
      ctx,
      { root, files, intent, profile, confirmDigest, lockTimeoutMs, keepBackups },
    ): Promise<WriteOutputT> {
      guardPayloadSize("files", files);
      const { rootReal } = await resolveRoot(ctx.policy, root);
      const fresh = await compileWrite(files, intent, profile, rootReal);
      let report: CheckReport | undefined;
      const preChecks = async (b: ManifestBundle) => {
        report = await checkBundle(ctx, b, profile, rootReal);
        return report;
      };

      if (confirmDigest === undefined) {
        const dry = await apply({
          bundle: fresh,
          root: rootReal,
          mode: "dry-run",
          ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
          preChecks: () => preChecks(fresh),
        });
        await saveManifest(rootReal, fresh);
        ctx.seenRoots.add(rootReal);
        const checks = checksSummary(report);
        if (dry.status !== "applied") return { ...dry, ...(checks ? { checks } : {}) };
        return {
          ...dry,
          status: "preview",
          ...(checks ? { checks } : {}),
          next: `call axiom_write again with the same files, intent and profile and confirmDigest=${fresh.manifestDigest}`,
        };
      }

      const bundle =
        confirmDigest === fresh.manifestDigest
          ? fresh
          : await priorAppliedBundle(rootReal, confirmDigest, fresh);
      if (bundle === undefined) {
        throw new AxiomError(
          "ERR_CONFIRM_DIGEST_MISMATCH",
          "confirmDigest does not match these files against the current tree; preview again",
          { details: { confirmDigest, manifestDigest: fresh.manifestDigest } },
        );
      }
      await requireHumanConfirm(ctx, bundle, rootReal);
      const profileDoc = await profileFor(ctx, bundle, profile, rootReal);
      const result = await apply({
        bundle,
        root: rootReal,
        mode: "fs",
        confirmDigest: bundle.manifestDigest,
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
        ...(keepBackups === undefined ? {} : { keepBackups }),
        preChecks: () => preChecks(bundle),
      });
      if (result.status === "applied" || result.status === "noop") {
        await saveManifest(rootReal, bundle);
        ctx.seenRoots.add(rootReal);
      }
      if (
        result.status === "applied" &&
        profileWantsAntiRollback([...profileDoc.checks, ...bundle.manifest.checks])
      ) {
        await advanceTrustState(rootReal, bundle);
      }
      ctx.log.info("write", {
        manifestDigest: bundle.manifestDigest,
        status: result.status,
        root: rootReal,
        files: files.length,
      });
      const checks = checksSummary(report);
      return { ...result, ...(checks ? { checks } : {}) };
    },
    summarize: (o) => ({
      ...(summarizeApply({ ...o, status: o.status === "preview" ? "applied" : o.status }) as Record<
        string,
        unknown
      >),
      status: o.status,
      checks: o.checks,
      next: o.next,
    }),
  }),

  defineTool({
    name: "axiom_rollback",
    title: "Roll back an applied manifest",
    description:
      "Replay the journal of a committed/committing manifest in reverse: restore backups, remove created files, drop the applied marker.",
    inputSchema: {
      root: RootArg,
      manifestDigest: z
        .string()
        .describe("`sha256:<hex>` (or bare hex) of the manifest to roll back"),
    },
    outputSchema: RollbackOutput,
    annotations: WRITE,
    async handler(ctx, { root, manifestDigest }) {
      const ref = toDigestRef(manifestDigest);
      const { rootReal } = await resolveRoot(ctx.policy, root);
      const journal = await rollback(rootReal, ref);
      ctx.log.info("rollback", { manifestDigest: ref, root: rootReal, phase: journal.phase });
      return {
        manifestDigest: ref,
        status: "rolled-back" as const,
        phase: journal.phase,
        steps: journal.steps.length,
        root: rootReal,
      };
    },
    summarize: (o) => o,
  }),

  defineTool({
    name: "axiom_manifest_diff",
    title: "Diff two manifests",
    description:
      "Compare two manifests by artifact path and digest. Each side is a ManifestBundle or a `sha256:<hex>` reference to a bundle stored under an allowlisted root.",
    inputSchema: { a: BundleOrRef, b: BundleOrRef },
    outputSchema: ManifestDiffOutput,
    annotations: READ,
    async handler(ctx, { a, b }) {
      const [ba, bb] = await Promise.all([
        resolveBundleOrRef(ctx, a, "a"),
        resolveBundleOrRef(ctx, b, "b"),
      ]);
      return diffManifests(ba.manifest, bb.manifest);
    },
    summarize: (d) => ({
      added: d.added.length,
      removed: d.removed.length,
      changed: d.changed.length,
      sample: {
        added: d.added.slice(0, SUMMARY_LIST_MAX),
        removed: d.removed.slice(0, SUMMARY_LIST_MAX),
        changed: d.changed.slice(0, SUMMARY_LIST_MAX),
      },
    }),
  }),

  defineTool({
    name: "axiom_axm_parse",
    title: "Parse .axm source into a Plan",
    description:
      "Parse .axm v2 text into a Plan with 1-based {line, column} diagnostics; `plan` is present only when error-free. Read-only.",
    inputSchema: {
      source: z.string().describe(".axm source text"),
    },
    outputSchema: AxmParseOutput,
    annotations: READ,
    async handler(_ctx, { source }) {
      guardPayloadSize("source", source);
      const { parseAxm } = await import("./axm-lazy.js"); // lazy chunk (chevrotain)
      const r = parseAxm(source);
      return r.plan === undefined ? { diagnostics: r.diagnostics } : r;
    },
    summarize: (o) => ({
      ok: o.plan !== undefined,
      name: o.plan?.name,
      diagnostics: o.diagnostics.slice(0, SUMMARY_LIST_MAX),
    }),
  }),

  defineTool({
    name: "axiom_roots_list",
    title: "List allowlisted roots",
    description:
      "The frozen set of roots this server may read and write, as given by --root at startup.",
    inputSchema: {},
    outputSchema: RootsListOutput,
    annotations: READ,
    async handler(ctx) {
      const roots = [];
      for (const p of ctx.policy.roots) {
        const [writable, hasGit] = await Promise.all([
          access(p, constants.W_OK).then(
            () => true,
            () => false,
          ),
          stat(path.join(p, ".git")).then(
            () => true,
            () => false,
          ),
        ]);
        roots.push({ path: p, writable, hasGit });
      }
      return { roots };
    },
    summarize: (o) => o,
  }),
  defineTool({
    name: "axiom_status",
    title: "Write state of a root",
    description:
      "Read-only snapshot of a root's write state, same as `axiom status --json`: who holds .axiom/lock (pid, host, digest, since, stale), the wait queue, registered in-flight intents (paths), interrupted journals that need `axiom_rollback`, the last applied chain entry and whether the journal hash chain verifies. Never takes the lock.",
    inputSchema: { root: RootArg },
    outputSchema: StatusOutput,
    annotations: READ,
    async handler(ctx, { root }) {
      const { rootReal } = await resolveRoot(ctx.policy, root);
      return collectStatus(rootReal);
    },
    summarize: (o) => ({
      root: o.root,
      held: o.lock.held,
      holder: o.lock.holder,
      queue: o.lock.queue.length,
      intents: o.lock.intents.length,
      interrupted: o.interrupted.length,
      lastApplied: o.lastApplied?.manifestDigest,
      chainOk: o.chain.ok,
    }),
  }),
  defineTool({
    name: "axiom_repo_snapshot",
    title: "Snapshot a root",
    description:
      "Deterministic, content-addressed inventory of a root: every regular file (and symlink) as { path, bytes, sha256, mode, kind }, sorted by code point, with snapshotDigest = sha256(JCS(body)). No timestamps, no absolute paths — the same tree gives the same digest on every machine. Honours the root .gitignore, always skips .git/ and .axiom/, never follows symlinks, never leaves the root. Use it to build Plans against real pre-image digests, or diff two snapshots with `axiom snapshot-diff`.",
    inputSchema: {
      root: RootArg,
      include: z
        .array(z.string().min(1))
        .optional()
        .describe("Relative globs (*, **, ?) to keep; default everything"),
      exclude: z.array(z.string().min(1)).optional().describe("Relative globs to drop"),
      maxFiles: z
        .int()
        .min(1)
        .max(SNAPSHOT_MAX_FILES_CAP)
        .default(SNAPSHOT_MAX_FILES_DEFAULT)
        .describe(`Stop after this many files (cap ${SNAPSHOT_MAX_FILES_CAP}); sets truncated`),
      maxBytes: z
        .int()
        .nonnegative()
        .default(SNAPSHOT_MAX_BYTES_DEFAULT)
        .describe("Stop once the summed size would exceed this; sets truncated"),
      followSymlinks: z
        .literal(false)
        .default(false)
        .describe("Always false; symlinks are recorded, never followed"),
      respectGitignore: z.boolean().default(true),
      withContentDigest: z.boolean().default(true).describe("false → sizes only, no sha256"),
    },
    outputSchema: RepoSnapshotSchema,
    annotations: READ,
    async handler(ctx, input) {
      const { rootReal } = await resolveRoot(ctx.policy, input.root);
      const opts: Parameters<typeof snapshotRoot>[1] = {
        maxFiles: input.maxFiles,
        maxBytes: input.maxBytes,
        respectGitignore: input.respectGitignore,
        withContentDigest: input.withContentDigest,
      };
      if (input.include !== undefined) opts.include = input.include;
      if (input.exclude !== undefined) opts.exclude = input.exclude;
      const snap = await snapshotRoot(rootReal, opts);
      ctx.log.debug("snapshot", { root: rootReal, files: snap.body.counts.files });
      return snap;
    },
    summarize: (o) => ({
      snapshotDigest: o.snapshotDigest,
      counts: o.body.counts,
      truncated: o.body.truncated,
      paths: o.body.files.slice(0, SUMMARY_LIST_MAX).map((f) => f.path),
    }),
  }),
];

async function resolveBundleOrRef(
  ctx: ToolContext,
  v: unknown,
  label: string,
): Promise<ManifestBundle> {
  if (typeof v === "string") {
    const ref: DigestRef = toDigestRef(v);
    const found = await loadManifest(new Set([...ctx.policy.roots, ...ctx.seenRoots]), ref);
    if (found === undefined) {
      throw new AxiomError("ERR_NOT_FOUND", `${label}: no stored manifest for ${ref}`, {
        details: { ref },
      });
    }
    return found;
  }
  return parseBundle(v);
}

/** Shared by `axiom_plan_compile` and `axiom_plan_seal` so both produce byte-identical bundles. */
async function compileToBundle(
  ctx: ToolContext,
  plan: unknown,
  store: "inline" | "cas" | undefined,
  root: string | undefined,
): Promise<ManifestBundle> {
  const wantsRoot = root !== undefined || store === "cas";
  const rootReal = wantsRoot ? (await resolveRoot(ctx.policy, root)).rootReal : undefined;
  const opts: Parameters<typeof compilePlan>[1] = {
    store: store ?? "inline",
    emitters: ctx.emitters ?? NO_EMITTERS,
  };
  if (rootReal !== undefined) opts.root = rootReal;
  const { bundle } = await withEmitterHint(compilePlan(plan, opts));
  if (rootReal !== undefined) {
    await saveManifest(rootReal, bundle);
    ctx.seenRoots.add(rootReal);
  }
  ctx.log.info("compiled", {
    manifestDigest: bundle.manifestDigest,
    artifacts: bundle.manifest.artifacts.length,
  });
  return bundle;
}

function summarizeBundle(b: ManifestBundle): unknown {
  return {
    manifestDigest: b.manifestDigest,
    planDigest: b.manifest.planDigest,
    name: b.manifest.name,
    profile: b.manifest.profile,
    artifacts: b.manifest.artifacts.length,
    blobs: Object.keys(b.blobs).length,
  };
}

function describeSession(
  store: PlanSessionStore,
  s: { sessionId: string; artifacts: readonly unknown[]; bytes: number },
): z.output<typeof PlanSessionOutput> {
  return {
    sessionId: s.sessionId,
    artifacts: s.artifacts.length,
    bytes: s.bytes,
    limits: { maxArtifacts: store.maxArtifacts, maxBytes: store.maxBytes },
    ttlMs: store.ttlMs,
  };
}

function summarizeReport(r: CheckReport): unknown {
  return {
    manifestDigest: r.manifestDigest,
    profile: r.profile,
    verdict: r.verdict,
    counts: countBy(r.findings, (f) => f.severity),
    findings: r.findings
      .slice(0, SUMMARY_LIST_MAX)
      .map((f) => ({ id: f.id, severity: f.severity, message: f.message, path: f.path })),
    providers: r.providers,
    durationMs: r.durationMs,
  };
}

function summarizeApply(r: z.output<typeof ApplyResultSchema>): unknown {
  return {
    manifestDigest: r.manifestDigest,
    mode: r.mode,
    status: r.status,
    root: r.root,
    files: countBy(r.files, (f) => f.status),
    diffBytes: r.diff === undefined ? undefined : Buffer.byteLength(r.diff, "utf8"),
    journal: r.journal,
    error: r.error,
    sample: r.files
      .slice(0, SUMMARY_LIST_MAX)
      .map((f) => ({ path: f.path, op: f.op, status: f.status })),
  };
}

export function toolByName(name: string): AnyToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}

/** Registry slice served for a toolset, in registry order. */
export function toolsFor(toolset: Toolset): readonly AnyToolDef[] {
  return toolset === "full" ? TOOL_DEFS : TOOL_DEFS.filter((t) => CORE_TOOL_NAMES.includes(t.name));
}
