/**
 * Windows long path support tests (v1.0.24)
 * 
 * PURPOSE: Validate that files with paths > 260 characters can be written successfully on Windows.
 * 
 * COVERAGE:
 * - Paths exceeding MAX_PATH (260 chars)
 * - Read-back verification with SHA256
 * - filesWrittenAbs contains correct long paths
 * 
 * NOTE: Windows 10+ supports long paths natively if enabled, or via \\?\ prefix.
 * Node.js handles this automatically in recent versions.
 */

import { describe, it, expect, afterEach } from "vitest";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const TEST_CONTENT = "# Long Path Test\n\nThis file has a very long path.\n";
const TEST_SHA256 = crypto.createHash("sha256").update(TEST_CONTENT, "utf8").digest("hex");
const TEST_BYTES = Buffer.byteLength(TEST_CONTENT, "utf8");

function createLongPathManifest(depth: number): Manifest {
    // Create nested path segments to exceed 260 characters
    const segments: string[] = [];
    for (let i = 0; i < depth; i++) {
        segments.push(`level${i.toString().padStart(3, '0')}-directory-with-long-name`);
    }
    segments.push("final-file-with-long-name.txt");
    
    const artifactPath = segments.join("/");

    return {
        version: "1.0.0",
        buildId: "long-path-test",
        irHash: "test-hash-long",
        evidence: [],
        createdAt: new Date().toISOString(),
        artifacts: [
            {
                kind: "file",
                path: artifactPath,
                sha256: TEST_SHA256,
                bytes: TEST_BYTES,
                contentUtf8: TEST_CONTENT
            }
        ]
    };
}

function verifyPhysicalFile(filePath: string): { exists: boolean; size: number; sha256: string; pathLength: number } {
    if (!fs.existsSync(filePath)) {
        return { exists: false, size: 0, sha256: "", pathLength: 0 };
    }
    const content = fs.readFileSync(filePath);
    return {
        exists: true,
        size: content.length,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        pathLength: filePath.length
    };
}

describe("Windows Long Path Support", () => {
    let cleanupPaths: string[] = [];

    afterEach(() => {
        // Cleanup
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

    it("L1: Writes file with path > 260 characters", async () => {
        if (process.platform !== "win32") {
            console.log("⊘ Skipped: Windows-specific long path test");
            return;
        }

        // Create test directory
        const baseDir = path.join(os.tmpdir(), `axiom-long-path-${Date.now()}`);
        fs.mkdirSync(baseDir, { recursive: true });
        cleanupPaths.push(baseDir);

        // Create manifest with deep nesting (target > 260 chars total path)
        const manifest = createLongPathManifest(10); // 10 levels of 40+ char segments
        
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: baseDir
        });

        expect(result.success).toBe(true);
        expect(result.filesWritten).toHaveLength(1);
        expect(result.filesWrittenAbs).toBeDefined();
        
        const writtenPath = result.filesWrittenAbs![0];
        console.log(`Long path length: ${writtenPath.length} chars`);
        
        // ASSERTION: Path exceeds 260 characters
        expect(writtenPath.length).toBeGreaterThan(260);

        // ASSERTION: Physical file exists and is correct
        const verification = verifyPhysicalFile(writtenPath);
        expect(verification.exists).toBe(true);
        expect(verification.size).toBe(TEST_BYTES);
        expect(verification.sha256).toBe(TEST_SHA256);
        
        console.log(`✓ Long path write successful: ${writtenPath.length} chars, SHA256 verified`);
    });

    it("L2: filesWrittenAbs contains full long path", async () => {
        if (process.platform !== "win32") {
            console.log("⊘ Skipped: Windows-specific test");
            return;
        }

        const baseDir = path.join(os.tmpdir(), `axiom-longpath-abs-${Date.now()}`);
        fs.mkdirSync(baseDir, { recursive: true });
        cleanupPaths.push(baseDir);

        const manifest = createLongPathManifest(8);
        
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: baseDir
        });

        expect(result.success).toBe(true);
        expect(result.filesWrittenAbs).toBeDefined();
        
        const reportedPath = result.filesWrittenAbs![0];
        
        // ASSERTION: Reported path is absolute
        expect(path.isAbsolute(reportedPath)).toBe(true);
        
        // ASSERTION: Reported path matches actual file location
        const verification = verifyPhysicalFile(reportedPath);
        expect(verification.exists).toBe(true);
        
        console.log(`✓ filesWrittenAbs contains correct long path: ${reportedPath.length} chars`);
    });

    it("L3: Multiple long paths in single manifest", async () => {
        if (process.platform !== "win32") {
            console.log("⊘ Skipped: Windows-specific test");
            return;
        }

        const baseDir = path.join(os.tmpdir(), `axiom-multi-long-${Date.now()}`);
        fs.mkdirSync(baseDir, { recursive: true });
        cleanupPaths.push(baseDir);

        // Create manifest with 3 long paths
        const artifacts = [
            createLongPathManifest(8).artifacts[0],
            {
                ...createLongPathManifest(9).artifacts[0],
                path: createLongPathManifest(9).artifacts[0].path.replace(/level/g, 'tier')
            },
            {
                ...createLongPathManifest(10).artifacts[0],
                path: createLongPathManifest(10).artifacts[0].path.replace(/level/g, 'depth')
            }
        ];

        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "multi-long-path",
            irHash: "test-multi-long",
            evidence: [],
            createdAt: new Date().toISOString(),
            artifacts
        };

        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: baseDir
        });

        expect(result.success).toBe(true);
        expect(result.filesWritten).toHaveLength(3);
        expect(result.filesWrittenAbs).toHaveLength(3);

        // Verify all files
        for (const writtenPath of result.filesWrittenAbs!) {
            const verification = verifyPhysicalFile(writtenPath);
            expect(verification.exists).toBe(true);
            expect(verification.sha256).toBe(TEST_SHA256);
            console.log(`  ✓ Verified: ${writtenPath.length} chars`);
        }

        console.log(`✓ All ${artifacts.length} long paths written and verified`);
    });
});
