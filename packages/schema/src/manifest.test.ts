import { describe, expect, it } from "vitest";
import { HEX_A, HEX_B, REF_A, REF_B, validBundle, validManifest } from "./fixtures.test-helpers.js";
import {
  BUNDLE_BLOB_BYTES_MAX,
  blobByteLength,
  compareUtf8,
  ManifestArtifactSchema,
  ManifestBodySchema,
  ManifestBundleSchema,
  TrustStateSchema,
  TrustStoreSchema,
} from "./manifest.js";

describe("compareUtf8", () => {
  it("orders by code point (UTF-8 byte order), not UTF-16 units", () => {
    expect(compareUtf8("a", "b")).toBe(-1);
    expect(compareUtf8("b", "a")).toBe(1);
    expect(compareUtf8("a", "a")).toBe(0);
    expect(compareUtf8("a", "ab")).toBe(-1);
    // U+FF5E (BMP, UTF-16 0xFF5E) must sort BEFORE U+1F600 (surrogate pair 0xD83D…)
    expect(compareUtf8("\uff5e", "\u{1f600}")).toBe(-1);
    expect("\uff5e" < "\u{1f600}").toBe(false); // the naive comparison is wrong
  });
});

describe("ManifestArtifactSchema", () => {
  it("requires digest unless delete", () => {
    expect(
      ManifestArtifactSchema.safeParse({ path: "a", op: "create", mode: "0644" }).success,
    ).toBe(false);
    expect(
      ManifestArtifactSchema.safeParse({ path: "a", op: "delete", mode: "0644" }).success,
    ).toBe(true);
  });

  it("is strict and validates origin", () => {
    const base = { path: "a", op: "create", mode: "0644", digest: { sha256: HEX_A } };
    expect(ManifestArtifactSchema.safeParse({ ...base, origin: "cas" }).success).toBe(true);
    expect(ManifestArtifactSchema.safeParse({ ...base, origin: "ftp" }).success).toBe(false);
    expect(ManifestArtifactSchema.safeParse({ ...base, content: "x" }).success).toBe(false);
    expect(ManifestArtifactSchema.safeParse({ ...base, bytes: -1 }).success).toBe(false);
    expect(ManifestArtifactSchema.safeParse({ ...base, bytes: 1.5 }).success).toBe(false);
  });
});

describe("ManifestBodySchema", () => {
  it("accepts a valid manifest", () => {
    expect(ManifestBodySchema.safeParse(validManifest()).success).toBe(true);
  });

  it("rejects artifacts out of byte order", () => {
    const m = validManifest();
    m.artifacts = [...m.artifacts].reverse();
    const r = ManifestBodySchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["artifacts"]);
  });

  it("rejects duplicate paths", () => {
    const m = validManifest();
    const first = m.artifacts[0];
    if (!first) throw new Error("fixture");
    m.artifacts = [first, { ...first }];
    expect(ManifestBodySchema.safeParse(m).success).toBe(false);
  });

  it("uses byte order, not locale order (uppercase before lowercase)", () => {
    const m = validManifest();
    const a = { op: "create" as const, mode: "0644" as const, digest: { sha256: HEX_A } };
    m.artifacts = [
      { ...a, path: "B.ts" },
      { ...a, path: "a.ts" },
    ];
    expect(ManifestBodySchema.safeParse(m).success).toBe(true);
    m.artifacts = [
      { ...a, path: "a.ts" },
      { ...a, path: "B.ts" },
    ];
    expect(ManifestBodySchema.safeParse(m).success).toBe(false);
  });

  it("requires checks sorted unique by id", () => {
    const m = validManifest();
    m.checks = [
      { id: "b", predicate: "path.deny", params: {} },
      { id: "a", predicate: "path.deny", params: {} },
    ];
    expect(ManifestBodySchema.safeParse(m).success).toBe(false);
    m.checks = m.checks.reverse();
    expect(ManifestBodySchema.safeParse(m).success).toBe(true);
    m.checks = [m.checks[0]!, { ...m.checks[0]! }];
    expect(ManifestBodySchema.safeParse(m).success).toBe(false);
  });

  it("rejects timestamps or other extra keys (determinism)", () => {
    expect(
      ManifestBodySchema.safeParse({ ...validManifest(), createdAt: "2026-01-01T00:00:00Z" })
        .success,
    ).toBe(false);
  });

  it("requires ≥1 artifact and valid planDigest", () => {
    expect(ManifestBodySchema.safeParse({ ...validManifest(), artifacts: [] }).success).toBe(false);
    expect(ManifestBodySchema.safeParse({ ...validManifest(), planDigest: HEX_A }).success).toBe(
      false,
    );
  });
});

describe("blobByteLength", () => {
  it("counts utf8 bytes", () => {
    expect(blobByteLength({ encoding: "utf8", data: "abc" })).toBe(3);
    expect(blobByteLength({ encoding: "utf8", data: "é" })).toBe(2);
    expect(blobByteLength({ encoding: "utf8", data: "\u{1f600}" })).toBe(4);
  });

  it("counts decoded base64 bytes", () => {
    expect(blobByteLength({ encoding: "base64", data: "" })).toBe(0);
    expect(blobByteLength({ encoding: "base64", data: "YQ==" })).toBe(1);
    expect(blobByteLength({ encoding: "base64", data: "YWI=" })).toBe(2);
    expect(blobByteLength({ encoding: "base64", data: "YWJj" })).toBe(3);
    expect(blobByteLength({ encoding: "base64", data: "YWJj\nZA==" })).toBe(4);
  });
});

describe("ManifestBundleSchema", () => {
  it("accepts a valid bundle, blobs default to {}", () => {
    expect(ManifestBundleSchema.safeParse(validBundle()).success).toBe(true);
    const b = validBundle();
    delete b.blobs;
    const r = ManifestBundleSchema.parse(b);
    expect(r.blobs).toEqual({});
  });

  it("blob keys must be DigestRefs", () => {
    const b = validBundle();
    b.blobs = { [HEX_A]: { encoding: "utf8", data: "x" } } as never;
    expect(ManifestBundleSchema.safeParse(b).success).toBe(false);
  });

  it("enforces the 4 MiB total blob budget (utf8 + base64 combined)", () => {
    const b = validBundle();
    const half = BUNDLE_BLOB_BYTES_MAX / 2;
    b.blobs = {
      [REF_A]: { encoding: "utf8", data: "a".repeat(half) },
      [REF_B]: { encoding: "base64", data: "A".repeat((half / 3) * 4) }, // decodes to exactly half
    };
    expect(ManifestBundleSchema.safeParse(b).success).toBe(true);
    b.blobs[REF_B] = { encoding: "base64", data: `${"A".repeat((half / 3) * 4)}YQ==` };
    const r = ManifestBundleSchema.safeParse(b);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes("exceeds"))).toBe(true);
    }
  });

  it("accepts optional loose attestation and DSSE envelope", () => {
    const b = validBundle();
    b.attestation = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "hello-world", digest: { sha256: HEX_B } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: { anything: { goes: true } },
    };
    b.envelope = {
      payloadType: "application/vnd.in-toto+json",
      payload: "eyJhIjoxfQ==",
      signatures: [{ keyid: "k1", sig: "c2ln" }],
    };
    expect(ManifestBundleSchema.safeParse(b).success).toBe(true);
    b.envelope.payload = "not base64!";
    expect(ManifestBundleSchema.safeParse(b).success).toBe(false);
  });

  it("manifestDigest must be a DigestRef", () => {
    expect(
      ManifestBundleSchema.safeParse({ ...validBundle(), manifestDigest: HEX_B }).success,
    ).toBe(false);
  });

  it("accepts detached manifest signatures (D-16) and rejects wrong payloadType / empty signatures", () => {
    const b = validBundle();
    b.signatures = [
      {
        payloadType: "application/vnd.axiom.manifest+json",
        payload: "eyJhIjoxfQ==",
        signatures: [{ keyid: "a".repeat(64), sig: "c2ln" }],
      },
    ];
    expect(ManifestBundleSchema.safeParse(b).success).toBe(true);
    b.signatures[0]!.signatures = [];
    expect(ManifestBundleSchema.safeParse(b).success).toBe(false);
    b.signatures = [
      {
        payloadType: "application/vnd.in-toto+json" as never,
        payload: "e30=",
        signatures: [{ sig: "c2ln" }],
      },
    ];
    expect(ManifestBundleSchema.safeParse(b).success).toBe(false);
  });

  it("manifest.counter is an optional non-negative int inside the canonical body", () => {
    const b = validBundle();
    b.manifest.counter = 7;
    expect(ManifestBundleSchema.safeParse(b).success).toBe(true);
    b.manifest.counter = -1;
    expect(ManifestBundleSchema.safeParse(b).success).toBe(false);
    b.manifest.counter = 1.5;
    expect(ManifestBundleSchema.safeParse(b).success).toBe(false);
  });
});

describe("trust store schemas (D-16)", () => {
  const key = { keyid: "0".repeat(64), alg: "ed25519" as const, publicKey: "QUJD" };
  it("TrustStoreSchema accepts keys with optional name/notBefore/minCounter", () => {
    expect(TrustStoreSchema.safeParse({ version: 1, keys: [key] }).success).toBe(true);
    expect(
      TrustStoreSchema.safeParse({
        version: 1,
        keys: [{ ...key, name: "ci", notBefore: 3 }],
        minCounter: 2,
      }).success,
    ).toBe(true);
    expect(TrustStoreSchema.safeParse({ version: 2, keys: [] }).success).toBe(false);
    expect(
      TrustStoreSchema.safeParse({ version: 1, keys: [{ ...key, keyid: "short" }] }).success,
    ).toBe(false);
    expect(TrustStoreSchema.safeParse({ version: 1, keys: [{ ...key, alg: "rsa" }] }).success).toBe(
      false,
    );
  });
  it("TrustStateSchema", () => {
    expect(TrustStateSchema.safeParse({ version: 1, lastCounter: 0 }).success).toBe(true);
    expect(TrustStateSchema.safeParse({ version: 1, lastCounter: -1 }).success).toBe(false);
    expect(TrustStateSchema.safeParse({ version: 1, lastCounter: 1, extra: 1 }).success).toBe(
      false,
    );
  });
});
