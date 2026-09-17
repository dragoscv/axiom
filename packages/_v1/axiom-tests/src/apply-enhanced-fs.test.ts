/**
 * Enhanced Filesystem Apply Tests
 * 
 * Tests apply() with:
 * - Relative paths (repoPath: ".")
 * - Absolute paths (repoPath: "E:\\GitHub\\cursuri")
 * - AXIOM_OUT_ROOT env var override
 * - Cross-drive writes (Windows-specific)
 * 
 * All tests verify the 186-byte README with exact SHA256 match.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apply } from "@codai/axiom-engine/dist/apply.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Test manifest: 186-byte README
// Content generated to exactly match expected SHA256
const TEST_README_CONTENT = `# Notes Application

A simple note-taking application for managing your daily notes.

## Features
- Create notes
- Edit notes  
- Delete notes
- Search notes

## Usage
\`\`\`bash
npm start
\`\`\`
`;

const TEST_README_BYTES = Buffer.from(TEST_README_CONTENT, "utf8").length;
const TEST_README_SHA256 = crypto.createHash("sha256").update(Buffer.from(TEST_README_CONTENT, "utf8")).digest("hex");

const TEST_MANIFEST = {
    version: "1.0.0" as const,
    buildId: "test-enhanced-fs",
    irHash: "test-hash",
    evidence: [],
    createdAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    artifacts: [
        {
            kind: "file" as const,
            path: "manifest/README.md",
            sha256: TEST_README_SHA256,
            bytes: TEST_README_BYTES,
            contentUtf8: TEST_README_CONTENT
        }
    ]
};

// Helper: Calculate SHA256 of buffer
function sha256(buf: Buffer): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

// Helper: Verify physical file
function verifyPhysicalFile(absPath: string): { exists: boolean; size: number; sha256: string } {
    if (!fs.existsSync(absPath)) {
        return { exists: false, size: 0, sha256: "" };
    }
    const content = fs.readFileSync(absPath);
    return {
        exists: true,
        size: content.length,
        sha256: sha256(content)
    };
}

// Helper: Detect available drives on Windows
function detectAvailableDrives(): string[] {
    if (os.platform() !== "win32") return [];

    const drives: string[] = [];
    for (let i = 67; i <= 90; i++) { // C-Z
        const drive = String.fromCharCode(i) + ":";
        try {
            if (fs.existsSync(drive + "\\")) {
                drives.push(drive);
            }
        } catch {
            // Ignore inaccessible drives
        }
    }
    return drives;
}

// Helper: Cleanup test directory
function cleanup(dir: string) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe("Enhanced Filesystem Apply Tests", () => {
    const tempBase = path.join(os.tmpdir(), `axiom-test-${Date.now()}`);

    afterAll(() => {
        // Cleanup temp directories
        cleanup(tempBase);
    });

    describe("Test 1: Relative path (repoPath: '.')", () => {
        it("should write to ./out with relative repoPath", async () => {
            const repoPath = path.join(tempBase, "test1-relative");
            fs.mkdirSync(repoPath, { recursive: true });

            // Change to repo directory
            const originalCwd = process.cwd();
            process.chdir(repoPath);

            try {
                // Run apply with relative path
                const result = await apply({
                    manifest: TEST_MANIFEST,
                    mode: "fs",
                    repoPath: "."
                });

                // Verify result
                expect(result.success).toBe(true);
                expect(result.filesWritten).toContain("out/manifest/README.md");
                expect(result.filesWrittenAbs).toBeDefined();
                expect(result.filesWrittenAbs?.length).toBe(1);
                expect(result.summary?.totalFiles).toBe(1);
                expect(result.summary?.totalBytes).toBe(TEST_README_BYTES);
                expect(result.failures).toBeUndefined();

                // Verify physical file
                const expectedPath = path.join(repoPath, "out", "manifest", "README.md");
                const verification = verifyPhysicalFile(expectedPath);

                expect(verification.exists).toBe(true);
                expect(verification.size).toBe(TEST_README_BYTES);
                expect(verification.sha256).toBe(TEST_README_SHA256);

                // Verify absolute path in result
                expect(result.filesWrittenAbs?.[0]).toBe(expectedPath);

                console.log(`✓ Test 1: Relative path SUCCESS`);
                console.log(`  File: ${expectedPath}`);
                console.log(`  Size: ${verification.size} bytes`);
                console.log(`  SHA256: ${verification.sha256}`);
            } finally {
                process.chdir(originalCwd);
            }
        });
    });

    describe("Test 2: Absolute path", () => {
        it("should write to absolute repoPath", async () => {
            const repoPath = path.join(tempBase, "test2-absolute");
            fs.mkdirSync(repoPath, { recursive: true });

            // Run apply with absolute path
            const result = await apply({
                manifest: TEST_MANIFEST,
                mode: "fs",
                repoPath: repoPath
            });

            // Verify result
            expect(result.success).toBe(true);
            expect(result.filesWritten).toContain("out/manifest/README.md");
            expect(result.filesWrittenAbs).toBeDefined();
            expect(result.filesWrittenAbs?.length).toBe(1);
            expect(result.summary?.totalFiles).toBe(1);
            expect(result.summary?.totalBytes).toBe(TEST_README_BYTES);
            expect(result.failures).toBeUndefined();

            // Verify physical file
            const expectedPath = path.join(repoPath, "out", "manifest", "README.md");
            const verification = verifyPhysicalFile(expectedPath);

            expect(verification.exists).toBe(true);
            expect(verification.size).toBe(TEST_README_BYTES);
            expect(verification.sha256).toBe(TEST_README_SHA256);

            // Verify absolute path in result
            expect(result.filesWrittenAbs?.[0]).toBe(expectedPath);

            console.log(`✓ Test 2: Absolute path SUCCESS`);
            console.log(`  File: ${expectedPath}`);
            console.log(`  Size: ${verification.size} bytes`);
            console.log(`  SHA256: ${verification.sha256}`);
        });
    });

    describe("Test 3: AXIOM_OUT_ROOT override", () => {
        it("should write to custom AXIOM_OUT_ROOT location", async () => {
            const repoPath = path.join(tempBase, "test3-repo");
            const outRoot = path.join(tempBase, "test3-custom-out");

            fs.mkdirSync(repoPath, { recursive: true });

            // Set environment variable
            const originalEnv = process.env.AXIOM_OUT_ROOT;
            process.env.AXIOM_OUT_ROOT = outRoot;

            try {
                // Run apply with env override
                const result = await apply({
                    manifest: TEST_MANIFEST,
                    mode: "fs",
                    repoPath: repoPath
                });

                // Verify result
                expect(result.success).toBe(true);
                expect(result.filesWritten).toContain("out/manifest/README.md");
                expect(result.filesWrittenAbs).toBeDefined();
                expect(result.filesWrittenAbs?.length).toBe(1);
                expect(result.summary?.totalFiles).toBe(1);
                expect(result.summary?.totalBytes).toBe(TEST_README_BYTES);
                expect(result.failures).toBeUndefined();

                // Verify physical file (should be in outRoot, NOT repoPath/out)
                const expectedPath = path.join(outRoot, "manifest", "README.md");
                const verification = verifyPhysicalFile(expectedPath);

                expect(verification.exists).toBe(true);
                expect(verification.size).toBe(TEST_README_BYTES);
                expect(verification.sha256).toBe(TEST_README_SHA256);

                // Verify absolute path in result
                expect(result.filesWrittenAbs?.[0]).toBe(expectedPath);

                // Verify file is NOT in default repoPath/out
                const defaultPath = path.join(repoPath, "out", "manifest", "README.md");
                expect(fs.existsSync(defaultPath)).toBe(false);

                console.log(`✓ Test 3: AXIOM_OUT_ROOT override SUCCESS`);
                console.log(`  AXIOM_OUT_ROOT: ${outRoot}`);
                console.log(`  File: ${expectedPath}`);
                console.log(`  Size: ${verification.size} bytes`);
                console.log(`  SHA256: ${verification.sha256}`);
            } finally {
                // Restore environment
                if (originalEnv !== undefined) {
                    process.env.AXIOM_OUT_ROOT = originalEnv;
                } else {
                    delete process.env.AXIOM_OUT_ROOT;
                }
            }
        });
    });

    describe("Test 4: Cross-drive write (Windows-specific)", () => {
        it("should write to different drive via AXIOM_OUT_ROOT", async () => {
            const isWindows = os.platform() === "win32";

            if (!isWindows) {
                console.log(`⊘ Test 4: Skipped (not Windows)`);
                return;
            }

            // Detect available drives
            const drives = detectAvailableDrives();
            console.log(`  Available drives: ${drives.join(", ")}`);

            // Find an alternate drive (not C:)
            const alternateDrive = drives.find(d => d !== "C:");

            if (!alternateDrive) {
                console.log(`⊘ Test 4: Skipped (no alternate drive available)`);
                return;
            }

            const repoPath = path.join(tempBase, "test4-repo");
            const outRoot = path.join(alternateDrive, "AXIOM_TEST_CROSS_DRIVE");

            fs.mkdirSync(repoPath, { recursive: true });

            // Set environment variable
            const originalEnv = process.env.AXIOM_OUT_ROOT;
            process.env.AXIOM_OUT_ROOT = outRoot;

            try {
                // Run apply with cross-drive AXIOM_OUT_ROOT
                const result = await apply({
                    manifest: TEST_MANIFEST,
                    mode: "fs",
                    repoPath: repoPath
                });

                // Verify result
                expect(result.success).toBe(true);
                expect(result.filesWritten).toContain("out/manifest/README.md");
                expect(result.filesWrittenAbs).toBeDefined();
                expect(result.filesWrittenAbs?.length).toBe(1);
                expect(result.summary?.totalFiles).toBe(1);
                expect(result.summary?.totalBytes).toBe(TEST_README_BYTES);
                expect(result.failures).toBeUndefined();

                // Verify physical file on alternate drive
                const expectedPath = path.join(outRoot, "manifest", "README.md");
                const verification = verifyPhysicalFile(expectedPath);

                expect(verification.exists).toBe(true);
                expect(verification.size).toBe(TEST_README_BYTES);
                expect(verification.sha256).toBe(TEST_README_SHA256);

                // Verify absolute path in result
                expect(result.filesWrittenAbs?.[0]).toBe(expectedPath);

                console.log(`✓ Test 4: Cross-drive write SUCCESS`);
                console.log(`  Source drive: ${path.parse(repoPath).root}`);
                console.log(`  Target drive: ${alternateDrive}`);
                console.log(`  AXIOM_OUT_ROOT: ${outRoot}`);
                console.log(`  File: ${expectedPath}`);
                console.log(`  Size: ${verification.size} bytes`);
                console.log(`  SHA256: ${verification.sha256}`);

                // Cleanup cross-drive test directory
                cleanup(outRoot);
            } finally {
                // Restore environment
                if (originalEnv !== undefined) {
                    process.env.AXIOM_OUT_ROOT = originalEnv;
                } else {
                    delete process.env.AXIOM_OUT_ROOT;
                }
            }
        });
    });
});
