import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalDigestRef,
  generateKeyPair,
  sha256Hex,
  signEnvelope,
  signEnvelopeBound,
} from "@codai/axiom-canon";
import type { ManifestBundle, TrustStore } from "@codai/axiom-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import {
  RequireSignedParams,
  TRUST_STATE_FILE,
  TRUST_STATE_KEY_FILE,
  trustStateMac,
  verifyBundleSignatures,
} from "./signature.js";

const signer = generateKeyPair();
const other = generateKeyPair();
const store: TrustStore = {
  version: 1,
  keys: [{ keyid: signer.keyid, alg: "ed25519", publicKey: signer.publicKeyBase64, name: "ci" }],
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "axiom-sig-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeTrust(s: unknown, state?: unknown, file = ".axiom/trust/keys.json") {
  await mkdir(join(root, ".axiom", "trust"), { recursive: true });
  await writeFile(join(root, ...file.split("/")), JSON.stringify(s), "utf8");
  const stateFile = join(root, ...TRUST_STATE_FILE.split("/"));
  if (state === undefined) await rm(stateFile, { force: true });
  else await writeFile(stateFile, JSON.stringify(state), "utf8");
  // Tests in this file that do not exercise the MAC run without a state key.
  await rm(join(root, ...TRUST_STATE_KEY_FILE.split("/")), { force: true });
}

function bundleWith(counter?: number, keys = [signer]): ManifestBundle {
  const unsigned = makeBundle([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  if (counter !== undefined) {
    unsigned.manifest.counter = counter;
    // re-derive digest: makeBundle hashed the counter-less body
    unsigned.manifestDigest = canonicalDigestRef(unsigned.manifest);
  }
  return {
    ...unsigned,
    signatures: keys.map((k) => signEnvelope(unsigned.manifest, k.privateKey)),
  };
}

async function run(bundle: ManifestBundle, params: unknown, withRoot = true) {
  const profile = profileWith([
    {
      id: "manifest.requireSigned",
      predicate: "manifest.requireSigned",
      params: params as never,
      severity: "error",
    },
  ]);
  const opts: Parameters<typeof runChecks>[0] = { bundle, profile };
  if (withRoot) opts.root = root;
  const r = await runChecks(opts);
  return { verdict: r.verdict, ids: r.findings.map((f) => f.id), findings: r.findings };
}

describe("RequireSignedParams", () => {
  it("defaults", () => {
    expect(RequireSignedParams.parse({})).toEqual({
      minSignatures: 1,
      antiRollback: false,
      trustFile: ".axiom/trust/keys.json",
    });
    expect(RequireSignedParams.safeParse({ minSignatures: 0 }).success).toBe(false);
    expect(RequireSignedParams.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("manifest.requireSigned — fail closed", () => {
  it("no trust file → error with ERR_NOT_FOUND", async () => {
    await rm(join(root, ".axiom"), { recursive: true, force: true });
    const r = await run(bundleWith(), {});
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_NOT_FOUND");
  });
  it("unparseable trust file → error", async () => {
    await mkdir(join(root, ".axiom", "trust"), { recursive: true });
    await writeFile(join(root, ".axiom", "trust", "keys.json"), "{not json", "utf8");
    const r = await run(bundleWith(), {});
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");
  });
  it("schema-invalid trust file → error", async () => {
    await writeTrust({ version: 1, keys: [{ keyid: "x" }] });
    const r = await run(bundleWith(), {});
    expect(r.verdict).toBe("error");
  });
  it("no root → error", async () => {
    const r = await run(bundleWith(), {}, false);
    expect(r.verdict).toBe("error");
  });
  it("custom trustFile path is honoured", async () => {
    await rm(join(root, ".axiom"), { recursive: true, force: true });
    await writeTrust(store, undefined, ".axiom/trust/alt.json");
    expect((await run(bundleWith(), { trustFile: ".axiom/trust/alt.json" })).verdict).toBe("pass");
    expect((await run(bundleWith(), {})).verdict).toBe("error");
  });
});

describe("manifest.requireSigned — verification", () => {
  beforeAll(async () => {
    await writeTrust(store);
  });

  it("passes a bundle signed by a trusted key", async () => {
    expect((await run(bundleWith(), {})).verdict).toBe("pass");
  });

  it("unsigned → signature.missing", async () => {
    const b = bundleWith();
    delete b.signatures;
    const r = await run(b, {});
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.missing"]);
  });

  it("signed by an untrusted key → signature.unknownKey", async () => {
    const r = await run(bundleWith(undefined, [other]), {});
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.unknownKey"]);
    expect(r.findings[0]?.facts.hinted).toEqual([other.keyid]);
  });

  it("ANY byte change to the manifest after signing is rejected", async () => {
    const b = bundleWith();
    // attacker edits the canonical body (digest and payload no longer agree)
    const tampered: ManifestBundle = {
      ...b,
      manifest: { ...b.manifest, name: "evil" },
    };
    tampered.manifestDigest = canonicalDigestRef(tampered.manifest);
    const r = await run(tampered, {});
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.bad"]);
    expect(r.findings[0]?.facts.reason).toBe("PAYLOAD_MISMATCH");
  });

  it("a re-serialised (non-canonical) payload with a copied digest → signature.notCanonical or bad", () => {
    const b = bundleWith();
    const env = b.signatures?.[0];
    if (env === undefined) throw new Error("unsigned");
    const pretty = Buffer.from(JSON.stringify(b.manifest, null, 2)).toString("base64");
    // Payload no longer hashes to manifestDigest → PAYLOAD_MISMATCH (bad), caught before crypto.
    const v = verifyBundleSignatures(
      { manifestDigest: b.manifestDigest, signatures: [{ ...env, payload: pretty }] },
      store,
      undefined,
    );
    expect(v.keyids).toEqual([]);
    expect(v.findings.map((f) => f.id)).toEqual(["signature.bad"]);
    // Direct canon-level check covers NOT_CANONICAL when the digest is ALSO recomputed by the attacker:
    const v2 = verifyBundleSignatures(
      {
        manifestDigest: `sha256:${sha256Hex(Buffer.from(pretty, "base64"))}`,
        signatures: [{ ...env, payload: pretty }],
      },
      store,
      undefined,
    );
    expect(v2.findings.map((f) => f.id)).toEqual(["signature.notCanonical"]);
  });

  it("flipped signature bytes → signature.bad", async () => {
    const b = bundleWith();
    const env = b.signatures?.[0];
    if (env === undefined) throw new Error("unsigned");
    const sig = Buffer.from(env.signatures[0]?.sig ?? "", "base64");
    sig[10] = (sig[10] ?? 0) ^ 0x01;
    b.signatures = [{ ...env, signatures: [{ keyid: signer.keyid, sig: sig.toString("base64") }] }];
    const r = await run(b, {});
    expect(r.ids).toEqual(["signature.bad"]);
  });

  it("minSignatures: 2 with one trusted signer → signature.missing with have/need facts", async () => {
    const r = await run(bundleWith(undefined, [signer, other]), { minSignatures: 2 });
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.missing", "signature.unknownKey"]);
    const missing = r.findings.find((f) => f.id === "signature.missing");
    expect(missing?.facts.have).toEqual([signer.keyid]);
    expect(missing?.facts.need).toBe(2);
  });

  it("minSignatures: 2 satisfied when both keys are trusted", async () => {
    await writeTrust({
      version: 1,
      keys: [
        ...store.keys,
        { keyid: other.keyid, alg: "ed25519", publicKey: other.publicKeyBase64 },
      ],
    });
    expect((await run(bundleWith(undefined, [signer, other]), { minSignatures: 2 })).verdict).toBe(
      "pass",
    );
    await writeTrust(store);
  });

  it("notBefore: a key may not sign counters below its floor", async () => {
    await writeTrust({
      version: 1,
      keys: [{ ...store.keys[0], notBefore: 5 }],
    });
    expect((await run(bundleWith(4), {})).ids).toEqual(["signature.unknownKey"]);
    expect((await run(bundleWith(5), {})).verdict).toBe("pass");
    await writeTrust(store);
  });
});

describe("manifest.requireSigned — antiRollback", () => {
  it("requires a counter", async () => {
    await writeTrust(store);
    const r = await run(bundleWith(), { antiRollback: true });
    expect(r.ids).toEqual(["signature.rollback"]);
    expect(r.findings[0]?.facts.reason).toBe("NO_COUNTER");
  });

  it("first accepted manifest: no state → any counter passes (minCounter floor applies)", async () => {
    await writeTrust(store);
    expect((await run(bundleWith(0), { antiRollback: true })).verdict).toBe("pass");
    await writeTrust({ ...store, minCounter: 3 });
    const r = await run(bundleWith(2), { antiRollback: true });
    expect(r.ids).toEqual(["signature.rollback"]);
    expect(r.findings[0]?.facts.reason).toBe("BELOW_MIN");
    expect((await run(bundleWith(3), { antiRollback: true })).verdict).toBe("pass");
  });

  it("rollback attack: counter <= lastCounter is rejected, > passes", async () => {
    await writeTrust(store, { version: 1, lastCounter: 7 });
    for (const c of [0, 6, 7]) {
      const r = await run(bundleWith(c), { antiRollback: true });
      expect(r.verdict).toBe("fail");
      expect(r.ids).toEqual(["signature.rollback"]);
      expect(r.findings[0]?.facts).toMatchObject({
        reason: "ROLLBACK",
        counter: c,
        lastCounter: 7,
      });
    }
    expect((await run(bundleWith(8), { antiRollback: true })).verdict).toBe("pass");
  });

  it("an attacker cannot bump the counter without re-signing", async () => {
    await writeTrust(store, { version: 1, lastCounter: 7 });
    const b = bundleWith(3);
    const bumped: ManifestBundle = { ...b, manifest: { ...b.manifest, counter: 99 } };
    bumped.manifestDigest = canonicalDigestRef(bumped.manifest);
    const r = await run(bumped, { antiRollback: true });
    expect(r.ids).toEqual(["signature.bad"]);
  });

  it("corrupt state file → error, never pass", async () => {
    await writeTrust(store);
    await writeFile(join(root, ...TRUST_STATE_FILE.split("/")), "{oops", "utf8");
    const r = await run(bundleWith(1), { antiRollback: true });
    expect(r.verdict).toBe("error");
  });

  it("antiRollback: false ignores the state entirely", async () => {
    await writeTrust(store, { version: 1, lastCounter: 100 });
    expect((await run(bundleWith(1), {})).verdict).toBe("pass");
  });
});

describe("S-409 — root-bound signatures", () => {
  const ROOT_A = "github:dragoscv/brivio";
  const ROOT_B = "github:dragoscv/metu";
  function boundBundle(rootId: string, counter?: number): ManifestBundle {
    const b = bundleWith(counter, []);
    return { ...b, signatures: [signEnvelopeBound(b.manifest, rootId, signer.privateKey)] };
  }

  it("store without rootId accepts both unbound and bound envelopes (any rootId)", async () => {
    await writeTrust(store);
    expect((await run(bundleWith(), {})).verdict).toBe("pass");
    expect((await run(boundBundle(ROOT_A), {})).verdict).toBe("pass");
    expect((await run(boundBundle(ROOT_B), {})).verdict).toBe("pass");
  });

  it("store WITH rootId: only envelopes bound to that id verify; unbound → signature.unbound (UNBOUND); other root → signature.unbound (ROOT_MISMATCH)", async () => {
    await writeTrust({ ...store, rootId: ROOT_A });
    expect((await run(boundBundle(ROOT_A), {})).verdict).toBe("pass");
    const unbound = await run(bundleWith(), {});
    expect(unbound.verdict).toBe("fail");
    expect(unbound.ids).toContain("signature.unbound");
    expect(unbound.findings.find((f) => f.id === "signature.unbound")?.facts).toMatchObject({
      reason: "UNBOUND",
      expected: ROOT_A,
    });
    const replayed = await run(boundBundle(ROOT_B), {});
    expect(replayed.verdict).toBe("fail");
    expect(replayed.findings.find((f) => f.id === "signature.unbound")?.facts).toMatchObject({
      reason: "ROOT_MISMATCH",
      expected: ROOT_A,
      got: ROOT_B,
    });
  });

  it("a bound envelope over a different manifest, or with its rootId edited after signing, is rejected", async () => {
    await writeTrust({ ...store, rootId: ROOT_A });
    const good = boundBundle(ROOT_A);
    const otherManifest = bundleWith(undefined, []);
    otherManifest.manifest.name = "other";
    otherManifest.manifestDigest = canonicalDigestRef(otherManifest.manifest);
    // transplant A's bound envelope onto another manifest
    const transplanted: ManifestBundle = { ...otherManifest, signatures: good.signatures };
    expect((await run(transplanted, {})).ids).toEqual(["signature.bad"]);
    // edit rootId inside the payload (re-encode) — signature no longer matches
    const env = good.signatures?.[0];
    if (env === undefined) throw new Error("no env");
    const payload = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as {
      manifest: unknown;
      rootId: string;
    };
    payload.rootId = ROOT_A; // same id, but re-serialised with different key order
    const reordered = Buffer.from(
      JSON.stringify({ rootId: payload.rootId, manifest: payload.manifest }),
    ).toString("base64");
    const tampered: ManifestBundle = { ...good, signatures: [{ ...env, payload: reordered }] };
    const r = await run(tampered, {});
    expect(r.verdict).toBe("fail");
    expect(r.ids.some((id) => id === "signature.notCanonical" || id === "signature.bad")).toBe(
      true,
    );
  });

  it("verifyBundleSignatures (pure) reports the bound keyid", () => {
    const b = boundBundle(ROOT_A, 5);
    const v = verifyBundleSignatures(b, { ...store, rootId: ROOT_A }, 5);
    expect(v.findings).toEqual([]);
    expect(v.keyids).toEqual([signer.keyid]);
  });
});

describe("S-409 — authenticated trust state (state.key MAC)", () => {
  const KEY = "ab".repeat(32);
  async function writeState(state: Record<string, unknown>, withKey = KEY) {
    await writeTrust(store);
    await writeFile(join(root, ...TRUST_STATE_KEY_FILE.split("/")), `${withKey}\n`, "utf8");
    await writeFile(join(root, ...TRUST_STATE_FILE.split("/")), JSON.stringify(state), "utf8");
  }

  it("state with a valid MAC is honoured (rollback still detected)", async () => {
    const unsigned = { version: 1 as const, lastCounter: 7 };
    await writeState({ ...unsigned, mac: trustStateMac(unsigned, KEY) });
    expect((await run(bundleWith(7), { antiRollback: true })).ids).toEqual(["signature.rollback"]);
    expect((await run(bundleWith(8), { antiRollback: true })).verdict).toBe("pass");
  });

  it("hand-lowered lastCounter (MAC no longer matches) → error ERR_TRUST_STATE_CORRUPT, never pass", async () => {
    const unsigned = { version: 1 as const, lastCounter: 7 };
    await writeState({ version: 1, lastCounter: 1, mac: trustStateMac(unsigned, KEY) });
    const r = await run(bundleWith(2), { antiRollback: true });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts).toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
      reason: "BAD_MAC",
    });
  });

  it("state without mac while a key exists → error (NO_MAC); malformed key → error", async () => {
    await writeState({ version: 1, lastCounter: 7 });
    const noMac = await run(bundleWith(8), { antiRollback: true });
    expect(noMac.verdict).toBe("error");
    expect(noMac.findings[0]?.facts.reason).toBe("NO_MAC");
    await writeState({ version: 1, lastCounter: 7 }, "not-hex");
    expect((await run(bundleWith(8), { antiRollback: true })).verdict).toBe("error");
  });

  it("no state key on disk → legacy unauthenticated state still works", async () => {
    await writeTrust(store, { version: 1, lastCounter: 7 });
    expect((await run(bundleWith(8), { antiRollback: true })).verdict).toBe("pass");
  });
});
