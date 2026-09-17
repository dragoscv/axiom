import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "@codai/axiom-engine";
import type { Manifest, Artifact } from "@codai/axiom-engine/dist/manifest.js";
import { createHash } from "node:crypto";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("apply() with inline content", () => {
  let tmpRepoAbs: string;

  beforeEach(async () => {
    tmpRepoAbs = await mkdtemp(join(tmpdir(), "axiom-test-inline-"));
  });

  afterEach(async () => {
    await rm(tmpRepoAbs, { recursive: true, force: true });
  });

  it("should write artifacts from contentUtf8 (text file)", async () => {
    const textContent = "AXIOM_SMOKE_OK\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    const artifact: Artifact = {
      path: "out/smoke/README.md",
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "inline-utf8-test",
      irHash: "test-ir-hash",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    // Assert success
    expect(result.success).toBe(true);

    // Assert filesWritten contains correct POSIX path
    expect(result.filesWritten).toHaveLength(1);
    expect(result.filesWritten[0]).toBe("out/smoke/README.md");

    // Assert physical file exists
    const fullPath = join(tmpRepoAbs, "out", "smoke", "README.md");
    const fileContent = await readFile(fullPath, "utf-8");
    expect(fileContent).toBe(textContent);

    // Assert SHA256 matches
    const writtenBuffer = await readFile(fullPath);
    const writtenSha256 = sha256(writtenBuffer);
    expect(writtenSha256).toBe(textSha256);

    // Assert file size matches
    const fileStat = await stat(fullPath);
    expect(fileStat.size).toBe(textBuffer.byteLength);
  });

  it("should write artifacts from contentBase64 (binary file)", async () => {
    // Arbitrary 11 bytes binary content
    const binaryBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb, 0xcc
    ]);
    const binarySha256 = sha256(binaryBuffer);
    const binaryBase64 = binaryBuffer.toString("base64");

    const artifact: Artifact = {
      path: "out/smoke/logo.bin",
      kind: "file",
      sha256: binarySha256,
      bytes: binaryBuffer.byteLength,
      contentBase64: binaryBase64
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "inline-base64-test",
      irHash: "test-ir-hash",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    // Assert success
    expect(result.success).toBe(true);

    // Assert filesWritten contains correct POSIX path
    expect(result.filesWritten).toHaveLength(1);
    expect(result.filesWritten[0]).toBe("out/smoke/logo.bin");

    // Assert physical file exists
    const fullPath = join(tmpRepoAbs, "out", "smoke", "logo.bin");
    const writtenBuffer = await readFile(fullPath);

    // Assert content matches
    expect(Buffer.compare(writtenBuffer, binaryBuffer)).toBe(0);

    // Assert SHA256 matches
    const writtenSha256 = sha256(writtenBuffer);
    expect(writtenSha256).toBe(binarySha256);

    // Assert file size matches
    const fileStat = await stat(fullPath);
    expect(fileStat.size).toBe(binaryBuffer.byteLength);
  });

  it("should write multiple artifacts with mixed inline content", async () => {
    const text1 = "# Documentation\n\nThis is a README.\n";
    const text1Buffer = Buffer.from(text1, "utf-8");
    const text1Sha256 = sha256(text1Buffer);

    const binary1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
    const binary1Sha256 = sha256(binary1);

    const artifacts: Artifact[] = [
      {
        path: "out/docs/README.md",
        kind: "file",
        sha256: text1Sha256,
        bytes: text1Buffer.byteLength,
        contentUtf8: text1
      },
      {
        path: "out/assets/image.jpg",
        kind: "file",
        sha256: binary1Sha256,
        bytes: binary1.byteLength,
        contentBase64: binary1.toString("base64")
      }
    ];

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "inline-mixed-test",
      irHash: "test-ir-hash",
      createdAt: new Date().toISOString(),
      artifacts,
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    // Assert success
    expect(result.success).toBe(true);

    // Assert filesWritten contains correct POSIX paths
    expect(result.filesWritten).toHaveLength(2);
    expect(result.filesWritten).toContain("out/docs/README.md");
    expect(result.filesWritten).toContain("out/assets/image.jpg");

    // Verify README.md
    const readmePath = join(tmpRepoAbs, "out", "docs", "README.md");
    const readmeContent = await readFile(readmePath, "utf-8");
    expect(readmeContent).toBe(text1);

    // Verify image.jpg
    const imagePath = join(tmpRepoAbs, "out", "assets", "image.jpg");
    const imageBuffer = await readFile(imagePath);
    expect(Buffer.compare(imageBuffer, binary1)).toBe(0);
  });
});
