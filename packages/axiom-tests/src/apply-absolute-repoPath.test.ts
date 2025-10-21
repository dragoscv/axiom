import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apply } from "@codai/axiom-engine";
import type { Manifest, Artifact } from "@codai/axiom-engine/dist/manifest.js";
import { createHash } from "node:crypto";
import { platform } from "node:os";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * TEST: Absolute repoPath handling (Windows specific)
 * 
 * VERIFICĂRI:
 * - Acceptă repoPath absolut Windows (E:\GitHub\test sau E:/GitHub/test)
 * - Acceptă repoPath absolut Unix (/home/user/test)
 * - Raportarea în filesWritten rămâne POSIX (fără backslash)
 * - Fișierele se scriu corect pe disc
 */
describe("apply() absolute repoPath handling", () => {
  let tmpRepoAbs: string;

  beforeEach(async () => {
    tmpRepoAbs = await mkdtemp(join(tmpdir(), "axiom-abs-path-"));
  });

  afterEach(async () => {
    await rm(tmpRepoAbs, { recursive: true, force: true });
  });

  it("should handle absolute Unix-style path", async () => {
    const textContent = "# Test\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    const artifact: Artifact = {
      path: "test/file.md",
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "abs-path-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    // Convert to Unix-style path (works on both Windows and Linux)
    const unixStylePath = tmpRepoAbs.replace(/\\/g, '/');

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: unixStylePath
    });

    expect(result.success).toBe(true);
    expect(result.filesWritten).toEqual(["out/test/file.md"]);
    
    // Verify no backslashes in filesWritten
    expect(result.filesWritten[0]).not.toContain("\\");
  });

  it("should handle Windows-style absolute path on Windows", async () => {
    // Skip on non-Windows platforms
    if (platform() !== "win32") {
      return;
    }

    const textContent = "# Windows Path Test\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    const artifact: Artifact = {
      path: "windows/test.md",
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "windows-path-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    // Use Windows-style path with backslashes
    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: tmpRepoAbs // Already contains backslashes on Windows
    });

    expect(result.success).toBe(true);
    expect(result.filesWritten).toEqual(["out/windows/test.md"]);
    
    // CRITICAL: filesWritten must be POSIX even on Windows
    expect(result.filesWritten[0]).not.toContain("\\");
  });

  it("should normalize relative repoPath to absolute", async () => {
    const textContent = "# Relative Path Test\n";
    const textBuffer = Buffer.from(textContent, "utf-8");
    const textSha256 = sha256(textBuffer);

    const artifact: Artifact = {
      path: "rel/file.md",
      kind: "file",
      sha256: textSha256,
      bytes: textBuffer.byteLength,
      contentUtf8: textContent
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "rel-path-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    // Use relative path (should be resolved)
    const relativePath = join(".", tmpRepoAbs);

    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: relativePath
    });

    expect(result.success).toBe(true);
    expect(result.filesWritten).toEqual(["out/rel/file.md"]);
  });

  it("should reject invalid repoPath", async () => {
    const artifact: Artifact = {
      path: "test/file.md",
      kind: "file",
      sha256: "0".repeat(64),
      bytes: 10,
      contentUtf8: "test"
    };

    const manifest: Manifest = {
      version: "1.0.0",
      buildId: "invalid-path-test",
      irHash: "fake-ir",
      createdAt: new Date().toISOString(),
      artifacts: [artifact],
      evidence: []
    };

    // Use completely invalid path
    const result = await apply({
      manifest,
      mode: "fs",
      repoPath: "/nonexistent/totally/fake/path/xyz123456789"
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Invalid repoPath");
  });
});
