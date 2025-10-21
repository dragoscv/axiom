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

/**
 * TEST CRITICAL: Stateless inline content apply
 * 
 * Verifică că apply() funcționează FĂRĂ artifact store folosind doar inline content.
 * Scenariul MCP: store-ul e pierdut între generate() și apply().
 * 
 * ACCEPTANCE:
 * - success: true doar dacă fișierele există pe disc
 * - filesWritten conține exact ["out/manifest/README.md"] (POSIX, fără backslash)
 * - Fișierul fizic există la repoPath/out/manifest/README.md
 * - Conținutul citit de pe disc match-uiește exact contentUtf8
 * - SHA256 citit de pe disc match-uiește artifact.sha256
 * - summary.totalFiles === 1, summary.totalBytes === content.length
 */
describe("apply() stateless inline content", () => {
  let tmpRepoAbs: string;

  beforeEach(async () => {
    tmpRepoAbs = await mkdtemp(join(tmpdir(), "axiom-stateless-"));
  });

  afterEach(async () => {
    await rm(tmpRepoAbs, { recursive: true, force: true });
  });

  it("should write file from contentUtf8 without artifact store", async () => {
    // Conținut determinist
    const textContent = "# AXIOM Stateless Test\n\nThis file is embedded in manifest.\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    // Artifact cu inline content
    const artifact: Artifact = {
      path: "manifest/README.md",
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    // Manifest fake dar valid
    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "stateless-test-123",
      irHash: "fake-ir-hash-abc",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    // Apply WITHOUT artifact store (stateless scenario)
    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    // ACCEPTANCE 1: success === true
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // ACCEPTANCE 2: filesWritten exact match (POSIX)
    expect(result.filesWritten).toHaveLength(1);
    expect(result.filesWritten[0]).toBe("out/manifest/README.md");
    
    // Verify no backslashes in reported paths
    expect(result.filesWritten[0]).not.toContain("\\");

    // ACCEPTANCE 3: File exists physically on disk
    const fullPath = join(tmpRepoAbs, "out", "manifest", "README.md");
    const fileContent = await readFile(fullPath, "utf-8");
    
    // ACCEPTANCE 4: Content matches exactly
    expect(fileContent).toBe(textContent);

    // ACCEPTANCE 5: SHA256 verification
    const diskBuffer = await readFile(fullPath);
    const diskSha256 = sha256(diskBuffer);
    expect(diskSha256).toBe(textSha256);

    // ACCEPTANCE 6: Summary correct
    expect(result.summary).toBeDefined();
    expect(result.summary!.totalFiles).toBe(1);
    expect(result.summary!.totalBytes).toBe(textBuffer.byteLength);

    // ACCEPTANCE 7: File size matches
    const fileStat = await stat(fullPath);
    expect(fileStat.size).toBe(textBuffer.byteLength);
  });

  it("should write file from contentBase64 without artifact store", async () => {
    // Binary content (PNG header + fake data)
    const binaryBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52  // IHDR chunk start
    ]);
    const binarySha256 = sha256(binaryBuffer);
    const binaryBase64 = binaryBuffer.toString("base64");

    const artifact: Artifact = {
      path: "assets/logo.png",
      kind: "file",
      sha256: binarySha256,
      bytes: binaryBuffer.byteLength,
      contentBase64: binaryBase64
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "stateless-binary-test",
      irHash: "fake-ir-hash-binary",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    expect(result.success).toBe(true);
    expect(result.filesWritten).toEqual(["out/assets/logo.png"]);

    // Verify binary content
    const fullPath = join(tmpRepoAbs, "out", "assets", "logo.png");
    const diskBuffer = await readFile(fullPath);
    
    expect(Buffer.compare(diskBuffer, binaryBuffer)).toBe(0);
    expect(sha256(diskBuffer)).toBe(binarySha256);
  });

  it("should handle multiple artifacts with mixed inline content", async () => {
    const text1 = "# README\n";
    const text1Buffer = Buffer.from(text1, "utf-8");
    
    const text2 = "export const VERSION = '1.0.0';\n";
    const text2Buffer = Buffer.from(text2, "utf-8");
    
    const binary1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header

    const artifacts: Artifact[] = [
      {
        path: "docs/README.md",
        kind: "file",
        sha256: sha256(text1Buffer),
        bytes: text1Buffer.byteLength,
        contentUtf8: text1
      },
      {
        path: "src/version.ts",
        kind: "file",
        sha256: sha256(text2Buffer),
        bytes: text2Buffer.byteLength,
        contentUtf8: text2
      },
      {
        path: "assets/image.jpg",
        kind: "file",
        sha256: sha256(binary1),
        bytes: binary1.byteLength,
        contentBase64: binary1.toString("base64")
      }
    ];

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "mixed-content-test",
      irHash: "fake-ir-hash-mixed",
      createdAt: new Date().toISOString(),
      artifacts,
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    expect(result.success).toBe(true);
    expect(result.filesWritten).toHaveLength(3);
    expect(result.filesWritten).toContain("out/docs/README.md");
    expect(result.filesWritten).toContain("out/src/version.ts");
    expect(result.filesWritten).toContain("out/assets/image.jpg");

    // Verify all files exist and match
    const readme = await readFile(join(tmpRepoAbs, "out", "docs", "README.md"), "utf-8");
    expect(readme).toBe(text1);

    const version = await readFile(join(tmpRepoAbs, "out", "src", "version.ts"), "utf-8");
    expect(version).toBe(text2);

    const image = await readFile(join(tmpRepoAbs, "out", "assets", "image.jpg"));
    expect(Buffer.compare(image, binary1)).toBe(0);

    // Verify summary
    expect(result.summary!.totalFiles).toBe(3);
    expect(result.summary!.totalBytes).toBe(
      text1Buffer.byteLength + text2Buffer.byteLength + binary1.byteLength
    );
  });

  it("should fail with ERR_ARTIFACT_CONTENT_MISSING when no content source", async () => {
    // Artifact WITHOUT inline content and no store
    const artifact: Artifact = {
      path: "data/missing.txt",
      kind: "file",
      sha256: "0".repeat(64), // Fake SHA256
      bytes: 100
      // NO contentUtf8, NO contentBase64
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "missing-content-test",
      irHash: "fake-ir-hash",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("ERR_ARTIFACT_CONTENT_MISSING");
    expect(result.error).toContain("data/missing.txt");
  });
});
