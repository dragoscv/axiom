import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine/dist/manifest.js";

/**
 * Test apply security validations
 * 
 * ACCEPTANCE:
 * - Reject absolute paths
 * - Reject path traversal (..)
 * - Reject paths outside out/ directory
 */
describe("apply security test", () => {
    const tmpRepo = join(process.cwd(), "tmp-security-test");

    beforeEach(() => {
        if (existsSync(tmpRepo)) {
            rmSync(tmpRepo, { recursive: true, force: true });
        }
        mkdirSync(tmpRepo, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(tmpRepo)) {
            rmSync(tmpRepo, { recursive: true, force: true });
        }
    });

    it("should reject absolute paths", async () => {
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "security-absolute",
            irHash: "test-hash",
            createdAt: new Date().toISOString(),
            evidence: [],
            artifacts: [
                {
                    path: "/etc/passwd", // Absolute path
                    kind: "file",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                    bytes: 10,
                    contentUtf8: "HACK\n"
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: tmpRepo
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Absolute paths not allowed");
        expect(result.error).toContain("/etc/passwd");

        console.log("✅ SECURITY TEST PASSED: Absolute path rejected");
    });

    it("should reject path traversal with ..", async () => {
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "security-traversal",
            irHash: "test-hash",
            createdAt: new Date().toISOString(),
            evidence: [],
            artifacts: [
                {
                    path: "../../../etc/passwd", // Path traversal
                    kind: "file",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                    bytes: 10,
                    contentUtf8: "HACK\n"
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: tmpRepo
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Path traversal not allowed");

        console.log("✅ SECURITY TEST PASSED: Path traversal rejected");
    });

    it("should reject paths with .. segment anywhere", async () => {
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "security-dotdot",
            irHash: "test-hash",
            createdAt: new Date().toISOString(),
            evidence: [],
            artifacts: [
                {
                    path: "safe/../evil/hack.txt",
                    kind: "file",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                    bytes: 10,
                    contentUtf8: "HACK\n"
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: tmpRepo
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Path traversal not allowed");

        console.log("✅ SECURITY TEST PASSED: .. segment rejected");
    });

    it("should allow safe relative paths under out/", async () => {
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "security-safe",
            irHash: "test-hash",
            createdAt: new Date().toISOString(),
            evidence: [],
            artifacts: [
                {
                    path: "safe/file.txt",
                    kind: "file",
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // empty sha256
                    bytes: 14,
                    contentUtf8: "SAFE_CONTENT\n"
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: tmpRepo
        });

        expect(result.success).toBe(true);
        expect(result.filesWritten).toContain("out/safe/file.txt");

        console.log("✅ SECURITY TEST PASSED: Safe path accepted");
    });
});
