/**
 * Test: apply trebuie să respingă path traversal și să scrie DOAR în repoPath/out
 */

import { describe, it, expect } from "vitest";
import { apply } from "@codai/axiom-engine/dist/apply.js";
import type { Manifest } from "@codai/axiom-engine/dist/manifest.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Apply Security - Path Traversal Guard", () => {
  it("should reject path traversal attempts with ..", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-sandbox-test-"));

    try {
      const maliciousManifest: Manifest = {
        version: "1.0.0",
        buildId: "test-malicious",
        irHash: "abc123",
        artifacts: [
          {
            path: "../etc/passwd", // Path traversal
            kind: "file",
            sha256: "fake",
            bytes: 100
          }
        ],
        evidence: [],
        createdAt: "2025-01-01"
      };

      const result = await apply({
        manifest: maliciousManifest,
        mode: "fs",
        repoPath: tmpDir
      });

      // ASSERT: Trebuie să eșueze
      expect(result.success).toBe(false);
      expect(result.error).toContain("traversal");

      console.log("[apply-sandbox.test] ✓ Path traversal rejected");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should reject absolute paths", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-sandbox-abs-"));

    try {
      const maliciousManifest: Manifest = {
        version: "1.0.0",
        buildId: "test-absolute",
        irHash: "xyz789",
        artifacts: [
          {
            path: "/etc/passwd", // Absolute path
            kind: "file",
            sha256: "fake",
            bytes: 100
          }
        ],
        evidence: [],
        createdAt: "2025-01-01"
      };

      const result = await apply({
        manifest: maliciousManifest,
        mode: "fs",
        repoPath: tmpDir
      });

      // ASSERT: Trebuie să eșueze
      expect(result.success).toBe(false);
      expect(result.error).toContain("Absolute paths not allowed");

      console.log("[apply-sandbox.test] ✓ Absolute path rejected");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should only allow writes under repoPath/out", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-sandbox-out-"));

    // Creează out/ și subdirectoare
    const outWebappDir = path.join(tmpDir, "out", "webapp");
    fs.mkdirSync(outWebappDir, { recursive: true });

    try {
      const validManifest: Manifest = {
        version: "1.0.0",
        buildId: "test-valid",
        irHash: "valid123",
        artifacts: [
          {
            path: "out/webapp/index.html", // Valid - sub out/
            kind: "file",
            sha256: "valid",
            bytes: 200
          }
        ],
        evidence: [],
        createdAt: "2025-01-01"
      };

      // Scriem efectiv fișierul pentru test
      fs.writeFileSync(path.join(outWebappDir, "index.html"), "<html>test</html>");

      const result = await apply({
        manifest: validManifest,
        mode: "fs",
        repoPath: tmpDir
      });

      // ASSERT: Trebuie să reușească
      expect(result.success).toBe(true);
      expect(result.filesWritten).toContain("out/webapp/index.html");

      console.log("[apply-sandbox.test] ✓ Write under out/ allowed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
