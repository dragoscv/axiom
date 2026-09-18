import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigestRef, generateKeyPair, sha256Hex, signEnvelope } from "@codai/axiom-canon";
import type { ManifestBundle, TrustStore } from "@codai/axiom-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { RequireSignedParams, TRUST_STATE_FILE, verifyBundleSignatures } from "./signature.js";

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
