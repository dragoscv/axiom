/**
 * `manifest.requireSigned` (D-16): the bundle must carry ≥ `minSignatures` valid DSSE
 * signatures from keys in `<root>/.axiom/trust/keys.json`, and — with `antiRollback` —
 * a `manifest.counter` strictly greater than `<root>/.axiom/trust/state.json#lastCounter`.
 *
 * Fail-closed: no root / no trust file / unreadable JSON → provider error, never pass.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE,
  AXIOM_MANIFEST_PAYLOAD_TYPE,
  canonicalize,
  sha256Hex,
  verifyEnvelope,
} from "@codai/axiom-canon";
import {
  type Finding,
  type ManifestSignature,
  type TrustState,
  TrustStateSchema,
  type TrustStore,
  TrustStoreSchema,
} from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import { finding } from "./util.js";

export const PREDICATE_ID = "manifest.requireSigned" as const;
export const TRUST_FILE_DEFAULT = ".axiom/trust/keys.json";
export const TRUST_STATE_FILE = ".axiom/trust/state.json";
/**
 * Per-root secret for the state MAC (S-409). 32 random bytes, hex, mode 0600, created by the
 * first `advanceTrustState`. A `state.json` next to a key must carry a matching `mac`; an
 * attacker who can edit `state.json` but not read the key cannot lower `lastCounter`.
 */
export const TRUST_STATE_KEY_FILE = ".axiom/trust/state.key";
const TRUST_FILE_MAX = 256 * 1024;

/** HMAC-SHA256(hex) over `JCS(state without mac)`. */
export function trustStateMac(state: TrustState, keyHex: string): string {
  const { mac: _mac, ...rest } = state;
  return createHmac("sha256", Buffer.from(keyHex.trim(), "hex"))
    .update(canonicalize(rest), "utf8")
    .digest("hex");
}

/** Constant-time compare of two hex MACs. */
export function trustStateMacOk(state: TrustState, keyHex: string): boolean {
  if (state.mac === undefined) return false;
  const a = Buffer.from(state.mac, "hex");
  const b = Buffer.from(trustStateMac(state, keyHex), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SIGNATURE_FINDING_IDS = {
  missing: "signature.missing",
  unknownKey: "signature.unknownKey",
  bad: "signature.bad",
  notCanonical: "signature.notCanonical",
  rollback: "signature.rollback",
  /** The trust store declares a `rootId` and this envelope is unbound or bound to another root (S-409). */
  unbound: "signature.unbound",
} as const;

export const RequireSignedParams = z
  .object({
    /** Distinct trusted keys that must have signed. */
    minSignatures: z.int().min(1).max(16).default(1),
    /** Require `manifest.counter` and enforce `counter > lastCounter`. */
    antiRollback: z.boolean().default(false),
    /** Relative POSIX path of the trust store under the root. */
    trustFile: z.string().min(1).default(TRUST_FILE_DEFAULT),
  })
  .strict();

export type RequireSignedParamsT = z.infer<typeof RequireSignedParams>;

function providerError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Finding {
  return finding({
    id: PREDICATE_ID,
    predicate: PREDICATE_ID,
    message,
    facts: { code, __provider: true, ...extra },
  });
}

function fail(
  id: (typeof SIGNATURE_FINDING_IDS)[keyof typeof SIGNATURE_FINDING_IDS],
  message: string,
  facts: Record<string, unknown> = {},
): Finding {
  return finding({ id, predicate: PREDICATE_ID, message, facts });
}

async function readJsonFile(
  ctx: FactContext,
  rel: string,
): Promise<{ value: unknown } | { missing: true } | { error: string }> {
  const repo = ctx.facts.repo;
  if (repo === undefined) return { error: "no root" };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await repo.read(rel, TRUST_FILE_MAX);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (bytes === undefined) return { missing: true };
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Resolve the trust store; `undefined` when the caller must emit the returned finding instead. */
export async function loadTrustStore(
  ctx: FactContext,
  trustFile: string,
): Promise<{ store: TrustStore } | { finding: Finding }> {
  if (ctx.facts.repo === undefined) {
    return {
      finding: providerError(
        "ERR_PROVIDER_FAILED",
        "manifest.requireSigned needs a repo root to read the trust store",
      ),
    };
  }
  const r = await readJsonFile(ctx, trustFile);
  if ("missing" in r) {
    return {
      finding: providerError("ERR_NOT_FOUND", `trust store ${trustFile} not found`, {
        trustFile,
      }),
    };
  }
  if ("error" in r) {
    return {
      finding: providerError("ERR_PROVIDER_FAILED", `trust store ${trustFile}: ${r.error}`, {
        trustFile,
      }),
    };
  }
  const parsed = TrustStoreSchema.safeParse(r.value);
  if (!parsed.success) {
    return {
      finding: providerError("ERR_PROVIDER_FAILED", `trust store ${trustFile} is invalid`, {
        trustFile,
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      }),
    };
  }
  return { store: parsed.data };
}

export async function loadTrustState(
  ctx: FactContext,
): Promise<{ state: TrustState | undefined } | { finding: Finding }> {
  const r = await readJsonFile(ctx, TRUST_STATE_FILE);
  if ("missing" in r) return { state: undefined };
  if ("error" in r) {
    return {
      finding: providerError(
        "ERR_TRUST_STATE_CORRUPT",
        `trust state ${TRUST_STATE_FILE}: ${r.error}`,
      ),
    };
  }
  const parsed = TrustStateSchema.safeParse(r.value);
  if (!parsed.success) {
    return {
      finding: providerError(
        "ERR_TRUST_STATE_CORRUPT",
        `trust state ${TRUST_STATE_FILE} is invalid`,
      ),
    };
  }
  // S-409: when the root holds a state key, the state must be authenticated by it.
  const k = await readTextFile(ctx, TRUST_STATE_KEY_FILE);
  if ("error" in k) {
    return {
      finding: providerError(
        "ERR_TRUST_STATE_CORRUPT",
        `trust state key ${TRUST_STATE_KEY_FILE}: ${k.error}`,
      ),
    };
  }
  if ("value" in k) {
    if (!/^[0-9a-f]{64}$/.test(k.value.trim())) {
      return {
        finding: providerError(
          "ERR_TRUST_STATE_CORRUPT",
          `trust state key ${TRUST_STATE_KEY_FILE} is not 32 hex bytes`,
        ),
      };
    }
    if (!trustStateMacOk(parsed.data, k.value)) {
      return {
        finding: providerError(
          "ERR_TRUST_STATE_CORRUPT",
          `trust state ${TRUST_STATE_FILE} failed its MAC (edited by hand, or state.key rotated)`,
          { reason: parsed.data.mac === undefined ? "NO_MAC" : "BAD_MAC" },
        ),
      };
    }
  }
  return { state: parsed.data };
}

async function readTextFile(
  ctx: FactContext,
  rel: string,
): Promise<{ value: string } | { missing: true } | { error: string }> {
  const repo = ctx.facts.repo;
  if (repo === undefined) return { error: "no root" };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await repo.read(rel, 4096);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (bytes === undefined) return { missing: true };
  return { value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

export interface SignatureVerdict {
  /** Distinct trusted keyids with a valid signature over THIS manifest. */
  keyids: string[];
  findings: Finding[];
}

/** Verify every detached envelope in the bundle against `store`. Pure; no I/O. */
export function verifyBundleSignatures(
  bundle: { manifestDigest: string; signatures?: readonly ManifestSignature[] | undefined },
  store: TrustStore,
  counter: number | undefined,
): SignatureVerdict {
  const findings: Finding[] = [];
  const envs = bundle.signatures ?? [];
  if (envs.length === 0) {
    return { keyids: [], findings: [fail("signature.missing", "bundle carries no signatures")] };
  }
  const keyids = new Set<string>();
  const eligible = store.keys.filter(
    (k) => k.notBefore === undefined || (counter !== undefined && counter >= k.notBefore),
  );
  for (const [i, env] of envs.entries()) {
    const payload = Buffer.from(env.payload, "base64");
    if (env.payloadType === AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE) {
      // Bound payload: `JCS({ manifest, rootId })`. The manifest inside must be THIS
      // manifest (its JCS digest is the manifestDigest) and the rootId must be the store's.
      let parsed: { manifest?: unknown; rootId?: unknown } | undefined;
      try {
        parsed = JSON.parse(payload.toString("utf8")) as { manifest?: unknown; rootId?: unknown };
      } catch {
        parsed = undefined;
      }
      const innerDigest =
        parsed?.manifest === undefined
          ? undefined
          : `sha256:${sha256Hex(Buffer.from(canonicalize(parsed.manifest), "utf8"))}`;
      if (innerDigest !== bundle.manifestDigest) {
        findings.push(
          fail("signature.bad", `signatures[${i}] signs a different manifest`, {
            reason: "PAYLOAD_MISMATCH",
            ...(innerDigest === undefined ? {} : { payloadDigest: innerDigest }),
          }),
        );
        continue;
      }
      if (store.rootId !== undefined && parsed?.rootId !== store.rootId) {
        findings.push(
          fail("signature.unbound", `signatures[${i}] is bound to another root`, {
            reason: "ROOT_MISMATCH",
            index: i,
            expected: store.rootId,
            got: typeof parsed?.rootId === "string" ? parsed.rootId : null,
          }),
        );
        continue;
      }
    } else {
      const payloadDigest = `sha256:${sha256Hex(payload)}`;
      if (payloadDigest !== bundle.manifestDigest) {
        findings.push(
          fail("signature.bad", `signatures[${i}] signs a different manifest`, {
            reason: "PAYLOAD_MISMATCH",
            payloadDigest,
          }),
        );
        continue;
      }
      if (store.rootId !== undefined) {
        findings.push(
          fail(
            "signature.unbound",
            `signatures[${i}] is not bound to a root; this trust store requires rootId ${store.rootId}`,
            {
              reason: "UNBOUND",
              index: i,
              expected: store.rootId,
            },
          ),
        );
        continue;
      }
    }
    const r = verifyEnvelope(
      env,
      eligible,
      env.payloadType === AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE
        ? AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE
        : AXIOM_MANIFEST_PAYLOAD_TYPE,
    );
    if (r.ok) {
      for (const k of r.keyids) keyids.add(k);
      continue;
    }
    const detail = { reason: r.reason, index: i };
    switch (r.reason) {
      case "NOT_CANONICAL":
        findings.push(
          fail("signature.notCanonical", `signatures[${i}] payload is not JCS-canonical`, detail),
        );
        break;
      case "UNKNOWN_KEY":
        findings.push(
          fail("signature.unknownKey", `signatures[${i}] is not from a trusted key`, {
            ...detail,
            hinted: env.signatures.map((s) => s.keyid ?? null),
          }),
        );
        break;
      default:
        findings.push(fail("signature.bad", `signatures[${i}] failed verification`, detail));
    }
  }
  return { keyids: [...keyids].sort(), findings };
}

export const manifestRequireSigned = definePredicate<RequireSignedParamsT>({
  id: PREDICATE_ID,
  params: RequireSignedParams,
  requires: ["manifest"],
  async run(ctx, params) {
    const loaded = await loadTrustStore(ctx, params.trustFile);
    if ("finding" in loaded) return [loaded.finding];
    const store = loaded.store;
    const counter = ctx.manifest.counter;

    const { keyids, findings } = verifyBundleSignatures(ctx.bundle, store, counter);
    const out: Finding[] = [];
    if (keyids.length < params.minSignatures) {
      // Report the concrete reasons; if every envelope verified but too few keys, say so.
      out.push(...findings);
      if (findings.length === 0 || keyids.length > 0) {
        out.push(
          fail(
            "signature.missing",
            `need ${params.minSignatures} trusted signature(s), have ${keyids.length}`,
            { have: keyids, need: params.minSignatures },
          ),
        );
      }
      return dedupe(out);
    }

    if (params.antiRollback) {
      if (counter === undefined) {
        return [
          fail("signature.rollback", "antiRollback requires manifest.counter", {
            reason: "NO_COUNTER",
          }),
        ];
      }
      const st = await loadTrustState(ctx);
      if ("finding" in st) return [st.finding];
      const last = st.state?.lastCounter;
      const floor = store.minCounter;
      if (last !== undefined && counter <= last) {
        return [
          fail("signature.rollback", `counter ${counter} is not greater than last ${last}`, {
            reason: "ROLLBACK",
            counter,
            lastCounter: last,
          }),
        ];
      }
      if (floor !== undefined && counter < floor) {
        return [
          fail("signature.rollback", `counter ${counter} is below trust minCounter ${floor}`, {
            reason: "BELOW_MIN",
            counter,
            minCounter: floor,
          }),
        ];
      }
    }
    return [];
  },
});

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.id}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
