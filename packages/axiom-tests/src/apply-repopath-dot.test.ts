/**
 * AXIOM v1.0.22 - Fail-Closed Protection for repoPath="." 
 * 
 * These tests validate that AXIOM prevents accidental writes to HOME directory
 * when using relative repoPath arguments like "." without proper context.
 * 
 * Test scenarios:
 * 1. FAIL-CLOSED when process.cwd()=HOME and repoPath="." (no AXIOM_REPO_ROOT)
 * 2. SUCCESS when AXIOM_REPO_ROOT is set to valid repo
 * 3. SUCCESS when repoPath is absolute
 * 4. SUCCESS for cross-drive writes (Windows only)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

// Test README content (190 bytes, deterministic SHA256)
const TEST_README_CONTENT = `# AXIOM Test Project

This is a test README file for AXIOM v1.0.22 fail-closed protection tests.

## Purpose
Validate that repoPath="." resolution is safe and deterministic.
`;

// Calculate expected values dynamically
const TEST_BUFFER = Buffer.from(TEST_README_CONTENT, "utf8");
const TEST_SIZE = TEST_BUFFER.length;
const TEST_SHA256 = crypto.createHash("sha256").update(TEST_BUFFER).digest("hex");

// Temporary test base directory
const TEST_BASE = path.join(os.tmpdir(), `axiom-repopath-dot-${Date.now()}`);

// Helper: Create test manifest with inline content
function createTestManifest(): Manifest {
    return {
        version: "1.0.0" as const,
        buildId: "test-repopath-dot",
        profile: "default",
        irHash: "test-hash-repopath-dot",
        evidence: [],
        createdAt: new Date().toISOString(),
        artifacts: [
            {
                kind: "file",
                path: "manifest/README.md",
                bytes: TEST_SIZE,
                sha256: TEST_SHA256,
                contentUtf8: TEST_README_CONTENT
            }
        ]
    };
}

// Helper: Calculate SHA256 of file
function sha256(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
}

// Helper: Verify physical file existence and correctness
function verifyPhysicalFile(absPath: string, expectedSize: number, expectedSha256: string): void {
    expect(fs.existsSync(absPath), `File should exist: ${absPath}`).toBe(true);
    const stat = fs.statSync(absPath);
    expect(stat.size).toBe(expectedSize);
    const actualHash = sha256(absPath);
    expect(actualHash).toBe(expectedSha256);
}

// Helper: Detect available drives (Windows only)
function detectAvailableDrives(): string[] {
    if (process.platform !== 'win32') return [];

    const drives: string[] = [];
    for (let i = 67; i <= 90; i++) { // C-Z
        const drive = String.fromCharCode(i) + ':';
        try {
            fs.accessSync(drive + '\\');
            drives.push(drive);
        } catch {
            // Drive not accessible
        }
    }
    return drives;
}

// Helper: Create fixture Git repo
function createGitFixture(fixturePath: string): void {
    fs.mkdirSync(fixturePath, { recursive: true });
    fs.mkdirSync(path.join(fixturePath, '.git'), { recursive: true });
    fs.writeFileSync(
        path.join(fixturePath, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n'
    );
}

// Cleanup helper
function cleanup(...paths: string[]): void {
    for (const p of paths) {
        if (fs.existsSync(p)) {
            fs.rmSync(p, { recursive: true, force: true });
        }
    }
}

describe("AXIOM v1.0.22 - Fail-Closed repoPath Resolution", () => {
    const originalCwd = process.cwd();
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Reset environment
        delete process.env.AXIOM_OUT_ROOT;
        delete process.env.AXIOM_REPO_ROOT;
    });

    afterEach(() => {
        // Restore environment and cwd
        process.chdir(originalCwd);
        process.env = { ...originalEnv };

        // Cleanup test directories
        try {
            if (fs.existsSync(TEST_BASE)) {
                fs.rmSync(TEST_BASE, { recursive: true, force: true });
            }
        } catch (err) {
            console.warn(`Cleanup warning: ${err}`);
        }
    });

    it("T1_fail_closed_home_cwd: FAIL-CLOSED when cwd=HOME and repoPath='.'", async () => {
        // Simulate HOME context by changing cwd to HOME
        const homeDir = os.homedir();

        // IMPORTANT: Only run this test if we can safely change to HOME
        // and there's no .git in HOME (to avoid false positive)
        const homeGitExists = fs.existsSync(path.join(homeDir, '.git'));
        if (homeGitExists) {
            console.warn(`Skipping T1: .git exists in HOME (${homeDir}), test would pass incorrectly`);
            return;
        }

        // CLEANUP: Remove any existing out/ directory in HOME from previous tests
        const homeOutDir = path.join(homeDir, "out");
        if (fs.existsSync(homeOutDir)) {
            console.warn(`Cleaning up existing HOME/out directory: ${homeOutDir}`);
            fs.rmSync(homeOutDir, { recursive: true, force: true });
        }

        // Change to HOME directory
        process.chdir(homeDir);

        // Verify we're in HOME
        expect(process.cwd()).toBe(homeDir);

        const manifest = createTestManifest();

        // Execute apply with repoPath="." (should FAIL-CLOSED)
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: "."
        });

        // EXPECTATIONS:
        // 1. success=false
        expect(result.success).toBe(false);

        // 2. Error message contains ERR_REPOPATH_RELATIVE_UNSAFE
        expect(result.error).toBeDefined();
        expect(result.error).toContain("ERR_REPOPATH_RELATIVE_UNSAFE");

        // 3. Zero files written
        expect(result.filesWritten.length).toBe(0);

        // 4. Failures array should contain guidance
        expect(result.failures).toBeDefined();
        expect(result.failures!.length).toBeGreaterThan(0);
        expect(result.failures![0].reason).toContain("ERR_REPOPATH_RELATIVE_UNSAFE");

        // 5. CRITICAL: Verify NO files were physically written to HOME/out/
        const homeOutPath = path.join(homeDir, "out", "manifest", "README.md");
        expect(fs.existsSync(homeOutPath)).toBe(false);

        console.log(`✓ T1 PASS: Prevented write to HOME (${homeDir})`);
    });

    it("T2_env_override_ok: SUCCESS when AXIOM_REPO_ROOT is set", async () => {
        // Create fixture Git repo
        const fixturePath = path.join(TEST_BASE, "test2-fixture-repo");
        createGitFixture(fixturePath);

        // Set AXIOM_REPO_ROOT to fixture
        process.env.AXIOM_REPO_ROOT = fixturePath;

        // Change cwd to somewhere else (e.g., tmpdir)
        process.chdir(os.tmpdir());

        const manifest = createTestManifest();

        // Execute apply with repoPath="." (should succeed via AXIOM_REPO_ROOT)
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: "."
        });

        // EXPECTATIONS:
        // 1. success=true
        expect(result.success).toBe(true);

        // 2. One file written
        expect(result.filesWritten.length).toBe(1);
        expect(result.filesWritten[0]).toBe("out/manifest/README.md");

        // 3. filesWrittenAbs should point to fixture repo
        expect(result.filesWrittenAbs).toBeDefined();
        expect(result.filesWrittenAbs!.length).toBe(1);
        const absPath = result.filesWrittenAbs![0];
        expect(absPath).toContain(fixturePath);

        // 4. Physical verification
        verifyPhysicalFile(absPath, TEST_SIZE, TEST_SHA256);

        console.log(`✓ T2 PASS: AXIOM_REPO_ROOT override successful`);
        console.log(`  Fixture: ${fixturePath}`);
        console.log(`  Written: ${absPath}`);
        console.log(`  Size: ${TEST_SIZE} bytes`);
        console.log(`  SHA256: ${TEST_SHA256}`);
    });

    it("T3_absolute_ok: SUCCESS with absolute repoPath", async () => {
        // Create fixture repo
        const fixturePath = path.join(TEST_BASE, "test3-absolute-repo");
        createGitFixture(fixturePath);

        const manifest = createTestManifest();

        // Execute apply with ABSOLUTE repoPath
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: fixturePath // ABSOLUTE
        });

        // EXPECTATIONS:
        // 1. success=true
        expect(result.success).toBe(true);

        // 2. One file written
        expect(result.filesWritten.length).toBe(1);

        // 3. filesWrittenAbs verification
        expect(result.filesWrittenAbs).toBeDefined();
        const absPath = result.filesWrittenAbs![0];

        // 4. Physical verification
        verifyPhysicalFile(absPath, TEST_SIZE, TEST_SHA256);

        console.log(`✓ T3 PASS: Absolute repoPath successful`);
        console.log(`  Repo: ${fixturePath}`);
        console.log(`  Written: ${absPath}`);
        console.log(`  Size: ${TEST_SIZE} bytes`);
        console.log(`  SHA256: ${TEST_SHA256}`);
    });

    it("T4_cross_drive_ok: SUCCESS for cross-drive write (Windows only)", async () => {
        // Skip on non-Windows
        if (process.platform !== 'win32') {
            console.log(`⊘ T4 SKIP: Not Windows (platform: ${process.platform})`);
            return;
        }

        // Detect available drives
        const drives = detectAvailableDrives();
        console.log(`Detected drives: ${drives.join(', ')}`);

        // Find a drive different from C:
        const targetDrive = drives.find(d => d.toUpperCase() !== 'C:');

        if (!targetDrive) {
            console.log(`⊘ T4 SKIP: No alternative drive found (only C: available)`);
            return;
        }

        // Create fixture repo on C:
        const fixturePath = path.join(TEST_BASE, "test4-cross-drive-repo");
        createGitFixture(fixturePath);

        // Set AXIOM_OUT_ROOT to different drive
        const crossDriveOut = path.join(targetDrive, "AXIOM_TEST_CROSS_DRIVE_T4");
        process.env.AXIOM_OUT_ROOT = crossDriveOut;

        const manifest = createTestManifest();

        // Execute apply
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: fixturePath
        });

        // EXPECTATIONS:
        // 1. success=true
        expect(result.success).toBe(true);

        // 2. One file written
        expect(result.filesWritten.length).toBe(1);

        // 3. filesWrittenAbs should point to target drive
        expect(result.filesWrittenAbs).toBeDefined();
        const absPath = result.filesWrittenAbs![0];
        expect(absPath.toUpperCase()).toContain(targetDrive.toUpperCase());

        // 4. Physical verification on target drive
        verifyPhysicalFile(absPath, TEST_SIZE, TEST_SHA256);

        // Cleanup cross-drive directory
        cleanup(crossDriveOut);

        console.log(`✓ T4 PASS: Cross-drive write successful`);
        console.log(`  Source drive: C:`);
        console.log(`  Target drive: ${targetDrive}`);
        console.log(`  AXIOM_OUT_ROOT: ${crossDriveOut}`);
        console.log(`  Written: ${absPath}`);
        console.log(`  Size: ${TEST_SIZE} bytes`);
        console.log(`  SHA256: ${TEST_SHA256}`);
    });
});
