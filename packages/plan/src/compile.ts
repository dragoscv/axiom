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
import { applyPatchText } from "./patch.js";
import { type RefNetOptions, resolveRef } from "./ref.js";
import type { EmitterRegistry } from "./template.js";

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
  /** Emitters available to `template` sources; absent → every template source fails `ERR_EMITTER_UNKNOWN`. */
  emitters?: EmitterRegistry;
  /**
   * Network policy for `ref` sources. Default `{ allowNet: false }`: a ref already in the CAS
   * resolves offline, anything else is `ERR_NET_DISABLED`. Needs `root`.
   */
  net?: RefNetOptions;
  /**
   * Pre-image reader for `patch` sources: current bytes of `relPath` under the root, or
   * `undefined` when absent. Defaults to reading `<root>/<relPath>` from disk; tests and
   * the gate may inject one. Without a root and without this, patch sources fail
   * `ERR_PATCH_PREIMAGE`.
   */
  readPreImage?: (relPath: string) => Promise<Uint8Array | undefined>;
}

export interface CompileResult {
  bundle: ManifestBundle;
  statement: InTotoStatementV1;
}

interface Resolved {
  artifact: ManifestArtifact;
  bytes: Uint8Array | undefined;
  /** Set when the bytes came from a template emitter (recorded in `toolchain.emitters`). */
  emitter?: { id: string; version: string };
}

function invalidPlan(err: { issues: readonly unknown[] }): AxiomError {
  return new AxiomError("ERR_INVALID_PLAN", "plan does not match PlanSchema", {
    details: { issues: err.issues },
  });
}

interface SourceBytes {
  bytes: Uint8Array;
  emitter?: { id: string; version: string };
}

function renderTemplate(
  a: PlanArtifact,
  src: { emitter: string; template: string; params: Record<string, unknown> },
  opts: CompileOptions,
): SourceBytes {
  const emitter = opts.emitters?.get(src.emitter);
  if (emitter === undefined) {
    throw new AxiomError("ERR_EMITTER_UNKNOWN", `no emitter registered as "${src.emitter}"`, {
      path: a.path,
      details: { emitter: src.emitter, available: opts.emitters?.list() ?? [] },
    });
  }
  const def = Object.hasOwn(emitter.templates, src.template)
    ? emitter.templates[src.template]
    : undefined;
  if (def === undefined) {
    throw new AxiomError(
      "ERR_TEMPLATE_UNKNOWN",
      `emitter "${src.emitter}" has no template "${src.template}"`,
      {
        path: a.path,
        details: {
          emitter: src.emitter,
          template: src.template,
          available: Object.keys(emitter.templates).sort(),
        },
      },
    );
  }
  const parsed = def.params.safeParse(src.params);
  if (!parsed.success) {
    throw new AxiomError("ERR_TEMPLATE_PARAMS", "template params fail the template schema", {
      path: a.path,
      details: { emitter: src.emitter, template: src.template, issues: parsed.error.issues },
    });
  }
  const rendered = def.render(parsed.data);
  const bytes = typeof rendered === "string" ? utf8Bytes(rendered) : rendered;
  if (bytes.length > INLINE_CONTENT_MAX) {
    throw new AxiomError("ERR_BLOB_TOO_LARGE", `template rendered ${bytes.length} bytes`, {
      path: a.path,
      details: { bytes: bytes.length, max: INLINE_CONTENT_MAX },
    });
  }
  return { bytes, emitter: { id: emitter.id, version: emitter.version } };
}

async function resolveSource(a: PlanArtifact, opts: CompileOptions): Promise<SourceBytes> {
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
        return { bytes };
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
      return { bytes };
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
      return { bytes };
    }
    case "ref": {
      if (opts.root === undefined) {
        throw new AxiomError("ERR_REF_OFFLINE", "ref source needs a root (its CAS)", {
          path: a.path,
          details: { digest: src.digest },
        });
      }
      const bytes = await resolveRef(src, {
        ...(opts.net ?? { allowNet: false }),
        root: opts.root,
        path: a.path,
      });
      return { bytes };
    }
    case "template":
      return renderTemplate(a, src, opts);
    case "patch":
      return applyPatchSource(a, src, opts);
  }
}

async function defaultReadPreImage(root: string, relPath: string): Promise<Uint8Array | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    return new Uint8Array(await readFile(join(root, ...relPath.split("/"))));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

async function applyPatchSource(
  a: PlanArtifact,
  src: { format: "unified" | "v4a" | "search-replace"; preImage: string; body: string },
  opts: CompileOptions,
): Promise<SourceBytes> {
  const read =
    opts.readPreImage ??
    (opts.root === undefined
      ? undefined
      : (rel: string) => defaultReadPreImage(opts.root as string, rel));
  if (read === undefined) {
    throw new AxiomError("ERR_PATCH_PREIMAGE", "patch source needs a root to read the pre-image", {
      path: a.path,
      details: { preImage: src.preImage },
    });
  }
  const current = await read(a.path);
  const actual = current === undefined ? "absent" : `sha256:${sha256Hex(current)}`;
  if (actual !== src.preImage) {
    throw new AxiomError(
      "ERR_PATCH_PREIMAGE",
      current === undefined
        ? "patch pre-image is absent under the root"
        : "file under the root does not match the patch pre-image",
      { path: a.path, details: { expected: src.preImage, actual } },
    );
  }
  let text: string;
  try {
    text = current === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(current);
  } catch {
    throw new AxiomError("ERR_PATCH_PREIMAGE", "patch pre-image is not valid UTF-8", {
      path: a.path,
    });
  }
  let out: string;
  try {
    out = applyPatchText(src.format, src.body, text);
  } catch (err) {
    if (err instanceof AxiomError) {
      throw new AxiomError(err.code, err.message, {
        path: a.path,
        cause: err,
        ...(err.details === undefined ? {} : { details: err.details }),
      });
    }
    throw err;
  }
  const bytes = utf8Bytes(out);
  if (bytes.length > INLINE_CONTENT_MAX) {
    throw new AxiomError("ERR_BLOB_TOO_LARGE", `patched content is ${bytes.length} bytes`, {
      path: a.path,
      details: { bytes: bytes.length, max: INLINE_CONTENT_MAX },
    });
  }
  return { bytes };
}

async function resolveArtifact(a: PlanArtifact, opts: CompileOptions): Promise<Resolved> {
  if (a.op === "delete") {
    return { artifact: { path: a.path, op: a.op, mode: a.mode }, bytes: undefined };
  }
  const { bytes, emitter } = await resolveSource(a, opts);
  const origin = a.source?.type ?? "inline";
  const out: Resolved = {
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
  if (emitter !== undefined) out.emitter = emitter;
  return out;
}

/**
 * Plan with every `source` reduced to `{ type, digest }` and artifacts sorted by
 * path, so the plan digest is independent of authoring order and content transport.
 * Template sources additionally keep `{ emitter, template, params }` — those are the
 * inputs, and the plan digest must change when they do.
 */
function digestOnlyPlan(plan: Plan, digests: ReadonlyMap<string, string>): Record<string, unknown> {
  const artifacts = [...plan.artifacts]
    .sort((x, y) => compareUtf8(x.path, y.path))
    .map((a) => {
      const out: Record<string, unknown> = { path: a.path, mode: a.mode, op: a.op };
      if (a.source !== undefined) {
        const digest = `sha256:${digests.get(a.path) ?? ""}`;
        if (a.source.type === "template") {
          out.source = {
            type: "template",
            emitter: a.source.emitter,
            template: a.source.template,
            params: a.source.params,
            digest,
          };
        } else if (a.source.type === "patch") {
          // D-17 acceptance: a patch plan and the equivalent inline plan must have the same
          // planDigest — the plan digest is about *what content lands*, not how it was
          // expressed. The pre-image is bound by S-402 (`ManifestBody.preImage`), not here.
          out.source = { type: "inline", digest };
        } else {
          out.source = { type: a.source.type, digest };
        }
      }
      return out;
    });
  return { ...plan, artifacts };
}

function splitToolchain(
  input: Record<string, string> | undefined,
  used: ReadonlyMap<string, string>,
): Toolchain {
  const emitters: Record<string, string> = {};
  let axiom = AXIOM_VERSION;
  for (const key of Object.keys(input ?? {}).sort()) {
    const v = input?.[key];
    if (v === undefined) continue;
    if (key === "axiom") axiom = v;
    else emitters[key] = v;
  }
  // Emitters that actually rendered something win over caller-declared versions.
  for (const id of [...used.keys()].sort()) emitters[id] = used.get(id) as string;
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
  const usedEmitters = new Map<string, string>();
  for (const r of resolved) {
    if (r.artifact.digest !== undefined) digests.set(r.artifact.path, r.artifact.digest.sha256);
    if (r.emitter !== undefined) usedEmitters.set(r.emitter.id, r.emitter.version);
  }
  const planDigest = canonicalDigestRef(digestOnlyPlan(plan, digests));
  const toolchain = splitToolchain(opts.toolchain, usedEmitters);

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
  if (plan.counter !== undefined) body.counter = plan.counter;
  const manifestDigest = canonicalDigestRef(body);

  const blobs: Record<DigestRef, Blob> = {};
  const useCas = opts.store === "cas" && opts.root !== undefined;
  let total = 0;
  for (const r of resolved) {
    if (r.bytes === undefined || r.artifact.digest === undefined) continue;
    // Invariant 2: ref bytes never travel inline — resolveRef already stored them in the CAS.
    if (r.artifact.origin === "ref") continue;
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
