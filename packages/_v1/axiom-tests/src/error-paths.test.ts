/**
 * Error path and failure handling tests (v1.0.24)
 * 
 * PURPOSE: Validate that write failures are handled correctly with proper error codes.
 * 
 * COVERAGE:
 * - Write to read-only directory
 * - Write to inaccessible path
 * - success=false with proper failure reasons
 * - attemptPath populated in failures
 * - Stable error codes (ERR_WRITE_FAILED, etc.)
 */

import { describe, it, expect, afterEach } from "vitest";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const TEST_CONTENT = "# Error Test\n\nThis should fail to write.\n";
const TEST_SHA256 = crypto.createHash("sha256").update(TEST_CONTENT, "utf8").digest("hex");
const TEST_BYTES = Buffer.byteLength(TEST_CONTENT, "utf8");

function createErrorManifest(): Manifest {
    return {
        version: "1.0.0",
        buildId: "error-path-test",
        irHash: "test-hash-error",
        evidence: [],
        createdAt: new Date().toISOString(),
        artifacts: [
            {
                kind: "file",
                path: "output/test-file.txt",
                sha256: TEST_SHA256,
                bytes: TEST_BYTES,
                contentUtf8: TEST_CONTENT
            }
        ]
    };
}

describe("Error Path Handling", () => {
    let cleanupPaths: string[] = [];

    afterEach(() => {
        // Cleanup and restore permissions
        for (const p of cleanupPaths) {
            try {
                if (fs.existsSync(p)) {
                    // Restore write permissions before deletion
                    try {
                        fs.chmodSync(p, 0o755);
                    } catch {}
                    fs.rmSync(p, { recursive: true, force: true });
                }
            } catch (err) {
                console.warn(`Cleanup failed for ${p}:`, err);
            }
        }
        cleanupPaths = [];
    });

    it("E1: Write to read-only directory fails gracefully", async () => {
        if (process.platform === "win32") {
            console.log("⊘ Skipped: Read-only test unreliable on Windows");
            return;
        }

        // Create test directory
        const testDir = path.join(os.tmpdir(), `axiom-readonly-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        // Create output directory and make it read-only
        const outDir = path.join(testDir, "out");
        fs.mkdirSync(outDir, { recursive: true });
        fs.chmodSync(outDir, 0o444); // Read-only

        const manifest = createErrorManifest();
        
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        // ASSERTION: success=false
        expect(result.success).toBe(false);
        expect(result.filesWritten).toHaveLength(0);

        // ASSERTION: failures populated with reason
        expect(result.failures).toBeDefined();
        expect(result.failures!.length).toBeGreaterThan(0);

        const failure = result.failures![0];
        expect(failure.reason).toMatch(/ERR_WRITE_FAILED|EACCES|EPERM/);
        
        console.log(`✓ Read-only write failed gracefully: ${failure.reason}`);
    });

    it("E2: failures[] contains attemptPath for debugging", async () => {
        if (process.platform === "win32") {
            console.log("⊘ Skipped: Permission test unreliable on Windows");
            return;
        }

        const testDir = path.join(os.tmpdir(), `axiom-attempt-path-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        const outDir = path.join(testDir, "out");
        fs.mkdirSync(outDir, { recursive: true });
        fs.chmodSync(outDir, 0o444);

        const manifest = createErrorManifest();
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        expect(result.success).toBe(false);
        expect(result.failures).toBeDefined();

        const failure = result.failures![0];
        
        // ASSERTION: attemptPath present
        expect(failure.attemptPath).toBeDefined();
        expect(failure.attemptPath).toContain(testDir);
        
        console.log(`✓ attemptPath populated: ${failure.attemptPath}`);
    });

    it("E3: Invalid artifact path reports clear error", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-invalid-path-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        // Create manifest with invalid path (backslash)
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "invalid-path-test",
            irHash: "test-invalid",
            evidence: [],
            createdAt: new Date().toISOString(),
            artifacts: [
                {
                    kind: "file",
                    path: "output\\invalid\\path.txt", // Backslash - invalid
                    sha256: TEST_SHA256,
                    bytes: TEST_BYTES,
                    contentUtf8: TEST_CONTENT
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        expect(result.success).toBe(false);
        expect(result.failures).toBeDefined();

        const failure = result.failures![0];
        expect(failure.reason).toMatch(/ERR_ARTIFACT_PATH_BACKSLASH/);
        
        console.log(`✓ Invalid path error: ${failure.reason}`);
    });

    it("E4: Path traversal attempt fails with clear error", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-traversal-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "traversal-test",
            irHash: "test-traversal",
            evidence: [],
            createdAt: new Date().toISOString(),
            artifacts: [
                {
                    kind: "file",
                    path: "../../etc/passwd", // Path traversal
                    sha256: TEST_SHA256,
                    bytes: TEST_BYTES,
                    contentUtf8: TEST_CONTENT
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        expect(result.success).toBe(false);
        expect(result.failures).toBeDefined();

        const failure = result.failures![0];
        expect(failure.reason).toMatch(/ERR_ARTIFACT_PATH_TRAVERSAL/);
        
        console.log(`✓ Path traversal blocked: ${failure.reason}`);
    });

    it("E5: Hash mismatch detected and reported", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-hash-mismatch-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        // Create manifest with WRONG hash
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "hash-mismatch-test",
            irHash: "test-hash-mismatch",
            evidence: [],
            createdAt: new Date().toISOString(),
            artifacts: [
                {
                    kind: "file",
                    path: "output/file.txt",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000", // Wrong
                    bytes: TEST_BYTES,
                    contentUtf8: TEST_CONTENT
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        expect(result.success).toBe(false);
        expect(result.failures).toBeDefined();

        const failure = result.failures![0];
        expect(failure.reason).toMatch(/ERR_POST_WRITE_HASH_MISMATCH/);
        expect(failure.expected?.sha256).toBe("0000000000000000000000000000000000000000000000000000000000000000");
        expect(failure.actual?.sha256).toBe(TEST_SHA256);
        
        console.log(`✓ Hash mismatch detected: expected ${failure.expected?.sha256?.substring(0, 16)}..., got ${failure.actual?.sha256?.substring(0, 16)}...`);
    });

    it("E6: Size mismatch detected and reported", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-size-mismatch-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "size-mismatch-test",
            irHash: "test-size-mismatch",
            evidence: [],
            createdAt: new Date().toISOString(),
            artifacts: [
                {
                    kind: "file",
                    path: "output/file.txt",
                    sha256: TEST_SHA256,
                    bytes: 9999, // Wrong size
                    contentUtf8: TEST_CONTENT
                }
            ]
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        expect(result.success).toBe(false);
        expect(result.failures).toBeDefined();

        const failure = result.failures![0];
        expect(failure.reason).toMatch(/ERR_POST_WRITE_SIZE_MISMATCH/);
        expect(failure.expected?.bytes).toBe(9999);
        expect(failure.actual?.bytes).toBe(TEST_BYTES);
        
        console.log(`✓ Size mismatch detected: expected ${failure.expected?.bytes}, got ${failure.actual?.bytes}`);
    });
});
