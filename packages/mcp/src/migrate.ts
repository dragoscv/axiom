/**
 * `axiom migrate v1` — lift an AXIOM v1 (1.0.x) `manifest.json` into a v2 `Plan` (S-305).
 *
 * v1 manifests carry `artifacts[].{path, kind, sha256, bytes, contentUtf8?, contentBase64?}` plus
 * `buildId`, `irHash`, `profile`, `evidence[]` and `createdAt`. v2 recomputes every digest and
 * hashes no timestamps, so only paths, bytes and the few policy checks with a static v2 predicate
 * survive; everything else is recorded in `metadata.migration.dropped` with a reason. Nothing is
 * silently lost and nothing that gets hashed carries a clock value (PLAN.md §2 invariant 1).
 *
 * Content resolution, per artifact:
 *   - `contentUtf8` / `contentBase64`  → `inline` source (or CAS when over the inline limits and a
 *     CAS root is given);
 *   - hash only + bytes found via `resolveContent(path)` (the v1 output tree) → sha256 re-verified,
 *     then `cas` (when a CAS root is given) or `inline`;
 *   - hash only + bytes unavailable → `cas` source pointing at the declared sha256 and a warning;
 *     the Plan validates, and `compilePlan` reports `ERR_BLOB_MISSING` until the blob is added.
 *
 * Pure with respect to its inputs: the same manifest + options yield a deep-equal Plan.
 */
import { sha256Hex } from "@codai/axiom-canon";
import { casPut, encodeBlob, INLINE_BASE64_DECODED_MAX } from "@codai/axiom-plan";
import {
  AxiomError,
  type CheckRefInput,
  INLINE_CONTENT_MAX,
  type PlanArtifact,
  type PlanInput,
  PlanSchema,
  RelPathSchema,
} from "@codai/axiom-schema";
import { z } from "zod";

export const MIGRATE_TOOL = "axiom migrate" as const;

/** v1 wire shape, loose on purpose: unknown keys are reported as dropped, not rejected. */
const V1ArtifactSchema = z.looseObject({
  path: z.string().min(1),
  kind: z.enum(["file", "dir"]).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  bytes: z.int().nonnegative().optional(),
  contentUtf8: z.string().optional(),
  contentBase64: z.string().optional(),
});

const V1EvidenceSchema = z.looseObject({
  checkName: z.string().optional(),
  kind: z.string().optional(),
  passed: z.boolean().optional(),
  details: z.looseObject({ expression: z.string().optional() }).optional(),
});

export const V1ManifestSchema = z.looseObject({
  version: z.string().regex(/^1\./, "v1 manifests declare version 1.x"),
  buildId: z.union([z.string(), z.number()]).optional(),
  irHash: z.string().optional(),
  profile: z.string().optional(),
  artifacts: z.array(V1ArtifactSchema).min(1),
  evidence: z.array(V1EvidenceSchema).optional(),
  createdAt: z.string().optional(),
});

export type V1Manifest = z.infer<typeof V1ManifestSchema>;
type V1Artifact = z.infer<typeof V1ArtifactSchema>;

export interface Dropped {
  field: string;
  reason: string;
}

export interface MigrationMetadata {
  from: "v1";
  tool: typeof MIGRATE_TOOL;
  version: string;
  source: { version: string; profile: string | null };
  dropped: Dropped[];
  warnings: string[];
}

export interface MigrateOptions {
  /** Version string of the migrating tool, recorded in `metadata.migration.version`. */
  version: string;
  /** v2 profile name for `Plan.profile`; default `"default"`. */
  profile?: string;
  /** `Plan.name` (kebab-case); default derived from the v1 profile. */
  name?: string;
  /** Emit every artifact with `op: "overwrite"` instead of the v2 default `create`. */
  overwrite?: boolean;
  /** Root whose `.axiom/cas` receives resolved bytes; absent → everything inline. */
  casRoot?: string;
  /** Looks up bytes for hash-only artifacts by their (normalised) v1 path. */
  resolveContent?: (path: string) => Promise<Uint8Array | undefined>;
}

export interface MigrateReport {
  ok: boolean;
  artifacts: { total: number; inline: number; cas: number; unresolved: number; skipped: number };
  checks: number;
  dropped: Dropped[];
  warnings: string[];
}

export interface MigrateResult {
  plan: PlanInput;
  report: MigrateReport;
}

/** v1 policy expression → v2 predicate. Anything not listed is dropped with a reason. */
const EVIDENCE_MAP: ReadonlyArray<{
  test: RegExp;
  check: (name: string) => CheckRefInput;
}> = [
  {
    test: /^scan\.artifacts\.no_personal_data\(\)$/,
    check: (name) => ({ id: name, predicate: "content.noSecrets", params: {} }),
  },
];

/** v1 profile constraint → v2 predicate. */
const CONSTRAINT_MAP: Readonly<
  Record<string, (value: unknown, id: string) => CheckRefInput | undefined>
> = {
  max_dependencies: (v, id) =>
    typeof v === "number" ? { id, predicate: "deps.max", params: { max: v } } : undefined,
  max_bundle_size_kb: (v, id) =>
    typeof v === "number"
      ? { id, predicate: "manifest.maxTotalBytes", params: { max: v * 1024 } }
      : undefined,
  max_artifact_size_mb: (v, id) =>
    typeof v === "number"
      ? { id, predicate: "content.maxBytes", params: { max: v * 1024 * 1024 } }
      : undefined,
};

/** Constraints of the three v1 built-in profiles (`packages/_v1/profiles/*.json`, frozen). */
const V1_PROFILE_CONSTRAINTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  default: {},
  budget: { max_bundle_size_kb: 500, max_dependencies: 5, no_analytics: true, no_telemetry: true },
  edge: {
    timeout_ms: 50,
    memory_mb: 128,
    max_artifact_size_mb: 50,
    cold_start_ms: 100,
    no_fs_heavy: true,
  },
};

const RUNTIME_CONSTRAINT_REASON =
  "runtime measurement (v1 constant metric); v2 checks are static predicates over the manifest";

const TOP_LEVEL_DROP_REASONS: Readonly<Record<string, string>> = {
  buildId: "v2 identifies a build by manifestDigest = sha256(JCS(manifest))",
  irHash: "v1 hashed {} for every IR (JSON.stringify replacer bug); v2 has planDigest",
  createdAt: "timestamp; nothing hashed in v2 may carry a clock value (invariant 1)",
  version: "v1 format version; recorded in metadata.migration.source.version",
};

const ARTIFACT_DROP_REASONS: Readonly<Record<string, string>> = {
  kind: "v2 artifacts are always files; directories are created implicitly",
  sha256:
    "v2 recomputes every digest at compile time (recorded as the cas digest when content is unavailable)",
  bytes: "v2 recomputes byte counts at compile time",
  contentUtf8: "lifted into source.inline",
  contentBase64: "lifted into source.inline (encoding base64)",
};

/** `out\web\x.md` → `out/web/x.md`; strips a leading `./`. */
export function normaliseV1Path(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function toPlanName(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9]/.test(s) ? s : `v1-${s}`.slice(0, 64) || "migrated-v1";
}

function invalidV1(issues: readonly unknown[]): AxiomError {
  return new AxiomError("ERR_INVALID_MANIFEST", "input is not an AXIOM v1 manifest", {
    details: { issues: issues.slice(0, 20) },
  });
}

interface Ctx {
  opts: MigrateOptions;
  dropped: Dropped[];
  warnings: string[];
  counts: MigrateReport["artifacts"];
}

function drop(ctx: Ctx, field: string, reason: string): void {
  ctx.dropped.push({ field, reason });
}

async function sourceForBytes(
  ctx: Ctx,
  path: string,
  bytes: Uint8Array,
): Promise<PlanArtifact["source"]> {
  const blob = encodeBlob(bytes);
  const inlineOk =
    blob.encoding === "utf8"
      ? bytes.length <= INLINE_CONTENT_MAX
      : bytes.length <= INLINE_BASE64_DECODED_MAX;
  if (ctx.opts.casRoot !== undefined) {
    const hex = await casPut(ctx.opts.casRoot, bytes);
    ctx.counts.cas++;
    return { type: "cas", digest: `sha256:${hex}` };
  }
  if (!inlineOk) {
    throw new AxiomError(
      "ERR_BLOB_TOO_LARGE",
      "content exceeds the inline limit; pass --cas <root>",
      {
        path,
        details: {
          bytes: bytes.length,
          max: blob.encoding === "utf8" ? INLINE_CONTENT_MAX : INLINE_BASE64_DECODED_MAX,
        },
      },
    );
  }
  ctx.counts.inline++;
  return { type: "inline", content: blob.data, encoding: blob.encoding };
}

function checkDeclared(
  ctx: Ctx,
  field: string,
  a: V1Artifact,
  bytes: Uint8Array,
  strict: boolean,
): void {
  const actual = sha256Hex(bytes);
  if (a.sha256 !== undefined && a.sha256 !== actual) {
    if (strict) {
      throw new AxiomError("ERR_DIGEST_MISMATCH", "resolved content does not match the v1 sha256", {
        path: normaliseV1Path(a.path),
        details: { expected: `sha256:${a.sha256}`, actual: `sha256:${actual}` },
      });
    }
    ctx.warnings.push(
      `${field}: declared sha256 ${a.sha256.slice(0, 12)}… ≠ content ${actual.slice(0, 12)}…; v2 uses the content`,
    );
  }
  if (a.bytes !== undefined && a.bytes !== bytes.length) {
    ctx.warnings.push(
      `${field}: declared bytes ${a.bytes} ≠ content ${bytes.length}; v2 uses the content`,
    );
  }
}

async function migrateArtifact(
  ctx: Ctx,
  a: V1Artifact,
  index: number,
): Promise<PlanArtifact | undefined> {
  const field = `artifacts[${index}]`;
  const path = normaliseV1Path(a.path);
  if (a.kind === "dir") {
    drop(ctx, `${field} (${path})`, ARTIFACT_DROP_REASONS.kind as string);
    ctx.counts.skipped++;
    return undefined;
  }
  const rel = RelPathSchema.safeParse(path);
  if (!rel.success) {
    throw new AxiomError(
      "ERR_PATH_NOT_RELATIVE_POSIX",
      "v1 artifact path is not a valid v2 RelPath",
      {
        path,
        details: { original: a.path, issues: rel.error.issues.map((i) => i.message) },
      },
    );
  }
  for (const key of Object.keys(a)) {
    if (key === "path") continue;
    const reason = ARTIFACT_DROP_REASONS[key];
    if (reason === undefined) drop(ctx, `${field}.${key}`, "no v2 equivalent");
    else if (key === "kind" || key === "bytes" || key === "sha256")
      drop(ctx, `${field}.${key}`, reason);
  }

  let bytes: Uint8Array | undefined;
  if (a.contentUtf8 !== undefined) {
    bytes = new TextEncoder().encode(a.contentUtf8);
    checkDeclared(ctx, field, a, bytes, false);
  } else if (a.contentBase64 !== undefined) {
    const buf = Buffer.from(a.contentBase64, "base64");
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    checkDeclared(ctx, field, a, bytes, false);
  } else if (ctx.opts.resolveContent !== undefined) {
    bytes = await ctx.opts.resolveContent(path);
    if (bytes !== undefined) checkDeclared(ctx, field, a, bytes, true);
  }

  const base = {
    path,
    mode: "0644" as const,
    op: ctx.opts.overwrite === true ? ("overwrite" as const) : ("create" as const),
  };
  if (bytes !== undefined) return { ...base, source: await sourceForBytes(ctx, path, bytes) };
  if (a.sha256 === undefined) {
    throw new AxiomError("ERR_BLOB_MISSING", "artifact has neither content nor sha256", { path });
  }
  ctx.counts.unresolved++;
  ctx.warnings.push(
    `${field} (${path}): content unavailable; emitted as cas sha256:${a.sha256.slice(0, 12)}… (compile needs the blob)`,
  );
  return { ...base, source: { type: "cas", digest: `sha256:${a.sha256}` } };
}

function migrateEvidence(ctx: Ctx, evidence: V1Manifest["evidence"]): CheckRefInput[] {
  const checks: CheckRefInput[] = [];
  const seen = new Set<string>();
  (evidence ?? []).forEach((e, i) => {
    const field = `evidence[${i}]`;
    const expr = e.details?.expression;
    const name = e.checkName ?? `v1-check-${i}`;
    const mapped = expr === undefined ? undefined : EVIDENCE_MAP.find((m) => m.test.test(expr));
    if (mapped === undefined) {
      const why =
        e.kind === "sla" || e.kind === "unit"
          ? `${e.kind} evidence is a runtime measurement; v2 checks are static predicates`
          : `no v2 predicate for expression ${JSON.stringify(expr ?? null)}`;
      drop(ctx, `${field} (${name})`, why);
      return;
    }
    const id = seen.has(name) ? `${name}-${i}` : name;
    seen.add(id);
    const check = mapped.check(id);
    if (
      checks.some(
        (c) =>
          c.predicate === check.predicate &&
          JSON.stringify(c.params) === JSON.stringify(check.params),
      )
    ) {
      drop(ctx, `${field} (${name})`, `duplicate of an earlier ${check.predicate} check`);
      return;
    }
    checks.push(check);
  });
  return checks;
}

function migrateProfile(ctx: Ctx, profile: string | undefined): CheckRefInput[] {
  if (profile === undefined) return [];
  const constraints = V1_PROFILE_CONSTRAINTS[profile];
  if (constraints === undefined) {
    drop(
      ctx,
      "profile",
      `unknown v1 profile ${JSON.stringify(profile)}; its constraints are not available`,
    );
    return [];
  }
  const checks: CheckRefInput[] = [];
  for (const [key, value] of Object.entries(constraints)) {
    const map = CONSTRAINT_MAP[key];
    const check = map?.(value, `v1-${profile}-${key.replace(/_/g, "-")}`);
    if (check === undefined) drop(ctx, `profile.${profile}.${key}`, RUNTIME_CONSTRAINT_REASON);
    else checks.push(check);
  }
  return checks;
}

/**
 * v1 manifest (parsed JSON) → v2 `Plan` + report. Throws `AxiomError` (closed codes) when the
 * input is not a v1 manifest or cannot be migrated losslessly; never returns a Plan that fails
 * `PlanSchema`.
 */
export async function migrateV1(manifest: unknown, opts: MigrateOptions): Promise<MigrateResult> {
  const parsed = V1ManifestSchema.safeParse(manifest);
  if (!parsed.success) throw invalidV1(parsed.error.issues);
  const v1 = parsed.data;
  const ctx: Ctx = {
    opts,
    dropped: [],
    warnings: [],
    counts: { total: v1.artifacts.length, inline: 0, cas: 0, unresolved: 0, skipped: 0 },
  };

  for (const key of Object.keys(v1)) {
    if (key === "artifacts" || key === "evidence" || key === "profile") continue;
    drop(ctx, key, TOP_LEVEL_DROP_REASONS[key] ?? "no v2 equivalent");
  }

  const artifacts: PlanArtifact[] = [];
  const paths = new Set<string>();
  for (const [i, a] of v1.artifacts.entries()) {
    const out = await migrateArtifact(ctx, a, i);
    if (out === undefined) continue;
    if (paths.has(out.path)) {
      throw new AxiomError("ERR_INVALID_PLAN", "duplicate artifact path after normalisation", {
        path: out.path,
      });
    }
    paths.add(out.path);
    artifacts.push(out);
  }
  if (artifacts.length === 0) {
    throw new AxiomError("ERR_INVALID_PLAN", "no file artifacts to migrate", {
      details: { skipped: ctx.counts.skipped },
    });
  }

  const checks = [...migrateProfile(ctx, v1.profile), ...migrateEvidence(ctx, v1.evidence)];

  const migration: MigrationMetadata = {
    from: "v1",
    tool: MIGRATE_TOOL,
    version: opts.version,
    source: { version: v1.version, profile: v1.profile ?? null },
    dropped: ctx.dropped,
    warnings: ctx.warnings,
  };
  const plan: PlanInput = {
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: toPlanName(opts.name ?? `migrated-v1-${v1.profile ?? "manifest"}`),
    intent: `Migrated from AXIOM v1 manifest (profile ${v1.profile ?? "none"}, ${artifacts.length} artifacts)`,
    profile: opts.profile ?? "default",
    artifacts,
    checks,
    metadata: { migration: structuredClone(migration) as unknown as Record<string, never> },
  };
  const valid = PlanSchema.safeParse(plan);
  if (!valid.success) {
    throw new AxiomError("ERR_INVALID_PLAN", "migrated plan does not match PlanSchema", {
      details: { issues: valid.error.issues.slice(0, 20) },
    });
  }
  return {
    plan,
    report: {
      ok: ctx.warnings.length === 0,
      artifacts: ctx.counts,
      checks: checks.length,
      dropped: ctx.dropped,
      warnings: ctx.warnings,
    },
  };
}

/** Key looks like a clock field: `*At`/`*at` suffix, or contains `timestamp`/`date` (case-insensitive). */
const CLOCK_KEY = /(?:at$)|timestamp|date/i;

/** Recursive scan for clock-like keys (invariant 1 guard); returns dotted paths, `[]` when clean. */
export function findClockKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findClockKeys(v, `${prefix}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  const hits: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const p = prefix === "" ? k : `${prefix}.${k}`;
    if (CLOCK_KEY.test(k)) hits.push(p);
    hits.push(...findClockKeys(v, p));
  }
  return hits;
}
