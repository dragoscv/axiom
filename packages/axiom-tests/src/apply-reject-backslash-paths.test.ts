import { describe, it, expect } from "vitest";
import { apply } from "@codai/axiom-engine";
import type { Manifest, Artifact } from "@codai/axiom-engine/dist/manifest.js";
import { createHash } from "node:crypto";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * TEST: Reject artifact paths containing backslashes
 * 
 * SPEC: Artifact paths TREBUIE să fie strict POSIX (doar forward slash)
 * Orice backslash în artifact.path → ERR_POSIX_ONLY
 * 
 * ACCEPTANCE:
 * - apply() returnează success: false
 * - error conține "ERR_POSIX_ONLY"
 * - error menționează path-ul problematic
 */
describe("apply() reject backslash paths", () => {
  it("should reject artifact path with backslash", async () => {
    const textContent = "# Test\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    // Artifact cu backslash în path (INVALID)
    const artifact: Artifact = {
      path: "test\\file.md", // BACKSLASH - trebuie respins
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "backslash-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: process.cwd()
    });

    // ACCEPTANCE: Must fail
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("ERR_POSIX_ONLY");
    expect(result.error).toContain("test\\file.md");
  });

  it("should reject artifact path with Windows-style separators", async () => {
    const artifact: Artifact = {
      path: "src\\components\\Button.tsx", // Windows-style path
      kind: "file",
      sha256: "0".repeat(64),
      bytes: 100,
      contentUtf8: "test"
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "windows-sep-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: process.cwd()
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("ERR_POSIX_ONLY");
    expect(result.error).toContain("src\\components\\Button.tsx");
  });

  it("should accept artifact path with forward slashes only", async () => {
    const textContent = "# POSIX Test\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    // VALID: only forward slashes
    const artifact: Artifact = {
      path: "test/components/Button.tsx",
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "posix-valid-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: process.cwd()
    });

    // Should succeed - no backslashes
    expect(result.success).toBe(true);
    expect(result.filesWritten[0]).not.toContain("\\");
  });

  it("should reject mixed separators", async () => {
    const artifact: Artifact = {
      path: "test/src\\mixed/path", // Mixed separators
      kind: "file",
      sha256: "0".repeat(64),
      bytes: 50,
      contentUtf8: "test"
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "mixed-sep-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: process.cwd()
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("ERR_POSIX_ONLY");
  });
});
