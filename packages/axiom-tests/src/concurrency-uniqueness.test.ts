/**
 * Concurrency and uniqueness tests (v1.0.24)
 * 
 * PURPOSE: Validate that parallel writes handle tmp file uniqueness correctly.
 * 
 * COVERAGE:
 * - 200 artifacts written in parallel
 * - Zero tmp file collisions
 * - Zero race conditions
 * - All files pass read-back verification
 */

import { describe, it, expect, afterEach } from "vitest";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "crypto";

function createConcurrentManifest(fileCount: number): Manifest {
    const artifacts: Manifest["artifacts"] = [];

    for (let i = 0; i < fileCount; i++) {
        const content = `# File ${i}\n\nConcurrent write test file number ${i}.\n`;
        const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
        const bytes = Buffer.byteLength(content, "utf8");

        artifacts.push({
            kind: "file",
            path: `concurrent/batch-${Math.floor(i / 20)}/file-${i.toString().padStart(4, '0')}.txt`,
            sha256,
            bytes,
            contentUtf8: content
        });
    }

    return {
        version: "1.0.0",
        buildId: "concurrent-test",
        irHash: "test-hash-concurrent",
        evidence: [],
        createdAt: new Date().toISOString(),
        artifacts
    };
}

function verifyPhysicalFile(filePath: string, expectedContent: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    const actual = fs.readFileSync(filePath, "utf8");
    return actual === expectedContent;
}

describe("Concurrency and Uniqueness", () => {
    let cleanupPaths: string[] = [];

    afterEach(() => {
        for (const p of cleanupPaths) {
            try {
                if (fs.existsSync(p)) {
                    fs.rmSync(p, { recursive: true, force: true });
                }
            } catch (err) {
                console.warn(`Cleanup failed for ${p}:`, err);
            }
        }
        cleanupPaths = [];
    });

    it("C1: Writes 200 artifacts in parallel without collisions", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-concurrent-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        const fileCount = 200;
        const manifest = createConcurrentManifest(fileCount);

        const startTime = Date.now();
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });
        const duration = Date.now() - startTime;

        // ASSERTION: All files written successfully
        expect(result.success).toBe(true);
        expect(result.filesWritten).toHaveLength(fileCount);
        expect(result.filesWrittenAbs).toHaveLength(fileCount);

        console.log(`✓ ${fileCount} files written in ${duration}ms (${(duration / fileCount).toFixed(2)}ms per file avg)`);

        // ASSERTION: Zero failures (no collisions)
        expect(result.failures).toBeUndefined();

        // ASSERTION: All files physically exist
        let verifiedCount = 0;
        for (let i = 0; i < fileCount; i++) {
            const artifactPath = manifest.artifacts[i].path;
            const expectedPath = path.join(testDir, "out", artifactPath);
            const expectedContent = manifest.artifacts[i].contentUtf8!;

            if (verifyPhysicalFile(expectedPath, expectedContent)) {
                verifiedCount++;
            }
        }

        expect(verifiedCount).toBe(fileCount);
        console.log(`✓ All ${fileCount} files verified physically with correct content`);
    });

    it("C2: Tmp file uniqueness under high concurrency", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-tmp-unique-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        // Create manifest with files in SAME directory (stress tmp naming)
        const artifacts: Manifest["artifacts"] = [];
        for (let i = 0; i < 100; i++) {
            const content = `File ${i}\n`;
            artifacts.push({
                kind: "file",
                path: `same-dir/file-${i}.txt`,
                sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
                bytes: Buffer.byteLength(content, "utf8"),
                contentUtf8: content
            });
        }

        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "tmp-unique-test",
            irHash: "test-tmp-unique",
            evidence: [],
            createdAt: new Date().toISOString(),
            artifacts
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        // ASSERTION: All files written (no tmp collisions)
        expect(result.success).toBe(true);
        expect(result.filesWritten).toHaveLength(100);

        // ASSERTION: No orphaned tmp files remain
        const targetDir = path.join(testDir, "out", "same-dir");
        const files = fs.readdirSync(targetDir);
        const tmpFiles = files.filter(f => f.includes(".tmp-"));

        expect(tmpFiles).toHaveLength(0);
        console.log(`✓ Zero orphaned tmp files (${files.length} final files, 0 tmp files)`);
    });

    it("C3: Race condition safety - read-back verification", async () => {
        const testDir = path.join(os.tmpdir(), `axiom-race-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        cleanupPaths.push(testDir);

        const manifest = createConcurrentManifest(50);

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: testDir
        });

        expect(result.success).toBe(true);

        // ASSERTION: Each reported success has correct SHA256
        for (let i = 0; i < manifest.artifacts.length; i++) {
            const artifact = manifest.artifacts[i];
            const reportedPath = result.filesWrittenAbs![i];

            const actualContent = fs.readFileSync(reportedPath);
            const actualSha256 = crypto.createHash("sha256").update(actualContent).digest("hex");

            expect(actualSha256).toBe(artifact.sha256);
        }

        console.log("✓ All files have correct SHA256 - no race condition data corruption");
    });
});
