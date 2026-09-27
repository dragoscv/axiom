import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE,
  AXIOM_MANIFEST_PAYLOAD_TYPE,
  generateKeyPair,
  signEnvelope,
} from "@codai/axiom-canon";
import type { ManifestBundle } from "@codai/axiom-schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSigstoreForTests,
  GITHUB_ACTIONS_ISSUER,
  KEYLESS_BUNDLE_FIELD,
  keylessPayload,
  type SigstoreBundleJson,
  signManifestKeyless,
  verifyManifestKeyless,
} from "../keyless.js";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { RequireSignedParams } from "./signature.js";

const SUBJECT = "https://github.com/dragoscv/axiom/.github/workflows/release.yml@refs/heads/main";
const KEYLESS = {
  issuer: GITHUB_ACTIONS_ISSUER,
  subjectRegex: "https://github\\.com/dragoscv/axiom/\\.github/workflows/release\\.yml@refs/.+",
};

const mock = vi.hoisted(() => ({ attest: vi.fn(), verify: vi.fn() }));
vi.mock("sigstore", () => ({ attest: mock.attest, verify: mock.verify }));

function named(name: string): Error {
  const e = new Error("x");
  e.name = name;
  return e;
}

function identity(subject = SUBJECT, issuer = GITHUB_ACTIONS_ISSUER) {
  return { identity: { subjectAlternativeName: subject, extensions: { issuer } } };
}

function sigstoreBundle(payload: Uint8Array, payloadType: string = AXIOM_MANIFEST_PAYLOAD_TYPE) {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {},
    dsseEnvelope: {
      payload: Buffer.from(payload).toString("base64"),
      payloadType,
      signatures: [{ sig: "c2ln" }],
    },
  } satisfies SigstoreBundleJson;
}

/** A bundle carrying keyless material. `ManifestBundleSchema` has no slot yet, so it is attached structurally. */
function keylessBundle(extra: SigstoreBundleJson[] | "self" = "self"): ManifestBundle {
  const b = makeBundle([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  const list = extra === "self" ? [sigstoreBundle(keylessPayload(b.manifest))] : extra;
  return Object.assign(b, { [KEYLESS_BUNDLE_FIELD]: list });
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "axiom-keyless-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  __resetSigstoreForTests();
  mock.verify.mockReset();
  mock.attest.mockReset();
  mock.verify.mockResolvedValue(identity());
  await rm(join(root, ".axiom"), { recursive: true, force: true });
});

async function writeStore(s: unknown) {
  await mkdir(join(root, ".axiom", "trust"), { recursive: true });
  await writeFile(join(root, ".axiom", "trust", "keys.json"), JSON.stringify(s), "utf8");
}

async function run(bundle: ManifestBundle, params: unknown) {
  const profile = profileWith([
    {
      id: "manifest.requireSigned",
      predicate: "manifest.requireSigned",
      params: params as never,
      severity: "error",
    },
  ]);
  const r = await runChecks({ bundle, profile, root });
  return { verdict: r.verdict, ids: r.findings.map((f) => f.id), findings: r.findings };
}

describe("RequireSignedParams.keyless", () => {
  it("accepts a valid policy with offline defaulting to false", () => {
    expect(RequireSignedParams.parse({ keyless: KEYLESS }).keyless).toEqual({
      ...KEYLESS,
      offline: false,
    });
  });
  it("rejects a non-compiling regex, a non-https issuer and unknown keys", () => {
    expect(
      RequireSignedParams.safeParse({ keyless: { ...KEYLESS, subjectRegex: "(" } }).success,
    ).toBe(false);
    expect(
      RequireSignedParams.safeParse({ keyless: { ...KEYLESS, issuer: "http://token.example" } })
        .success,
    ).toBe(false);
    expect(RequireSignedParams.safeParse({ keyless: { ...KEYLESS, extra: 1 } }).success).toBe(
      false,
    );
  });
  it("invalid regex in a profile → error verdict with ERR_PREDICATE_PARAMS", async () => {
    const r = await run(keylessBundle(), { keyless: { ...KEYLESS, subjectRegex: "[" } });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
  });
});

describe("manifest.requireSigned — keyless", () => {
  it("good bundle + matching issuer/subject → pass, with no trust file needed", async () => {
    const r = await run(keylessBundle(), { keyless: KEYLESS });
    expect(r.verdict).toBe("pass");
    expect(mock.verify).toHaveBeenCalledTimes(1);
  });

  it("subject mismatch → fail with signature.keylessSubject + keylessMissing", async () => {
    mock.verify.mockResolvedValue(
      identity("https://github.com/attacker/fork/.github/workflows/x.yml@refs/heads/main"),
    );
    const r = await run(keylessBundle(), { keyless: KEYLESS });
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.keylessMissing", "signature.keylessSubject"].sort());
    const sub = r.findings.find((f) => f.id === "signature.keylessSubject");
    expect(sub?.facts.reason).toBe("SUBJECT_MISMATCH");
  });

  it("issuer mismatch → fail with signature.keylessIssuer", async () => {
    mock.verify.mockRejectedValue(named("PolicyError"));
    const r = await run(keylessBundle(), { keyless: KEYLESS });
    expect(r.verdict).toBe("fail");
    expect(r.ids).toContain("signature.keylessIssuer");
    expect(r.ids).toContain("signature.keylessMissing");
  });

  it("no keyless material at all → signature.keylessMissing", async () => {
    const r = await run(keylessBundle([]), { keyless: KEYLESS });
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.keylessMissing"]);
    expect(mock.verify).not.toHaveBeenCalled();
  });

  it("keyless bundle over another manifest → signature.keylessBad (PAYLOAD_MISMATCH)", async () => {
    const r = await run(keylessBundle([sigstoreBundle(keylessPayload({ other: 1 }))]), {
      keyless: KEYLESS,
    });
    expect(r.verdict).toBe("fail");
    const bad = r.findings.find((f) => f.id === "signature.keylessBad");
    expect(bad?.facts.reason).toBe("PAYLOAD_MISMATCH");
  });

  it("malformed keyless field → signature.keylessBad (MALFORMED)", async () => {
    const b = Object.assign(makeBundle([{ path: "a.txt", content: "a" }]), {
      [KEYLESS_BUNDLE_FIELD]: "nope",
    });
    const r = await run(b, { keyless: KEYLESS });
    expect(r.verdict).toBe("fail");
    expect(r.findings.find((f) => f.id === "signature.keylessBad")?.facts.reason).toBe("MALFORMED");
  });

  it("trusted root unavailable → verdict error ERR_KEYLESS_UNAVAILABLE, never pass", async () => {
    mock.verify.mockRejectedValue(named("TUFError"));
    const r = await run(keylessBundle(), { keyless: { ...KEYLESS, offline: true } });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_KEYLESS_UNAVAILABLE");
    expect(r.findings[0]?.facts.reason).toBe("TRUSTED_ROOT");
    expect(mock.verify.mock.calls[0]?.[1]).toMatchObject({ tufForceCache: true });
  });

  it("store with rootId → the keyless payload must be the root-bound one", async () => {
    await writeStore({ version: 1, keys: [], rootId: "github:dragoscv/axiom" });
    const unbound = await run(keylessBundle(), { keyless: KEYLESS });
    expect(unbound.verdict).toBe("fail");
    expect(unbound.findings.find((f) => f.id === "signature.keylessBad")?.facts.reason).toBe(
      "PAYLOAD_TYPE",
    );

    const b = makeBundle([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
    const bound = keylessPayload({ manifest: b.manifest, rootId: "github:dragoscv/axiom" });
    Object.assign(b, {
      [KEYLESS_BUNDLE_FIELD]: [sigstoreBundle(bound, AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE)],
    });
    expect((await run(b, { keyless: KEYLESS })).verdict).toBe("pass");
  });

  it("minSignatures 2 = one Ed25519 key + one keyless identity", async () => {
    const k = generateKeyPair();
    await writeStore({
      version: 1,
      keys: [{ keyid: k.keyid, alg: "ed25519", publicKey: k.publicKeyBase64 }],
    });
    const b = keylessBundle();
    b.signatures = [signEnvelope(b.manifest, k.privateKey)];
    expect((await run(b, { keyless: KEYLESS, minSignatures: 2 })).verdict).toBe("pass");
    const onlyKeyless = keylessBundle();
    const r = await run(onlyKeyless, { keyless: KEYLESS, minSignatures: 2 });
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["signature.missing"]);
  });

  it("without keyless params the Ed25519 path is unchanged (missing trust file → ERR_NOT_FOUND)", async () => {
    const r = await run(keylessBundle(), {});
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_NOT_FOUND");
    expect(mock.verify).not.toHaveBeenCalled();
  });

  it("sigstore module missing → verdict error (fail closed)", async () => {
    vi.doMock("sigstore", () => {
      throw Object.assign(new Error("Cannot find package 'sigstore'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });
    __resetSigstoreForTests();
    try {
      const r = await run(keylessBundle(), { keyless: KEYLESS });
      expect(r.verdict).toBe("error");
      expect(r.findings[0]?.facts.code).toBe("ERR_KEYLESS_UNAVAILABLE");
    } finally {
      vi.doUnmock("sigstore");
      __resetSigstoreForTests();
    }
  });
});

describe("keyless — live Sigstore (CI only)", () => {
  // Needs GitHub Actions OIDC (`id-token: write`), Fulcio, Rekor and the TUF mirror.
  it.skipIf(!process.env.ACTIONS_ID_TOKEN_REQUEST_URL)(
    "signs and verifies a manifest against the public-good instance",
    async () => {
      vi.doUnmock("sigstore");
      __resetSigstoreForTests();
      const b = makeBundle([{ path: "a.txt", content: "a" }]);
      const payload = keylessPayload(b.manifest);
      const sb = await signManifestKeyless(payload);
      const v = await verifyManifestKeyless(sb, payload, {
        issuer: GITHUB_ACTIONS_ISSUER,
        subjectRegex: "https://github\\.com/.+",
      });
      expect(v.ok).toBe(true);
    },
    60_000,
  );
});
