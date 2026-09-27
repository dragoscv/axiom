import { AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE, AXIOM_MANIFEST_PAYLOAD_TYPE } from "@codai/axiom-canon";
import { AxiomError } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSigstoreForTests,
  compileSubjectRegex,
  GITHUB_ACTIONS_ISSUER,
  hasAmbientOidc,
  KEYLESS_BUNDLE_FIELD,
  keylessPayload,
  keylessSignaturesOf,
  type SigstoreBundleJson,
  signManifestKeyless,
  verifyManifestKeyless,
} from "./keyless.js";

const SUBJECT = "https://github.com/dragoscv/axiom/.github/workflows/release.yml@refs/heads/main";
const POLICY = {
  issuer: GITHUB_ACTIONS_ISSUER,
  subjectRegex:
    "https://github\\.com/dragoscv/axiom/\\.github/workflows/release\\.yml@refs/heads/main",
};

const mock = vi.hoisted(() => ({
  attest: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("sigstore", () => ({ attest: mock.attest, verify: mock.verify }));

function named(name: string): Error {
  const e = new Error("x");
  e.name = name;
  return e;
}

function fakeBundle(
  payload: Uint8Array,
  payloadType = AXIOM_MANIFEST_PAYLOAD_TYPE,
): SigstoreBundleJson {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {},
    dsseEnvelope: {
      payload: Buffer.from(payload).toString("base64"),
      payloadType,
      signatures: [{ sig: "c2ln" }],
    },
  };
}

const manifest = { apiVersion: "axiom.dev/v2", kind: "Manifest", name: "t" };
const payload = keylessPayload(manifest);

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof AxiomError ? e.code : "NOT_AXIOM_ERROR";
  }
}

async function reasonOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof AxiomError ? e.details?.reason : "NOT_AXIOM_ERROR";
  }
}

beforeEach(() => {
  __resetSigstoreForTests();
  mock.attest.mockReset();
  mock.verify.mockReset();
  mock.verify.mockResolvedValue({
    identity: { subjectAlternativeName: SUBJECT, extensions: { issuer: GITHUB_ACTIONS_ISSUER } },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("keylessPayload", () => {
  it("is the JCS bytes of the manifest (same preimage as manifestDigest)", () => {
    expect(new TextDecoder().decode(keylessPayload({ b: 1, a: [2] }))).toBe('{"a":[2],"b":1}');
  });
});

describe("compileSubjectRegex", () => {
  it("anchors the pattern to the whole subject", () => {
    const re = compileSubjectRegex("a|b");
    expect(re.test("a")).toBe(true);
    expect(re.test("xa")).toBe(false);
    expect(re.test("bx")).toBe(false);
  });
  it("throws on an invalid pattern", () => {
    expect(() => compileSubjectRegex("(")).toThrow(SyntaxError);
  });
});

describe("hasAmbientOidc", () => {
  it("needs both GitHub Actions variables, or SIGSTORE_ID_TOKEN", () => {
    expect(hasAmbientOidc({})).toBe(false);
    expect(hasAmbientOidc({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://x" })).toBe(false);
    expect(
      hasAmbientOidc({
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      }),
    ).toBe(true);
    expect(hasAmbientOidc({ SIGSTORE_ID_TOKEN: "t" })).toBe(true);
  });
});

describe("signManifestKeyless", () => {
  it("without any OIDC source → ERR_KEYLESS_UNAVAILABLE (NO_OIDC), sigstore never called", async () => {
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "");
    vi.stubEnv("SIGSTORE_ID_TOKEN", "");
    expect(await codeOf(signManifestKeyless(payload))).toBe("ERR_KEYLESS_UNAVAILABLE");
    expect(await reasonOf(signManifestKeyless(payload))).toBe("NO_OIDC");
    expect(mock.attest).not.toHaveBeenCalled();
  });

  it("with an identityToken → DSSE attest over the exact payload bytes and AXIOM payloadType", async () => {
    mock.attest.mockResolvedValue(fakeBundle(payload));
    const b = await signManifestKeyless(payload, { identityToken: "tok" });
    expect(b.dsseEnvelope?.payloadType).toBe(AXIOM_MANIFEST_PAYLOAD_TYPE);
    const [bytes, type, opts] = mock.attest.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(payload))).toBe(true);
    expect(type).toBe(AXIOM_MANIFEST_PAYLOAD_TYPE);
    expect(opts).toEqual({ identityToken: "tok" });
  });

  it("passes a bound payloadType through", async () => {
    mock.attest.mockResolvedValue(fakeBundle(payload, AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE));
    await signManifestKeyless(payload, {
      identityToken: "tok",
      payloadType: AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE,
    });
    expect(mock.attest.mock.calls[0]?.[1]).toBe(AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE);
  });

  it("network / Fulcio failure → ERR_KEYLESS_UNAVAILABLE (SIGN_FAILED)", async () => {
    mock.attest.mockRejectedValue(named("InternalError"));
    const p = signManifestKeyless(payload, { identityToken: "tok" });
    expect(await reasonOf(p)).toBe("SIGN_FAILED");
    mock.attest.mockRejectedValue(named("InternalError"));
    expect(await codeOf(signManifestKeyless(payload, { identityToken: "tok" }))).toBe(
      "ERR_KEYLESS_UNAVAILABLE",
    );
  });
});

describe("verifyManifestKeyless — policy", () => {
  it("good bundle + matching issuer/subject → ok with identity", async () => {
    const v = await verifyManifestKeyless(fakeBundle(payload), payload, POLICY);
    expect(v).toEqual({ ok: true, issuer: GITHUB_ACTIONS_ISSUER, subject: SUBJECT });
    expect(mock.verify.mock.calls[0]?.[1]).toEqual({ certificateIssuer: GITHUB_ACTIONS_ISSUER });
  });

  it("offline → sigstore tufForceCache + cache path, no other option", async () => {
    await verifyManifestKeyless(fakeBundle(payload), payload, POLICY, {
      offline: true,
      tufCachePath: "/c",
    });
    expect(mock.verify.mock.calls[0]?.[1]).toEqual({
      certificateIssuer: GITHUB_ACTIONS_ISSUER,
      tufForceCache: true,
      tufCachePath: "/c",
    });
  });

  it("subject that only partially matches → SUBJECT_MISMATCH (regex is anchored)", async () => {
    mock.verify.mockResolvedValue({
      identity: {
        subjectAlternativeName: `${SUBJECT}-evil`,
        extensions: { issuer: GITHUB_ACTIONS_ISSUER },
      },
    });
    const v = await verifyManifestKeyless(fakeBundle(payload), payload, POLICY);
    expect(v.ok).toBe(false);
    expect(v.failure).toBe("SUBJECT_MISMATCH");
  });

  it("library PolicyError → ISSUER_MISMATCH", async () => {
    mock.verify.mockRejectedValue(named("PolicyError"));
    expect((await verifyManifestKeyless(fakeBundle(payload), payload, POLICY)).failure).toBe(
      "ISSUER_MISMATCH",
    );
  });

  it("issuer re-checked even if the library returns another one", async () => {
    mock.verify.mockResolvedValue({
      identity: { subjectAlternativeName: SUBJECT, extensions: { issuer: "https://evil.example" } },
    });
    const v = await verifyManifestKeyless(fakeBundle(payload), payload, POLICY);
    expect(v.failure).toBe("ISSUER_MISMATCH");
    expect(v.issuer).toBe("https://evil.example");
  });

  it("no SAN → NO_IDENTITY", async () => {
    mock.verify.mockResolvedValue({ identity: { extensions: { issuer: GITHUB_ACTIONS_ISSUER } } });
    expect((await verifyManifestKeyless(fakeBundle(payload), payload, POLICY)).failure).toBe(
      "NO_IDENTITY",
    );
  });

  it("VerificationError → BAD_SIGNATURE", async () => {
    mock.verify.mockRejectedValue(named("VerificationError"));
    expect((await verifyManifestKeyless(fakeBundle(payload), payload, POLICY)).failure).toBe(
      "BAD_SIGNATURE",
    );
  });

  it("different payload bytes / payloadType / no DSSE are rejected before sigstore runs", async () => {
    const other = keylessPayload({ other: true });
    expect((await verifyManifestKeyless(fakeBundle(other), payload, POLICY)).failure).toBe(
      "PAYLOAD_MISMATCH",
    );
    expect(
      (
        await verifyManifestKeyless(
          fakeBundle(payload, AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE),
          payload,
          POLICY,
        )
      ).failure,
    ).toBe("PAYLOAD_TYPE");
    const { dsseEnvelope: _d, ...noDsse } = fakeBundle(payload);
    expect((await verifyManifestKeyless(noDsse, payload, POLICY)).failure).toBe("NOT_DSSE");
    expect(mock.verify).not.toHaveBeenCalled();
  });

  it("trusted root unavailable (TUFError) → throws ERR_KEYLESS_UNAVAILABLE (TRUSTED_ROOT)", async () => {
    mock.verify.mockRejectedValue(named("TUFError"));
    const p = verifyManifestKeyless(fakeBundle(payload), payload, POLICY, { offline: true });
    expect(await reasonOf(p)).toBe("TRUSTED_ROOT");
  });
});

describe("keylessSignaturesOf", () => {
  it("reads the side field structurally and rejects malformed shapes", () => {
    expect(keylessSignaturesOf({})).toEqual([]);
    const b = fakeBundle(payload);
    expect(keylessSignaturesOf({ [KEYLESS_BUNDLE_FIELD]: [b] })).toEqual([b]);
    expect(keylessSignaturesOf({ [KEYLESS_BUNDLE_FIELD]: {} })).toEqual({ invalid: true });
    expect(keylessSignaturesOf({ [KEYLESS_BUNDLE_FIELD]: [{ nope: 1 }] })).toEqual({
      invalid: true,
    });
  });
});

describe("sigstore module missing", () => {
  it("verify and sign fail closed with ERR_KEYLESS_UNAVAILABLE", async () => {
    vi.doMock("sigstore", () => {
      throw Object.assign(new Error("Cannot find package 'sigstore'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });
    __resetSigstoreForTests();
    try {
      expect(await codeOf(verifyManifestKeyless(fakeBundle(payload), payload, POLICY))).toBe(
        "ERR_KEYLESS_UNAVAILABLE",
      );
      __resetSigstoreForTests();
      expect(await codeOf(signManifestKeyless(payload, { identityToken: "t" }))).toBe(
        "ERR_KEYLESS_UNAVAILABLE",
      );
    } finally {
      vi.doUnmock("sigstore");
      __resetSigstoreForTests();
    }
  });
});
