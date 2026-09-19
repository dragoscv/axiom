import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalDigestRef, generateKeyPair, keyidFor, signEnvelope } from "@codai/axiom-canon";
import { trustStateMac } from "@codai/axiom-checks";
import { compilePlan } from "@codai/axiom-plan";
import type { ApplyResult, ManifestBundle, TrustState } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advanceTrustState,
  keygen,
  loadSigningKey,
  loadTrustState,
  loadTrustStore,
  parsePublicEntry,
  profileWantsAntiRollback,
  resetTrustState,
  SIGNING_KEY_ENV,
  signBundle,
  trustAdd,
  trustRemove,
  trustSetRootId,
  trustStateKeyPath,
  trustStatePath,
  verifyBundleAgainstRoot,
} from "./keys.js";
import { type Harness, harness, makePlan, structured, tmpRepo } from "./test-helpers.js";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const hasDist = existsSync(CLI);

let repo: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-keys-");
});
afterEach(async () => {
  await repo.cleanup();
});

async function compiled(counter?: number, file = "src/a.ts"): Promise<ManifestBundle> {
  const plan = makePlan({ [file]: "export const a = 1;\n" }, { name: "signed" });
  const r = await compilePlan(counter === undefined ? plan : { ...plan, counter });
  return r.bundle;
}

describe("keys.ts (unit)", () => {
  it("keygen writes a 0600 private key file and returns a matching public entry", async () => {
    const out = join(repo.root, "keys");
    const r = await keygen(out, "ci");
    expect(r.publicEntry).toMatchObject({ alg: "ed25519", name: "ci" });
    expect(r.publicEntry.keyid).toMatch(/^[0-9a-f]{64}$/);
    expect(keyidFor(r.publicEntry.publicKey)).toBe(r.publicEntry.keyid);
    const text = await readFile(r.privateKeyFile, "utf8");
    expect(text.trim()).not.toBe("");
    if (process.platform !== "win32") {
      expect((await stat(r.privateKeyFile)).mode & 0o777).toBe(0o600);
    }
  });

  it("loadSigningKey: --key-file wins over env; raw seed and PKCS#8 both load; none → ERR_NOT_FOUND", async () => {
    const kp = generateKeyPair();
    const file = join(repo.root, "k.key");
    await writeFile(file, kp.privateKeyBase64);
    const fromFile = await loadSigningKey({ keyFile: file, env: { [SIGNING_KEY_ENV]: "garbage" } });
    expect(keyidFor(fromFile)).toBe(kp.keyid);
    const seed = Buffer.from(kp.privateKey.export({ type: "pkcs8", format: "der" }))
      .subarray(-32)
      .toString("base64");
    const fromSeed = await loadSigningKey({ env: { [SIGNING_KEY_ENV]: seed } });
    expect(keyidFor(fromSeed)).toBe(kp.keyid);
    await expect(loadSigningKey({ env: {} })).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
    await expect(
      loadSigningKey({ env: { [SIGNING_KEY_ENV]: "bm90IGEga2V5" } }),
    ).rejects.toMatchObject({
      code: "ERR_SIGNATURE_INVALID",
    });
  });

  it("signBundle appends a detached envelope and leaves manifestDigest unchanged; re-signing with the same key replaces", async () => {
    const kp = generateKeyPair();
    const b = await compiled();
    const env = { [SIGNING_KEY_ENV]: kp.privateKeyBase64 };
    const s1 = await signBundle(b, { env });
    expect(s1.keyid).toBe(kp.keyid);
    expect(s1.bundle.manifestDigest).toBe(b.manifestDigest);
    expect(s1.bundle.signatures).toHaveLength(1);
    const s2 = await signBundle(s1.bundle, { env });
    expect(s2.bundle.signatures).toHaveLength(1);
    const other = generateKeyPair();
    const s3 = await signBundle(s2.bundle, { env: { [SIGNING_KEY_ENV]: other.privateKeyBase64 } });
    expect(s3.bundle.signatures).toHaveLength(2);
  });

  it("trust add/list/remove: keyid must match material, store sorted by keyid, atomic file", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(await loadTrustStore(repo.root)).toBeUndefined();
    const entryA = parsePublicEntry({
      keyid: a.keyid,
      alg: "ed25519",
      publicKey: a.publicKeyBase64,
    });
    // keygen-shaped input is accepted too
    const entryB = parsePublicEntry({
      publicEntry: { keyid: b.keyid, alg: "ed25519", publicKey: b.publicKeyBase64, name: "b" },
    });
    expect(() =>
      parsePublicEntry({ keyid: a.keyid, alg: "ed25519", publicKey: b.publicKeyBase64 }),
    ).toThrowError(/keyid does not match/);
    await trustAdd(repo.root, entryA);
    const store = await trustAdd(repo.root, entryB);
    expect(store.keys.map((k) => k.keyid)).toEqual([a.keyid, b.keyid].sort());
    const files = await readFile(join(repo.root, ".axiom", "trust", "keys.json"), "utf8");
    expect(JSON.parse(files)).toEqual(store);
    const after = await trustRemove(repo.root, a.keyid);
    expect(after.keys.map((k) => k.keyid)).toEqual([b.keyid]);
    await expect(trustRemove(repo.root, a.keyid)).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
  });

  it("verifyBundleAgainstRoot: undefined without a store; ok only for trusted keys; every byte change rejected", async () => {
    const kp = generateKeyPair();
    const b = await compiled(3);
    const signed = { ...b, signatures: [signEnvelope(b.manifest, kp.privateKey)] };
    expect(await verifyBundleAgainstRoot(repo.root, signed)).toBeUndefined();
    await trustAdd(repo.root, { keyid: kp.keyid, alg: "ed25519", publicKey: kp.publicKeyBase64 });
    const ok = await verifyBundleAgainstRoot(repo.root, signed);
    expect(ok).toMatchObject({ ok: true, keyids: [kp.keyid], findings: [] });

    // Tamper the body and keep the bundle self-consistent (digest recomputed): the envelope
    // now signs a different manifest than the one the bundle claims → signature.bad.
    const tampered = structuredClone(signed);
    tampered.manifest.counter = 4;
    tampered.manifestDigest = canonicalDigestRef(tampered.manifest);
    const r = await verifyBundleAgainstRoot(repo.root, tampered);
    expect(r?.ok).toBe(false);
    expect(r?.findings.map((f) => f.id)).toEqual(["signature.bad"]);
    // Tamper only the signed payload bytes (digest kept) → the envelope no longer matches the digest.
    const flipped = structuredClone(signed);
    const first = flipped.signatures[0];
    if (first === undefined) throw new Error("unreachable");
    const buf = Buffer.from(first.payload, "base64");
    buf[buf.length - 2] = buf[buf.length - 2] === 0x7d ? 0x5d : 0x7d;
    flipped.signatures[0] = { ...first, payload: buf.toString("base64") };
    const f = await verifyBundleAgainstRoot(repo.root, flipped);
    expect(f?.ok).toBe(false);
    expect(f?.findings.map((x) => x.id)).toEqual(["signature.bad"]);

    const stranger = { ...b, signatures: [signEnvelope(b.manifest, generateKeyPair().privateKey)] };
    const u = await verifyBundleAgainstRoot(repo.root, stranger);
    expect(u?.findings.map((f) => f.id)).toEqual(["signature.unknownKey"]);
    expect(u?.code).toBe("ERR_SIGNATURE_INVALID");
    expect(r?.code).toBe("ERR_SIGNATURE_INVALID");
    expect(ok?.code).toBeUndefined();
  });

  it("ERR_SIGNATURE_MISSING: a trust store exists but the bundle carries no signature at all", async () => {
    const kp = generateKeyPair();
    await trustAdd(repo.root, { keyid: kp.keyid, alg: "ed25519", publicKey: kp.publicKeyBase64 });
    const unsigned = await compiled(1);
    expect(unsigned.signatures).toBeUndefined();
    const r = await verifyBundleAgainstRoot(repo.root, unsigned);
    expect(r).toMatchObject({
      ok: false,
      code: "ERR_SIGNATURE_MISSING",
      keyids: [],
      findings: [{ id: "signature.missing" }],
    });
    // Empty array is the same thing as absent.
    const empty = await verifyBundleAgainstRoot(repo.root, { ...unsigned, signatures: [] });
    expect(empty?.code).toBe("ERR_SIGNATURE_MISSING");
  });

  it("ERR_TRUST_STATE_CORRUPT: a state.json that is not JSON or fails the schema is refused, never treated as 'no state'", async () => {
    await mkdir(dirname(trustStatePath(repo.root)), { recursive: true });
    await writeFile(trustStatePath(repo.root), "{oops");
    await expect(loadTrustState(repo.root)).rejects.toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
    });
    await writeFile(trustStatePath(repo.root), JSON.stringify({ version: 1, lastCounter: "9" }));
    await expect(loadTrustState(repo.root)).rejects.toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
    });
    // A corrupt state must not be silently overwritten by an advance either.
    await expect(advanceTrustState(repo.root, await compiled(5))).rejects.toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
    });
    expect(await readFile(trustStatePath(repo.root), "utf8")).toBe(
      JSON.stringify({ version: 1, lastCounter: "9" }),
    );
  });

  it("advanceTrustState is monotonic, atomic and a no-op without a counter", async () => {
    expect(await loadTrustState(repo.root)).toBeUndefined();
    expect(await advanceTrustState(repo.root, await compiled())).toBeUndefined();
    expect(existsSync(trustStatePath(repo.root))).toBe(false);
    const s5 = await advanceTrustState(repo.root, await compiled(5));
    expect(s5).toMatchObject({ version: 1, lastCounter: 5 });
    const s3 = await advanceTrustState(repo.root, await compiled(3));
    expect(s3?.lastCounter).toBe(5);
    const s9 = await advanceTrustState(repo.root, await compiled(9));
    expect(s9?.lastCounter).toBe(9);
    const onDisk = JSON.parse(await readFile(trustStatePath(repo.root), "utf8")) as TrustState;
    expect(onDisk.lastCounter).toBe(9);
    expect(onDisk.manifestDigest).toMatch(/^sha256:/);
  });

  it("S-409: advanceTrustState creates state.key (0600) and writes a MAC; a hand-lowered state is ERR_TRUST_STATE_CORRUPT; the key survives reset", async () => {
    const s5 = await advanceTrustState(repo.root, await compiled(5));
    expect(s5?.mac).toMatch(/^[0-9a-f]{64}$/);
    const keyFile = trustStateKeyPath(repo.root);
    const keyHex = (await readFile(keyFile, "utf8")).trim();
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(await readFile(trustStatePath(repo.root), "utf8")) as TrustState;
    expect(onDisk.mac).toBe(
      trustStateMac({ version: 1, lastCounter: 5, manifestDigest: onDisk.manifestDigest }, keyHex),
    );
    expect(await loadTrustState(repo.root)).toMatchObject({ lastCounter: 5 });
    // second advance reuses the same key
    await advanceTrustState(repo.root, await compiled(6));
    expect((await readFile(keyFile, "utf8")).trim()).toBe(keyHex);
    // attacker lowers lastCounter without the key
    await writeFile(
      trustStatePath(repo.root),
      JSON.stringify({ ...onDisk, lastCounter: 1 }),
      "utf8",
    );
    await expect(loadTrustState(repo.root)).rejects.toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
    });
    await expect(advanceTrustState(repo.root, await compiled(2))).rejects.toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
    });
    // ...or strips the mac
    const { mac: _m, ...noMac } = onDisk;
    await writeFile(trustStatePath(repo.root), JSON.stringify(noMac), "utf8");
    await expect(loadTrustState(repo.root)).rejects.toMatchObject({
      code: "ERR_TRUST_STATE_CORRUPT",
    });
    // reset keeps the key; the next advance is MAC'd with it again
    await resetTrustState(repo.root);
    expect(existsSync(keyFile)).toBe(true);
    const s9 = await advanceTrustState(repo.root, await compiled(9));
    expect(s9?.mac).toBe(
      trustStateMac({ version: 1, lastCounter: 9, manifestDigest: s9?.manifestDigest }, keyHex),
    );
  });

  it("S-409: signBundle --root-id produces a bound envelope; verifyBundleAgainstRoot enforces the store's rootId; trustSetRootId validates and clears", async () => {
    const kp = generateKeyPair();
    const src = { keyFile: join(repo.root, "k.key") };
    await writeFile(src.keyFile, kp.privateKeyBase64, "utf8");
    await trustAdd(repo.root, {
      keyid: kp.keyid,
      alg: "ed25519",
      publicKey: kp.publicKeyBase64,
    });
    const b = await compiled(1);
    const bound = (await signBundle(b, src, "github:dragoscv/axiom")).bundle;
    expect(bound.signatures?.[0]?.payloadType).toBe("application/vnd.axiom.manifest-bound+json");
    expect(bound.manifestDigest).toBe(b.manifestDigest);
    const unbound = (await signBundle(b, src)).bundle;
    // store without rootId: both ok
    expect((await verifyBundleAgainstRoot(repo.root, bound))?.ok).toBe(true);
    expect((await verifyBundleAgainstRoot(repo.root, unbound))?.ok).toBe(true);
    // bind the store
    const store = await trustSetRootId(repo.root, "github:dragoscv/axiom");
    expect(store.rootId).toBe("github:dragoscv/axiom");
    expect((await verifyBundleAgainstRoot(repo.root, bound))?.ok).toBe(true);
    const rej = await verifyBundleAgainstRoot(repo.root, unbound);
    expect(rej?.ok).toBe(false);
    expect(rej?.code).toBe("ERR_SIGNATURE_INVALID");
    expect(rej?.findings.map((f) => f.id)).toContain("signature.unbound");
    const otherRoot = (await signBundle(b, src, "github:someone/else")).bundle;
    expect((await verifyBundleAgainstRoot(repo.root, otherRoot))?.ok).toBe(false);
    // invalid ids are refused, clear removes the binding
    await expect(signBundle(b, src, "bad id with spaces")).rejects.toMatchObject({
      code: "ERR_INVALID_PROFILE",
    });
    await expect(trustSetRootId(repo.root, "")).rejects.toMatchObject({
      code: "ERR_INVALID_PROFILE",
    });
    expect((await trustSetRootId(repo.root, undefined)).rootId).toBeUndefined();
    expect((await verifyBundleAgainstRoot(repo.root, unbound))?.ok).toBe(true);
  });

  it("profileWantsAntiRollback reads the predicate params", () => {
    expect(profileWantsAntiRollback([])).toBe(false);
    expect(profileWantsAntiRollback([{ predicate: "manifest.requireSigned", params: {} }])).toBe(
      false,
    );
    expect(
      profileWantsAntiRollback([
        { predicate: "path.deny", params: {} },
        { predicate: "manifest.requireSigned", params: { antiRollback: true } },
      ]),
    ).toBe(true);
  });
});

describe("MCP tools (signatures)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness([repo.root]);
  });
  afterEach(async () => {
    await h.close();
  });

  async function writeProfile(antiRollback: boolean) {
    await mkdir(join(repo.root, ".axiom", "profiles"), { recursive: true });
    await writeFile(
      join(repo.root, ".axiom", "profiles", "signed.json"),
      JSON.stringify({
        apiVersion: "axiom.dev/v2",
        kind: "Profile",
        name: "signed",
        checks: [
          {
            id: "manifest.requireSigned",
            predicate: "manifest.requireSigned",
            params: { antiRollback },
            severity: "error",
          },
        ],
      }),
    );
  }

  it("axiom_manifest_verify reports trusted keyids under `signatures` when a root has a trust store", async () => {
    const kp = generateKeyPair();
    const b = await compiled();
    const signed = { ...b, signatures: [signEnvelope(b.manifest, kp.privateKey)] };
    const none = await h.call("axiom_manifest_verify", { bundle: signed, root: repo.root });
    expect(structured<{ ok: boolean; signatures?: unknown }>(none)).toMatchObject({ ok: true });
    expect(structured<{ signatures?: unknown }>(none).signatures).toBeUndefined();

    await trustAdd(repo.root, { keyid: kp.keyid, alg: "ed25519", publicKey: kp.publicKeyBase64 });
    const ok = await h.call("axiom_manifest_verify", { bundle: signed, root: repo.root });
    expect(
      structured<{ ok: boolean; signed: boolean; signatures: { keyids: string[] } }>(ok),
    ).toMatchObject({
      ok: true,
      signed: true,
      signatures: { ok: true, keyids: [kp.keyid] },
    });

    const bad = await h.call("axiom_manifest_verify", { bundle: b, root: repo.root });
    const out = structured<{
      ok: boolean;
      signatures: { ok: boolean; findings: { id: string }[] };
    }>(bad);
    expect(out.ok).toBe(false);
    expect(out.signatures.findings.map((f) => f.id)).toEqual(["signature.missing"]);
  });

  it("axiom_apply with requireSigned+antiRollback advances lastCounter; a replay of a lower counter is rejected", async () => {
    const kp = generateKeyPair();
    await trustAdd(repo.root, { keyid: kp.keyid, alg: "ed25519", publicKey: kp.publicKeyBase64 });
    await writeProfile(true);
    const b7 = await compiled(7);
    const signed7 = { ...b7, signatures: [signEnvelope(b7.manifest, kp.privateKey)] };
    const chk = await h.call("axiom_check", {
      bundle: signed7,
      root: repo.root,
      profile: "signed",
    });
    expect(structured<{ verdict: string }>(chk).verdict).toBe("pass");
    const ap = await h.call("axiom_apply", {
      bundle: signed7,
      root: repo.root,
      profile: "signed",
      confirmDigest: signed7.manifestDigest,
    });
    expect(ap.isError, JSON.stringify(ap.content)).toBeUndefined();
    expect(structured<ApplyResult>(ap).status).toBe("applied");
    expect((await loadTrustState(repo.root))?.lastCounter).toBe(7);

    // replay: a genuinely signed bundle with counter 6 must now fail with signature.rollback
    const b6 = await compiled(6, "src/b.ts");
    const signed6 = { ...b6, signatures: [signEnvelope(b6.manifest, kp.privateKey)] };
    const chk6 = await h.call("axiom_check", {
      bundle: signed6,
      root: repo.root,
      profile: "signed",
    });
    const rep = structured<{ verdict: string; findings: { id: string }[] }>(chk6);
    expect(rep.verdict).toBe("fail");
    expect(rep.findings.map((f) => f.id)).toEqual(["signature.rollback"]);
    const ap6 = await h.call("axiom_apply", {
      bundle: signed6,
      root: repo.root,
      profile: "signed",
      confirmDigest: signed6.manifestDigest,
    });
    const r6 = structured<ApplyResult>(ap6);
    expect(r6.status).toBe("failed");
    expect(r6.error?.code).toBe("ERR_CHECKS_FAILED");
    expect((await loadTrustState(repo.root))?.lastCounter).toBe(7);
  });

  it("apply without antiRollback in the profile never writes trust state", async () => {
    const kp = generateKeyPair();
    await trustAdd(repo.root, { keyid: kp.keyid, alg: "ed25519", publicKey: kp.publicKeyBase64 });
    await writeProfile(false);
    const b = await compiled(2);
    const signed = { ...b, signatures: [signEnvelope(b.manifest, kp.privateKey)] };
    const ap = await h.call("axiom_apply", {
      bundle: signed,
      root: repo.root,
      profile: "signed",
      confirmDigest: signed.manifestDigest,
    });
    expect(structured<ApplyResult>(ap).status).toBe("applied");
    expect(await loadTrustState(repo.root)).toBeUndefined();
  });
});

describe.skipIf(!hasDist)("cli: keygen → sign → trust add → verify --root", () => {
  async function run(args: string[], env: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
        env: { ...process.env, ...env },
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("walkthrough; the private key never appears on stdout", async () => {
    const kg = await run(["keygen", "--out", join(repo.root, "keys"), "--name", "ci"]);
    expect(kg.code, kg.stderr).toBe(0);
    const kgOut = JSON.parse(kg.stdout) as {
      publicEntry: { keyid: string; publicKey: string };
      privateKeyFile: string;
    };
    const priv = (await readFile(kgOut.privateKeyFile, "utf8")).trim();
    expect(kg.stdout).not.toContain(priv);
    expect(kg.stdout).not.toContain(priv.slice(0, 24));
    const pubFile = join(repo.root, "pub.json");
    await writeFile(pubFile, kg.stdout);

    const planFile = join(repo.root, "plan.json");
    const bundleFile = join(repo.root, "bundle.json");
    await writeFile(
      planFile,
      JSON.stringify({ ...makePlan({ "src/x.ts": "export {};\n" }, { name: "cli" }), counter: 1 }),
    );
    expect((await run(["compile", planFile, "-o", bundleFile])).code).toBe(0);

    // no key → exit 2 with ERR_NOT_FOUND
    const noKey = await run(["sign", bundleFile], { [SIGNING_KEY_ENV]: "" });
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toContain("ERR_NOT_FOUND");

    const sg = await run(["sign", bundleFile, "--key-file", kgOut.privateKeyFile]);
    expect(sg.code, sg.stderr).toBe(0);
    expect(JSON.parse(sg.stdout)).toMatchObject({ keyid: kgOut.publicEntry.keyid, signatures: 1 });
    expect(sg.stdout).not.toContain(priv.slice(0, 24));

    // env-based signing works too and replaces the same key's envelope
    const sgEnv = await run(["sign", bundleFile], { [SIGNING_KEY_ENV]: priv });
    expect(sgEnv.code, sgEnv.stderr).toBe(0);
    expect(JSON.parse(sgEnv.stdout).signatures).toBe(1);

    // not yet trusted → verify --root notes no store; plain verify is structural only
    const v0 = await run(["verify", bundleFile, "--root", repo.root]);
    expect(v0.code).toBe(0);
    expect(JSON.parse(v0.stdout).signatures).toBeNull();

    const ta = await run(["trust", "add", pubFile, "--root", repo.root]);
    expect(ta.code, ta.stderr).toBe(0);
    const tl = await run(["trust", "list", "--root", repo.root]);
    expect(JSON.parse(tl.stdout).keys.map((k: { keyid: string }) => k.keyid)).toEqual([
      kgOut.publicEntry.keyid,
    ]);

    const v1 = await run(["verify", bundleFile, "--root", repo.root]);
    expect(v1.code, v1.stderr).toBe(0);
    expect(JSON.parse(v1.stdout)).toMatchObject({
      ok: true,
      signed: true,
      signatures: { ok: true, keyids: [kgOut.publicEntry.keyid] },
    });

    // tamper the manifest body (digest + attestation no longer agree) → structural verify fails, exit 1
    const bundle = JSON.parse(await readFile(bundleFile, "utf8")) as ManifestBundle;
    const tampered = structuredClone(bundle);
    tampered.manifest.counter = 2;
    await writeFile(bundleFile, JSON.stringify(tampered));
    const v2 = await run(["verify", bundleFile, "--root", repo.root]);
    expect(v2.code, v2.stdout + v2.stderr).toBe(1);
    expect(JSON.parse(v2.stdout).ok).toBe(false);

    // structurally valid but signed by a stranger → exit 1 with signature.unknownKey
    const stranger = generateKeyPair();
    const foreign = { ...bundle, signatures: [signEnvelope(bundle.manifest, stranger.privateKey)] };
    await writeFile(bundleFile, JSON.stringify(foreign));
    const v3 = await run(["verify", bundleFile, "--root", repo.root]);
    expect(v3.code, v3.stdout + v3.stderr).toBe(1);
    expect(JSON.parse(v3.stdout).signatures.findings.map((f: { id: string }) => f.id)).toEqual([
      "signature.unknownKey",
    ]);

    // S-409: bind the store to a rootId; the unbound envelope is now refused, a --root-id one passes
    await writeFile(bundleFile, JSON.stringify(bundle));
    const rid = await run(["trust", "root-id", "github:dragoscv/axiom", "--root", repo.root]);
    expect(rid.code, rid.stderr).toBe(0);
    expect(JSON.parse(rid.stdout).rootId).toBe("github:dragoscv/axiom");
    expect(JSON.parse((await run(["trust", "root-id", "--root", repo.root])).stdout).rootId).toBe(
      "github:dragoscv/axiom",
    );
    const vUnbound = await run(["verify", bundleFile, "--root", repo.root]);
    expect(vUnbound.code).toBe(1);
    expect(
      JSON.parse(vUnbound.stdout).signatures.findings.map((f: { id: string }) => f.id),
    ).toEqual(["signature.unbound"]);
    const sgBound = await run([
      "sign",
      bundleFile,
      "--key-file",
      kgOut.privateKeyFile,
      "--root-id",
      "github:dragoscv/axiom",
    ]);
    expect(sgBound.code, sgBound.stderr).toBe(0);
    expect(JSON.parse(sgBound.stdout)).toMatchObject({
      bound: true,
      rootId: "github:dragoscv/axiom",
    });
    const vBound = await run(["verify", bundleFile, "--root", repo.root]);
    expect(vBound.code, vBound.stdout).toBe(0);
    expect(JSON.parse(vBound.stdout).signatures.keyids).toEqual([kgOut.publicEntry.keyid]);
    const cleared = await run(["trust", "root-id", "--clear", "--root", repo.root]);
    expect(JSON.parse(cleared.stdout).rootId).toBeNull();

    const tr = await run(["trust", "remove", kgOut.publicEntry.keyid, "--root", repo.root]);
    expect(tr.code).toBe(0);
    expect(JSON.parse((await run(["trust", "list", "--root", repo.root])).stdout).keys).toEqual([]);
  });
});
