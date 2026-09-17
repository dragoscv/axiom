import {
  buildStatement,
  canonicalDigestRef,
  type InTotoStatementV1,
  parseDigestRef,
  sha256Hex,
} from "@codai/axiom-canon";
import {
  AxiomError,
  type Blob,
  BUNDLE_BLOB_BYTES_MAX,
  compareUtf8,
  type DigestRef,
  INLINE_CONTENT_MAX,
  type ManifestArtifact,
  type ManifestBody,
  type ManifestBundle,
  ManifestBundleSchema,
  type Plan,
  type PlanArtifact,
  PlanSchema,
  type Toolchain,
} from "@codai/axiom-schema";
import { decodeBlob, encodeBlob, isBase64, utf8Bytes } from "./blob.js";
import { casGet, casPut } from "./cas.js";

/** Decoded byte budget for a base64 inline source (§2.5). */
export const INLINE_BASE64_DECODED_MAX: number = 192 * 1024;
/** Toolchain version recorded when the caller supplies none. */
export const AXIOM_VERSION: string = "2.0.0";

export interface CompileOptions {
  /** `inline` (default) puts blobs in the bundle; `cas` writes them under `<root>/.axiom/cas`. */
  store?: "inline" | "cas";
  /** Repository root — required to read `cas` sources and to write when `store: "cas"`. */
  root?: string;
  /** `{ axiom, <emitter>: <version> }`; `axiom` defaults to 2.0.0. */
  toolchain?: Record<string, string>;
  /** Clock for `runDetails.metadata.startedOn/finishedOn`. Omit for a fully deterministic statement. */
  now?: () => string;
  invocationId?: string;
}

export interface CompileResult {
  bundle: ManifestBundle;
  statement: InTotoStatementV1;
}

interface Resolved {
  artifact: ManifestArtifact;
  bytes: Uint8Array | undefined;
}

function invalidPlan(err: { issues: readonly unknown[] }): AxiomError {
  return new AxiomError("ERR_INVALID_PLAN", "plan does not match PlanSchema", {
    details: { issues: err.issues },
  });
}

async function resolveSource(a: PlanArtifact, opts: CompileOptions): Promise<Uint8Array> {
  const src = a.source;
  if (src === undefined) {
    throw new AxiomError("ERR_INVALID_PLAN", "source is required unless op is delete", {
      path: a.path,
    });
  }
  switch (src.type) {
    case "inline": {
      if (src.encoding === "utf8") {
        const bytes = utf8Bytes(src.content);
        if (bytes.length > INLINE_CONTENT_MAX) {
          throw new AxiomError(
            "ERR_BLOB_TOO_LARGE",
            `inline utf8 content is ${bytes.length} bytes`,
            {
              path: a.path,
              details: { bytes: bytes.length, max: INLINE_CONTENT_MAX },
            },
          );
        }
        return bytes;
      }
      if (!isBase64(src.content)) {
        throw new AxiomError("ERR_INVALID_PLAN", "inline content is not valid base64", {
          path: a.path,
        });
      }
      const bytes = decodeBlob({ encoding: "base64", data: src.content });
      if (bytes.length > INLINE_BASE64_DECODED_MAX) {
        throw new AxiomError(
          "ERR_BLOB_TOO_LARGE",
          `inline base64 decodes to ${bytes.length} bytes`,
          {
            path: a.path,
            details: { bytes: bytes.length, max: INLINE_BASE64_DECODED_MAX },
          },
        );
      }
      return bytes;
    }
    case "cas": {
      const hex = parseDigestRef(src.digest);
      if (opts.root === undefined) {
        throw new AxiomError("ERR_BLOB_MISSING", "cas source needs a root", {
          path: a.path,
          details: { digest: src.digest },
        });
      }
      const bytes = await casGet(opts.root, hex);
      if (bytes === undefined) {
        throw new AxiomError("ERR_BLOB_MISSING", "cas object not found", {
          path: a.path,
          details: { digest: src.digest },
        });
      }
      const actual = sha256Hex(bytes);
      if (actual !== hex) {
        throw new AxiomError(
          "ERR_DIGEST_MISMATCH",
          "cas object content does not match its digest",
          {
            path: a.path,
            details: { expected: src.digest, actual: `sha256:${actual}` },
          },
        );
      }
      return bytes;
    }
    case "ref":
      throw new AxiomError("ERR_REF_OFFLINE", "ref sources are not fetched in v2.0", {
        path: a.path,
        details: { uri: src.uri, digest: src.digest },
      });
    case "template":
      throw new AxiomError("ERR_UNSUPPORTED_OP", "template sources ship in v2.1", {
        path: a.path,
        details: { emitter: src.emitter, template: src.template },
      });
  }
}

async function resolveArtifact(a: PlanArtifact, opts: CompileOptions): Promise<Resolved> {
  if (a.op === "delete") {
    return { artifact: { path: a.path, op: a.op, mode: a.mode }, bytes: undefined };
  }
  const bytes = await resolveSource(a, opts);
  const origin = a.source?.type ?? "inline";
  return {
    artifact: {
      path: a.path,
      op: a.op,
      mode: a.mode,
      digest: { sha256: sha256Hex(bytes) },
      bytes: bytes.length,
      origin,
    },
    bytes,
  };
}

/**
 * Plan with every `source` reduced to `{ type, digest }` and artifacts sorted by
 * path, so the plan digest is independent of authoring order and content transport.
 */
function digestOnlyPlan(plan: Plan, digests: ReadonlyMap<string, string>): Record<string, unknown> {
  const artifacts = [...plan.artifacts]
    .sort((x, y) => compareUtf8(x.path, y.path))
    .map((a) => {
      const out: Record<string, unknown> = { path: a.path, mode: a.mode, op: a.op };
      if (a.source !== undefined) {
        out.source = { type: a.source.type, digest: `sha256:${digests.get(a.path) ?? ""}` };
      }
      return out;
    });
  return { ...plan, artifacts };
}

function splitToolchain(input: Record<string, string> | undefined): Toolchain {
  const emitters: Record<string, string> = {};
  let axiom = AXIOM_VERSION;
  for (const key of Object.keys(input ?? {}).sort()) {
    const v = input?.[key];
    if (v === undefined) continue;
    if (key === "axiom") axiom = v;
    else emitters[key] = v;
  }
  return { axiom, emitters };
}

function flattenToolchain(t: Toolchain): Record<string, string> {
  const out: Record<string, string> = { axiom: t.axiom };
  for (const [k, v] of Object.entries(t.emitters)) out[`emitter:${k}`] = v;
  return out;
}

/**
 * Compile a Plan into a content-addressed ManifestBundle plus its in-toto
 * Statement. Deterministic: artifact order, source transport and clock never
 * change `manifestDigest`.
 */
export async function compilePlan(
  planInput: unknown,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const startedOn = opts.now?.();
  const parsed = PlanSchema.safeParse(planInput);
  if (!parsed.success) throw invalidPlan(parsed.error);
  const plan = parsed.data;

  const seen = new Set<string>();
  for (const a of plan.artifacts) {
    if (seen.has(a.path)) {
      throw new AxiomError("ERR_INVALID_PLAN", "duplicate artifact path", { path: a.path });
    }
    seen.add(a.path);
  }
  const checkIds = new Set<string>();
  for (const c of plan.checks) {
    if (checkIds.has(c.id)) {
      throw new AxiomError("ERR_INVALID_PLAN", `duplicate check id ${c.id}`, {
        details: { id: c.id },
      });
    }
    checkIds.add(c.id);
  }

  const resolved: Resolved[] = [];
  for (const a of plan.artifacts) resolved.push(await resolveArtifact(a, opts));
  resolved.sort((x, y) => compareUtf8(x.artifact.path, y.artifact.path));

  const digests = new Map<string, string>();
  for (const r of resolved) {
    if (r.artifact.digest !== undefined) digests.set(r.artifact.path, r.artifact.digest.sha256);
  }
  const planDigest = canonicalDigestRef(digestOnlyPlan(plan, digests));
  const toolchain = splitToolchain(opts.toolchain);

  const body: ManifestBody = {
    apiVersion: plan.apiVersion,
    kind: "Manifest",
    name: plan.name,
    profile: plan.profile,
    planDigest,
    artifacts: resolved.map((r) => r.artifact),
    checks: [...plan.checks].sort((x, y) => compareUtf8(x.id, y.id)),
    toolchain,
  };
  const manifestDigest = canonicalDigestRef(body);

  const blobs: Record<DigestRef, Blob> = {};
  const useCas = opts.store === "cas" && opts.root !== undefined;
  let total = 0;
  for (const r of resolved) {
    if (r.bytes === undefined || r.artifact.digest === undefined) continue;
    if (useCas) {
      await casPut(opts.root as string, r.bytes);
      continue;
    }
    const key: DigestRef = `sha256:${r.artifact.digest.sha256}`;
    if (key in blobs) continue;
    total += r.bytes.length;
    if (total > BUNDLE_BLOB_BYTES_MAX) {
      throw new AxiomError(
        "ERR_BUNDLE_TOO_LARGE",
        `inline blobs exceed ${BUNDLE_BLOB_BYTES_MAX} bytes`,
        {
          details: { total, max: BUNDLE_BLOB_BYTES_MAX, hint: 'use store: "cas"' },
        },
      );
    }
    blobs[key] = encodeBlob(r.bytes);
  }

  const statementInput: Parameters<typeof buildStatement>[0] = {
    subjectName: plan.name,
    manifestDigestHex: parseDigestRef(manifestDigest),
    planDigestHex: parseDigestRef(planDigest),
    profile: plan.profile,
    toolchain: flattenToolchain(toolchain),
    byproducts: body.artifacts
      .filter((a) => a.digest !== undefined)
      .map((a) => ({ name: a.path, sha256: a.digest?.sha256 ?? "" })),
  };
  if (opts.invocationId !== undefined) statementInput.invocationId = opts.invocationId;
  if (startedOn !== undefined) statementInput.startedOn = startedOn;
  const finishedOn = opts.now?.();
  if (finishedOn !== undefined) statementInput.finishedOn = finishedOn;
  const statement = buildStatement(statementInput);

  const candidate = { manifest: body, manifestDigest, attestation: statement, blobs };
  const checked = ManifestBundleSchema.safeParse(candidate);
  if (!checked.success) {
    throw new AxiomError("ERR_INVALID_MANIFEST", "compiled bundle failed ManifestBundleSchema", {
      details: { issues: checked.error.issues },
    });
  }
  return { bundle: checked.data, statement };
}
