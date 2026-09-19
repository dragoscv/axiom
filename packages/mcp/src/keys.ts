/**
 * Key material and trust-store I/O for the CLI/MCP layer (D-16).
 *
 * Private keys are read ONLY from `AXIOM_SIGNING_KEY` (base64 PKCS#8 or raw seed) or
 * `--key-file <path>`; they are never written to stdout and never stored under a root.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  generateKeyPair,
  keyidFor,
  privateKeyFrom,
  publicKeyBase64,
  publicKeyFrom,
  signEnvelope,
  signEnvelopeBound,
} from "@codai/axiom-canon";
import {
  TRUST_FILE_DEFAULT,
  TRUST_STATE_FILE,
  TRUST_STATE_KEY_FILE,
  trustStateMac,
  trustStateMacOk,
  verifyBundleSignatures,
} from "@codai/axiom-checks";
import {
  AxiomError,
  type ManifestBundle,
  type ManifestSignature,
  RootIdSchema,
  type TrustedKey,
  TrustedKeySchema,
  type TrustState,
  TrustStateSchema,
  type TrustStore,
  TrustStoreSchema,
} from "@codai/axiom-schema";

export const SIGNING_KEY_ENV = "AXIOM_SIGNING_KEY";

export function trustFilePath(root: string, rel: string = TRUST_FILE_DEFAULT): string {
  return path.join(root, ...rel.split("/"));
}
export function trustStatePath(root: string): string {
  return path.join(root, ...TRUST_STATE_FILE.split("/"));
}
export function trustStateKeyPath(root: string): string {
  return path.join(root, ...TRUST_STATE_KEY_FILE.split("/"));
}

async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  if (mode !== undefined) await chmod(tmp, mode).catch(() => undefined);
  await rename(tmp, file);
}

async function readJsonOrUndefined(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

// --- key generation ---------------------------------------------------------------

export interface KeygenResult {
  /** Trust-store entry for the public key (safe to print). */
  publicEntry: TrustedKey;
  /** Where the private key was written (mode 0600). */
  privateKeyFile: string;
}

/**
 * Generate an Ed25519 key pair. Writes `<outDir>/axiom-signing-<keyid16>.key` (base64
 * PKCS#8, mode 0600) and returns the public entry. Refuses to overwrite.
 */
export async function keygen(outDir: string, name?: string): Promise<KeygenResult> {
  const kp = generateKeyPair();
  const file = path.join(outDir, `axiom-signing-${kp.keyid.slice(0, 16)}.key`);
  await mkdir(outDir, { recursive: true });
  try {
    await writeFile(file, `${kp.privateKeyBase64}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST")
      throw new AxiomError("ERR_EXISTS", `refusing to overwrite ${file}`, { path: file });
    throw err;
  }
  await chmod(file, 0o600).catch(() => undefined);
  const publicEntry: TrustedKey = {
    keyid: kp.keyid,
    alg: "ed25519",
    publicKey: kp.publicKeyBase64,
  };
  if (name !== undefined) publicEntry.name = name;
  return { publicEntry, privateKeyFile: file };
}

// --- private key loading ------------------------------------------------------------

export interface SigningKeySource {
  keyFile?: string;
  env?: NodeJS.ProcessEnv;
}

/** `--key-file` wins over the env var. Throws `ERR_NOT_FOUND` when neither is present. */
export async function loadSigningKey(src: SigningKeySource) {
  let material: string | undefined;
  if (src.keyFile !== undefined) {
    material = await readFile(path.resolve(src.keyFile), "utf8");
  } else {
    material = (src.env ?? process.env)[SIGNING_KEY_ENV];
  }
  if (material === undefined || material.trim().length === 0) {
    throw new AxiomError(
      "ERR_NOT_FOUND",
      `no signing key: set ${SIGNING_KEY_ENV} (base64 PKCS#8 or raw seed) or pass --key-file`,
    );
  }
  try {
    return privateKeyFrom(material);
  } catch (err) {
    throw new AxiomError(
      "ERR_SIGNATURE_INVALID",
      "signing key material is not a usable ed25519 key",
      {
        cause: err,
      },
    );
  }
}

// --- sign / verify ------------------------------------------------------------------

/**
 * Append a detached signature over `bundle.manifest`. Idempotent per key (same key → replaced).
 * With `rootId` (S-409) the envelope is root-bound: payload `JCS({ manifest, rootId })` under
 * `application/vnd.axiom.manifest-bound+json`, valid only for a trust store declaring that id.
 */
export async function signBundle(
  bundle: ManifestBundle,
  src: SigningKeySource,
  rootId?: string,
): Promise<{ bundle: ManifestBundle; keyid: string }> {
  const key = await loadSigningKey(src);
  const keyid = keyidFor(key);
  if (rootId !== undefined) {
    const p = RootIdSchema.safeParse(rootId);
    if (!p.success) {
      throw new AxiomError("ERR_INVALID_PROFILE", "invalid rootId", {
        details: { issues: p.error.issues.map((i) => i.message) },
      });
    }
  }
  const env = (
    rootId === undefined
      ? signEnvelope(bundle.manifest, key, keyid)
      : signEnvelopeBound(bundle.manifest, rootId, key, keyid)
  ) as ManifestSignature;
  const others = (bundle.signatures ?? []).filter(
    (s) => !s.signatures.some((x) => x.keyid === keyid),
  );
  return { bundle: { ...bundle, signatures: [...others, env] }, keyid };
}

export interface BundleSignatureReport {
  /** Trust store existed and was valid. */
  trustFile: string;
  keyids: string[];
  findings: { id: string; message: string }[];
  ok: boolean;
  /**
   * Present when `ok` is false: `ERR_SIGNATURE_MISSING` when the bundle carries no
   * signature at all, `ERR_SIGNATURE_INVALID` for every other failure (unknown key, bad
   * signature, non-canonical payload, rollback).
   */
  code?: "ERR_SIGNATURE_MISSING" | "ERR_SIGNATURE_INVALID";
}

/** Verify a bundle's detached signatures against the root's trust store; `undefined` when no store. */
export async function verifyBundleAgainstRoot(
  root: string,
  bundle: ManifestBundle,
  rel: string = TRUST_FILE_DEFAULT,
): Promise<BundleSignatureReport | undefined> {
  const store = await loadTrustStore(root, rel);
  if (store === undefined) return undefined;
  const v = verifyBundleSignatures(bundle, store, bundle.manifest.counter);
  const report: BundleSignatureReport = {
    trustFile: rel,
    keyids: v.keyids,
    findings: v.findings.map((f) => ({ id: f.id, message: f.message })),
    ok: v.keyids.length > 0 && v.findings.length === 0,
  };
  if (!report.ok) {
    report.code =
      (bundle.signatures ?? []).length === 0 ? "ERR_SIGNATURE_MISSING" : "ERR_SIGNATURE_INVALID";
  }
  return report;
}

/** Verify against an explicit set of trusted keys (no root). */
export function verifyBundleWithKeys(bundle: ManifestBundle, keys: TrustedKey[]) {
  const store: TrustStore = { version: 1, keys };
  return verifyBundleSignatures(bundle, store, bundle.manifest.counter);
}

// --- trust store ------------------------------------------------------------------

export async function loadTrustStore(
  root: string,
  rel: string = TRUST_FILE_DEFAULT,
): Promise<TrustStore | undefined> {
  const raw = await readJsonOrUndefined(trustFilePath(root, rel));
  if (raw === undefined) return undefined;
  const parsed = TrustStoreSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_PROFILE", `trust store ${rel} is invalid`, {
      details: { issues: parsed.error.issues.slice(0, 10).map((i) => i.message) },
    });
  }
  return parsed.data;
}

/** Parse a public-key entry file: a `TrustedKey` JSON, or a keygen output `{ publicEntry }`. */
export function parsePublicEntry(raw: unknown): TrustedKey {
  const candidate =
    typeof raw === "object" && raw !== null && "publicEntry" in raw
      ? (raw as { publicEntry: unknown }).publicEntry
      : raw;
  const parsed = TrustedKeySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_PROFILE", "not a trusted-key entry", {
      details: { issues: parsed.error.issues.slice(0, 10).map((i) => i.message) },
    });
  }
  // The keyid MUST match the key material; never trust a supplied keyid blindly.
  const derived = keyidFor(publicKeyBase64(publicKeyFrom(parsed.data.publicKey)));
  if (derived !== parsed.data.keyid) {
    throw new AxiomError("ERR_SIGNATURE_INVALID", "keyid does not match publicKey", {
      details: { keyid: parsed.data.keyid, derived },
    });
  }
  return parsed.data;
}

/** Add (or replace by keyid) a key; creates the store when missing. Atomic write. */
export async function trustAdd(
  root: string,
  entry: TrustedKey,
  rel: string = TRUST_FILE_DEFAULT,
): Promise<TrustStore> {
  const store = (await loadTrustStore(root, rel)) ?? { version: 1 as const, keys: [] };
  const keys = store.keys.filter((k) => k.keyid !== entry.keyid);
  keys.push(entry);
  keys.sort((a, b) => (a.keyid < b.keyid ? -1 : a.keyid > b.keyid ? 1 : 0));
  const next: TrustStore = { ...store, keys };
  await writeJsonAtomic(trustFilePath(root, rel), next);
  return next;
}

export async function trustRemove(
  root: string,
  keyid: string,
  rel: string = TRUST_FILE_DEFAULT,
): Promise<TrustStore> {
  const store = await loadTrustStore(root, rel);
  if (store === undefined) throw new AxiomError("ERR_NOT_FOUND", `trust store ${rel} not found`);
  const keys = store.keys.filter((k) => k.keyid !== keyid);
  if (keys.length === store.keys.length)
    throw new AxiomError("ERR_NOT_FOUND", `keyid ${keyid} not in trust store`);
  const next: TrustStore = { ...store, keys };
  await writeJsonAtomic(trustFilePath(root, rel), next);
  return next;
}

/**
 * Set (or clear with `undefined`) the trust store's `rootId` (S-409). Creates the store when
 * missing. Once set, only root-bound signatures carrying this id verify.
 */
export async function trustSetRootId(
  root: string,
  rootId: string | undefined,
  rel: string = TRUST_FILE_DEFAULT,
): Promise<TrustStore> {
  const store = (await loadTrustStore(root, rel)) ?? { version: 1 as const, keys: [] };
  const next: TrustStore = { ...store };
  if (rootId === undefined) delete next.rootId;
  else {
    const p = RootIdSchema.safeParse(rootId);
    if (!p.success) {
      throw new AxiomError("ERR_INVALID_PROFILE", "invalid rootId", {
        details: { issues: p.error.issues.map((i) => i.message) },
      });
    }
    next.rootId = p.data;
  }
  await writeJsonAtomic(trustFilePath(root, rel), next);
  return next;
}

// --- anti-rollback state ------------------------------------------------------------

async function loadStateKey(root: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(trustStateKeyPath(root), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new AxiomError("ERR_TRUST_STATE_CORRUPT", `${TRUST_STATE_KEY_FILE} is not 32 hex bytes`);
  }
  return hex;
}

/** Create `.axiom/trust/state.key` (32 random bytes, hex, 0600) when absent; return the key. */
async function ensureStateKey(root: string): Promise<string> {
  const existing = await loadStateKey(root);
  if (existing !== undefined) return existing;
  const hex = randomBytes(32).toString("hex");
  const file = trustStateKeyPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${hex}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, file);
  return hex;
}

export async function loadTrustState(root: string): Promise<TrustState | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonOrUndefined(trustStatePath(root));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AxiomError("ERR_TRUST_STATE_CORRUPT", `${TRUST_STATE_FILE} is not valid JSON`, {
        cause: err,
      });
    }
    throw err;
  }
  if (raw === undefined) return undefined;
  const parsed = TrustStateSchema.safeParse(raw);
  if (!parsed.success)
    throw new AxiomError("ERR_TRUST_STATE_CORRUPT", `${TRUST_STATE_FILE} is invalid`, {
      details: { issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
    });
  // S-409: a state file next to a state key must be authenticated by it.
  const keyHex = await loadStateKey(root);
  if (keyHex !== undefined && !trustStateMacOk(parsed.data, keyHex)) {
    throw new AxiomError(
      "ERR_TRUST_STATE_CORRUPT",
      `${TRUST_STATE_FILE} failed its MAC (edited by hand, or ${TRUST_STATE_KEY_FILE} rotated)`,
      { details: { reason: parsed.data.mac === undefined ? "NO_MAC" : "BAD_MAC" } },
    );
  }
  return parsed.data;
}

/**
 * Advance `lastCounter` to `bundle.manifest.counter` after a successful apply.
 * Monotonic: never moves backwards; a no-op when the bundle has no counter.
 * Write-temp + rename so a crash leaves either the old or the new state.
 */
export async function advanceTrustState(
  root: string,
  bundle: ManifestBundle,
): Promise<TrustState | undefined> {
  const counter = bundle.manifest.counter;
  if (counter === undefined) return undefined;
  const cur = await loadTrustState(root);
  if (cur !== undefined && cur.lastCounter >= counter) return cur;
  const keyHex = await ensureStateKey(root);
  const unsigned: TrustState = {
    version: 1,
    lastCounter: counter,
    manifestDigest: bundle.manifestDigest,
  };
  const next: TrustState = { ...unsigned, mac: trustStateMac(unsigned, keyHex) };
  await writeJsonAtomic(trustStatePath(root), next);
  return next;
}

/** Test helper / `trust reset`: remove the state file (the state key is kept). */
export async function resetTrustState(root: string): Promise<void> {
  await rm(trustStatePath(root), { force: true });
}

/** Does the resolved profile (plus plan checks) enable antiRollback on requireSigned? */
export function profileWantsAntiRollback(
  checks: readonly { predicate: string; params: unknown }[],
): boolean {
  return checks.some(
    (c) =>
      c.predicate === "manifest.requireSigned" &&
      typeof c.params === "object" &&
      c.params !== null &&
      (c.params as { antiRollback?: unknown }).antiRollback === true,
  );
}
