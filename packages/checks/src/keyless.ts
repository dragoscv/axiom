/**
 * Keyless (Sigstore) manifest signatures — S-705, red-team gap B7.
 *
 * A keyless signature is a Sigstore bundle (`application/vnd.dev.sigstore.bundle.v0.3+json`)
 * whose `dsseEnvelope` carries the SAME payload bytes and payloadType AXIOM's Ed25519 envelopes
 * sign (`JCS(manifest)` under `application/vnd.axiom.manifest+json`, or `JCS({manifest, rootId})`
 * under the bound type). The signing key is ephemeral; its Fulcio certificate binds it to an
 * OIDC identity (issuer + subject, e.g. a GitHub Actions workflow ref) and the signature is
 * logged in Rekor. `sigstore` is an **optional** dependency loaded lazily: without it both
 * signing and verification fail closed with `ERR_KEYLESS_UNAVAILABLE`, never a pass.
 *
 * Online vs offline:
 * - `signManifestKeyless` is ONLINE only: it needs an OIDC token (explicit `identityToken`,
 *   `SIGSTORE_ID_TOKEN`, or GitHub Actions' `ACTIONS_ID_TOKEN_REQUEST_URL` + `_TOKEN`), Fulcio
 *   (certificate) and Rekor (transparency log).
 * - `verifyManifestKeyless` checks the bundle itself OFFLINE — certificate chain to the Fulcio
 *   CA, SCT, the Rekor inclusion promise (SET) / inclusion proof and the DSSE signature are all
 *   verified from material embedded in the bundle. The only network use is fetching the
 *   Sigstore **trusted root** via TUF. With `offline: true` (sigstore's `tufForceCache`) that
 *   root is read from the TUF cache (`tufCachePath`, default sigstore's own cache dir) and no
 *   request is made; an empty/expired cache is then `ERR_KEYLESS_UNAVAILABLE` (fail closed).
 */
import { AXIOM_MANIFEST_PAYLOAD_TYPE, canonicalize } from "@codai/axiom-canon";
import { AxiomError } from "@codai/axiom-schema";
import { isCedarMissingError } from "./predicates/cedar.js";

/**
 * Where keyless material travels in a `ManifestBundle`: an optional array next to the Ed25519
 * `signatures[]`, outside the canonical body (so `manifestDigest` is unchanged). Read
 * structurally — `ManifestBundleSchema` must gain this field before bundles carrying it parse.
 */
export const KEYLESS_BUNDLE_FIELD = "keylessSignatures" as const;

/** GitHub Actions OIDC issuer, the usual `keyless.issuer`. */
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/** Sigstore bundle JSON (protobuf-specs `Bundle`, JSON form). Only the fields AXIOM reads are typed. */
export interface SigstoreBundleJson {
  mediaType: string;
  verificationMaterial: unknown;
  dsseEnvelope?: {
    payload: string;
    payloadType: string;
    signatures: { sig: string; keyid?: string }[];
  };
  messageSignature?: unknown;
  [k: string]: unknown;
}

/** Minimal slice of `sigstore@5` (`dist/sigstore.d.ts`, `dist/config.d.ts`) that AXIOM calls. */
interface SigstoreSigner {
  identity?: {
    subjectAlternativeName?: string;
    extensions?: { issuer?: string };
  };
}
interface SigstoreModule {
  attest(
    payload: Buffer,
    payloadType: string,
    options?: {
      identityToken?: string;
      fulcioURL?: string;
      rekorURL?: string;
      timeout?: number;
    },
  ): Promise<SigstoreBundleJson>;
  verify(
    bundle: SigstoreBundleJson,
    options?: {
      certificateIssuer?: string;
      tufRootPath?: string;
      tufCachePath?: string;
      tufMirrorURL?: string;
      tufForceCache?: boolean;
      timeout?: number;
    },
  ): Promise<SigstoreSigner>;
}

/** Non-literal specifier: typechecks whether or not the optional dependency is installed. */
const SIGSTORE_SPECIFIER = "sigstore";
let modPromise: Promise<SigstoreModule> | undefined;

function asModule(m: unknown): SigstoreModule {
  const ns = m as Partial<SigstoreModule> & { default?: Partial<SigstoreModule> };
  const src = typeof ns.verify === "function" ? ns : (ns.default ?? {});
  if (typeof src.verify !== "function" || typeof src.attest !== "function") {
    throw new AxiomError("ERR_KEYLESS_UNAVAILABLE", "sigstore module has no verify/attest", {
      details: { reason: "MODULE_SHAPE" },
    });
  }
  return src as SigstoreModule;
}

/** Load `sigstore` once. Any load failure → `ERR_KEYLESS_UNAVAILABLE` (fail closed). */
export function sigstoreModule(): Promise<SigstoreModule> {
  if (modPromise === undefined) {
    modPromise = import(/* @vite-ignore */ SIGSTORE_SPECIFIER).then(asModule, (err: unknown) => {
      throw new AxiomError("ERR_KEYLESS_UNAVAILABLE", "optional dependency sigstore not loadable", {
        details: { reason: isCedarMissingError(err) ? "MODULE_MISSING" : "MODULE_LOAD_FAILED" },
        cause: err,
      });
    });
    // A failed load is not cached: installing the module later must take effect.
    modPromise.catch(() => {
      modPromise = undefined;
    });
  }
  return modPromise;
}

/** Test seam: drop the cached module so a `vi.doMock` takes effect. */
export function __resetSigstoreForTests(): void {
  modPromise = undefined;
}

/** `JCS(manifest)` as UTF-8 — the exact bytes Ed25519 envelopes sign (`manifestDigest` preimage). */
export function keylessPayload(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(manifest));
}

/** Whether an ambient OIDC token source that sigstore's CI provider understands is present. */
export function hasAmbientOidc(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SIGSTORE_ID_TOKEN) return true;
  return Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

export interface SignKeylessOptions {
  /** Explicit OIDC token; otherwise `SIGSTORE_ID_TOKEN` / GitHub Actions ambient OIDC. Never logged. */
  identityToken?: string;
  /** Defaults to `application/vnd.axiom.manifest+json`; pass the bound type for root-bound payloads. */
  payloadType?: string;
  fulcioURL?: string;
  rekorURL?: string;
  timeout?: number;
}

/**
 * Sign `payload` (use `keylessPayload(manifest)`) as a Sigstore DSSE bundle. ONLINE: Fulcio +
 * Rekor + OIDC. No token source, no module, or any signing/network failure →
 * `AxiomError("ERR_KEYLESS_UNAVAILABLE")` with `details.reason`.
 */
export async function signManifestKeyless(
  payload: Uint8Array,
  opts: SignKeylessOptions = {},
): Promise<SigstoreBundleJson> {
  if (opts.identityToken === undefined && !hasAmbientOidc()) {
    throw new AxiomError(
      "ERR_KEYLESS_UNAVAILABLE",
      "keyless signing needs an OIDC token (run in CI with id-token: write, or pass identityToken)",
      { details: { reason: "NO_OIDC" } },
    );
  }
  const sigstore = await sigstoreModule();
  const options: Parameters<SigstoreModule["attest"]>[2] = {};
  if (opts.identityToken !== undefined) options.identityToken = opts.identityToken;
  if (opts.fulcioURL !== undefined) options.fulcioURL = opts.fulcioURL;
  if (opts.rekorURL !== undefined) options.rekorURL = opts.rekorURL;
  if (opts.timeout !== undefined) options.timeout = opts.timeout;
  try {
    return await sigstore.attest(
      Buffer.from(payload),
      opts.payloadType ?? AXIOM_MANIFEST_PAYLOAD_TYPE,
      options,
    );
  } catch (err) {
    throw new AxiomError("ERR_KEYLESS_UNAVAILABLE", "sigstore signing failed", {
      details: { reason: "SIGN_FAILED", name: errName(err) },
      cause: err,
    });
  }
}

export interface KeylessPolicy {
  /** Exact OIDC issuer URL (Fulcio cert extension 1.3.6.1.4.1.57264.1.8 / .1.1). */
  issuer: string;
  /** Regex over the cert SAN (e.g. workflow URI); anchored — must match the WHOLE subject. */
  subjectRegex: string;
}

export interface VerifyKeylessOptions {
  /** Expected DSSE payloadType; default the unbound manifest type. */
  payloadType?: string;
  /** Read the trusted root only from the TUF cache (sigstore `tufForceCache`); no network. */
  offline?: boolean;
  tufCachePath?: string;
  tufRootPath?: string;
  tufMirrorURL?: string;
  timeout?: number;
}

export type KeylessFailure =
  | "NOT_DSSE"
  | "PAYLOAD_TYPE"
  | "PAYLOAD_MISMATCH"
  | "BAD_SIGNATURE"
  | "ISSUER_MISMATCH"
  | "SUBJECT_MISMATCH"
  | "NO_IDENTITY";

export interface KeylessVerdict {
  ok: boolean;
  issuer?: string;
  subject?: string;
  failure?: KeylessFailure;
}

/** Compile `subjectRegex` anchored to the whole subject. Throws on an invalid pattern. */
export function compileSubjectRegex(subjectRegex: string): RegExp {
  return new RegExp(`^(?:${subjectRegex})$`);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** sigstore throws `PolicyError` (a `VerificationError`) when the cert identity/issuer is off. */
const POLICY_ERRORS = new Set(["PolicyError"]);
/** Cryptographic / structural rejections: the bundle is present and wrong → a fail, not an error. */
const VERIFICATION_ERRORS = new Set(["VerificationError", "ValidationError", "SyntaxError"]);

/**
 * Verify a Sigstore bundle against the exact `payload` bytes and a signer policy.
 * `{ ok: false, failure }` for a bundle that is present but wrong; throws
 * `AxiomError("ERR_KEYLESS_UNAVAILABLE")` when verification cannot run (module missing, trusted
 * root unavailable offline or over the network) — callers map that to verdict `error`.
 */
export async function verifyManifestKeyless(
  bundle: SigstoreBundleJson,
  payload: Uint8Array,
  policy: KeylessPolicy,
  opts: VerifyKeylessOptions = {},
): Promise<KeylessVerdict> {
  const env = bundle.dsseEnvelope;
  if (env === undefined || typeof env.payload !== "string")
    return { ok: false, failure: "NOT_DSSE" };
  if (env.payloadType !== (opts.payloadType ?? AXIOM_MANIFEST_PAYLOAD_TYPE)) {
    return { ok: false, failure: "PAYLOAD_TYPE" };
  }
  if (!Buffer.from(env.payload, "base64").equals(Buffer.from(payload))) {
    return { ok: false, failure: "PAYLOAD_MISMATCH" };
  }
  const subjectRe = compileSubjectRegex(policy.subjectRegex);

  const sigstore = await sigstoreModule();
  const vopts: Parameters<SigstoreModule["verify"]>[1] = { certificateIssuer: policy.issuer };
  if (opts.offline === true) vopts.tufForceCache = true;
  if (opts.tufCachePath !== undefined) vopts.tufCachePath = opts.tufCachePath;
  if (opts.tufRootPath !== undefined) vopts.tufRootPath = opts.tufRootPath;
  if (opts.tufMirrorURL !== undefined) vopts.tufMirrorURL = opts.tufMirrorURL;
  if (opts.timeout !== undefined) vopts.timeout = opts.timeout;

  let signer: SigstoreSigner;
  try {
    signer = await sigstore.verify(bundle, vopts);
  } catch (err) {
    const name = errName(err);
    if (POLICY_ERRORS.has(name)) return { ok: false, failure: "ISSUER_MISMATCH" };
    if (VERIFICATION_ERRORS.has(name)) return { ok: false, failure: "BAD_SIGNATURE" };
    throw new AxiomError("ERR_KEYLESS_UNAVAILABLE", "sigstore verification could not run", {
      details: { reason: name === "TUFError" ? "TRUSTED_ROOT" : "VERIFY_FAILED", name },
      cause: err,
    });
  }

  const issuer = signer.identity?.extensions?.issuer;
  const subject = signer.identity?.subjectAlternativeName;
  const who: { issuer?: string; subject?: string } = {};
  if (issuer !== undefined) who.issuer = issuer;
  if (subject !== undefined) who.subject = subject;
  // Defence in depth: do not rely on the library alone for the issuer pin.
  if (issuer !== policy.issuer) return { ok: false, ...who, failure: "ISSUER_MISMATCH" };
  if (subject === undefined) return { ok: false, ...who, failure: "NO_IDENTITY" };
  if (!subjectRe.test(subject)) return { ok: false, ...who, failure: "SUBJECT_MISMATCH" };
  return { ok: true, ...who };
}

/** Keyless bundles carried by a ManifestBundle (structural read of `KEYLESS_BUNDLE_FIELD`). */
export function keylessSignaturesOf(bundle: object): SigstoreBundleJson[] | { invalid: true } {
  const raw = (bundle as Record<string, unknown>)[KEYLESS_BUNDLE_FIELD];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return { invalid: true };
  for (const b of raw) {
    if (
      b === null ||
      typeof b !== "object" ||
      typeof (b as { mediaType?: unknown }).mediaType !== "string"
    ) {
      return { invalid: true };
    }
  }
  return raw as SigstoreBundleJson[];
}
