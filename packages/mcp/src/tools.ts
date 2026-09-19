import { access, constants, stat } from "node:fs/promises";
import * as path from "node:path";
import { apply, rollback } from "@codai/axiom-apply";
import { type GuardOptions, loadProfile, runChecks } from "@codai/axiom-checks";
import { compilePlan, diffManifests, verifyBundle } from "@codai/axiom-plan";
import {
  ApplyResultSchema,
  AxiomError,
  type CheckReport,
  CheckReportSchema,
  type DigestRef,
  DigestRefSchema,
  ErrorCodeSchema,
  JournalPhaseSchema,
  type ManifestBundle,
  ManifestBundleSchema,
  PlanSchema,
  RepoSnapshotSchema,
} from "@codai/axiom-schema";
import { z } from "zod";
import { EMITTERS } from "./emitters.js";
import { advanceTrustState, profileWantsAntiRollback, verifyBundleAgainstRoot } from "./keys.js";
import type { Logger } from "./log.js";
import { type RootsPolicy, resolveRoot } from "./roots.js";
import {
  SNAPSHOT_MAX_BYTES_DEFAULT,
  SNAPSHOT_MAX_FILES_CAP,
  SNAPSHOT_MAX_FILES_DEFAULT,
  snapshotRoot,
} from "./snapshot.js";
import { loadManifest, saveManifest, saveReport, toDigestRef } from "./store.js";

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
}

export interface ToolDef<I extends z.ZodRawShape = z.ZodRawShape, O extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations: ToolAnnotations;
  riskClass: RiskClass;
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
): Promise<CheckReport> {
  const profile = await profileFor(ctx, bundle, profileName, rootReal);
  const opts: Parameters<typeof runChecks>[0] = {
    bundle,
    profile,
    checks: bundle.manifest.checks,
    ...ctx.guards,
  };
  if (rootReal !== undefined) {
    opts.root = rootReal;
    opts.casDir = path.join(rootReal, ".axiom", "cas");
  }
  const report = await runChecks(opts);
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

// --- tool definitions -----------------------------------------------------------

export const TOOL_DEFS: readonly AnyToolDef[] = [
  defineTool({
    name: "axiom_plan_validate",
    title: "Validate a Plan",
    description:
      "Validate a Plan against PlanSchema and, when all sources are inline, compute its planDigest. Read-only; touches no files.",
    inputSchema: {
      plan: LooseObject.describe("Plan document (apiVersion axiom.dev/v2, kind Plan)"),
    },
    outputSchema: PlanValidateOutput,
    annotations: READ,
    async handler(_ctx, { plan }) {
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
        const { bundle } = await compilePlan(parsed.data, {
          store: "inline",
          emitters: EMITTERS,
        });
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
      "Compile a Plan into a content-addressed ManifestBundle (sorted artifacts, sha256 digests, in-toto planDigest). `store: cas` writes blobs under <root>/.axiom/cas instead of inlining them. When a root is given the bundle is stored under <root>/.axiom/manifests/<hex>.json so later tools can reference it by digest. `template` sources are rendered by the built-in `web` emitter (see `axiom emitters`); its version is recorded in toolchain.emitters.",
    inputSchema: {
      plan: LooseObject.describe("Plan document"),
      store: z.enum(["inline", "cas"]).optional().describe("Blob transport; default inline"),
      root: RootArg,
    },
    outputSchema: ManifestBundleSchema,
    annotations: ACT,
    async handler(ctx, { plan, store, root }) {
      guardPayloadSize("plan", plan);
      const wantsRoot = root !== undefined || store === "cas";
      const rootReal = wantsRoot ? (await resolveRoot(ctx.policy, root)).rootReal : undefined;
      const opts: Parameters<typeof compilePlan>[1] = {
        store: store ?? "inline",
        emitters: EMITTERS,
      };
      if (rootReal !== undefined) opts.root = rootReal;
      const { bundle } = await compilePlan(plan, opts);
      if (rootReal !== undefined) {
        await saveManifest(rootReal, bundle);
        ctx.seenRoots.add(rootReal);
      }
      ctx.log.info("compiled", {
        manifestDigest: bundle.manifestDigest,
        artifacts: bundle.manifest.artifacts.length,
      });
      return bundle;
    },
    summarize: (b) => ({
      manifestDigest: b.manifestDigest,
      planDigest: b.manifest.planDigest,
      name: b.manifest.name,
      profile: b.manifest.profile,
      artifacts: b.manifest.artifacts.length,
      blobs: Object.keys(b.blobs).length,
    }),
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
      "Transactionally write the bundle into the root: pre-image verification, staging, journal, atomic renames, scoped rollback on failure. Requires `confirmDigest === bundle.manifestDigest` (echo the digest you saw in dry-run). Idempotent: re-applying an applied digest is a no-op.",
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
    },
    outputSchema: ApplyResultSchema,
    annotations: WRITE,
    async handler(ctx, { bundle, root, profile, confirmDigest, mode, branch, commitMessage }) {
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
      const profileDoc = await profileFor(ctx, parsed, profile, rootReal);
      const result = await apply({
        bundle: parsed,
        root: rootReal,
        mode: mode ?? "fs",
        confirmDigest,
        ...(branch === undefined ? {} : { branch }),
        ...(commitMessage === undefined ? {} : { commitMessage }),
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
