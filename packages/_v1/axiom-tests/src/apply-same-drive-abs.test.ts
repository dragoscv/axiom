/**
 * Critical test suite for v1.0.23: Same-drive absolute path writes
 * 
 * Bug fixed: apply() reported success:true with filesWritten:1, but file did not exist physically
 * Root cause: path.resolve() without explicit base, or relative path calculations falling to process.cwd()
 * 
 * This test MUST fail if apply() reports success without physical file on disk
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// Test manifest with deterministic content
const TEST_CONTENT = "# AXIOM Test Project\n\nThis is a test README file.\n";
const TEST_SHA256 = "b5fe17148c741e102ccf3919244bded1f89f6dbe5ca730bbedbd1c2a4436d5cb"; // Correct SHA256
const TEST_BYTES = 50; // Correct byte count

/**
 * Create test manifest with single artifact: manifest/README.md
 */
function createTestManifest(): Manifest {
    return {
        version: "1.0.0" as const,
        buildId: "test-same-drive-abs",
        irHash: "test-hash-same-drive",
        evidence: [],
        createdAt: new Date().toISOString(),
        artifacts: [
            {
                kind: "file",
                path: "manifest/README.md",
                sha256: TEST_SHA256,
                bytes: TEST_BYTES,
                contentUtf8: TEST_CONTENT
            }
        ]
    };
}

/**
 * Calculate SHA256 for verification
 */
function sha256(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Verify file exists physically with exact size and hash
 */
function verifyPhysicalFile(absPath: string, expectedSize: number, expectedSha256: string): {
    exists: boolean;
    size?: number;
    sha256?: string;
    match: boolean;
} {
    if (!fs.existsSync(absPath)) {
        return { exists: false, match: false };
    }

    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath);
    const actualSha256 = crypto.createHash("sha256").update(content).digest("hex");

    const match = (stat.size === expectedSize) && (actualSha256 === expectedSha256);

    return {
        exists: true,
        size: stat.size,
        sha256: actualSha256,
        match
    };
}

/**
 * Create Git fixture repository for testing
 */
function createGitFixture(basePath: string): void {
    const gitDir = path.join(basePath, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\n");
}

/**
 * Cleanup helper
 */
function cleanup(paths: string[]): void {
    for (const p of paths) {
        if (fs.existsSync(p)) {
            fs.rmSync(p, { recursive: true, force: true });
        }
    }
}

describe("AXIOM v1.0.23 - Same-Drive Absolute Path Write Fix", () => {
    const tmpBase = path.join(os.tmpdir(), `axiom-same-drive-abs-${Date.now()}`);
    const cleanupPaths: string[] = [];

    afterEach(() => {
        cleanup(cleanupPaths);
        cleanupPaths.length = 0;
    });

    it("T1: FAIL-CLOSED when cwd=HOME and repoPath='.' (regression check from v1.0.22)", async () => {
        const homeDir = os.homedir();
        const originalCwd = process.cwd();
        const homeOutDir = path.join(homeDir, "out");

        try {
            // Cleanup any existing HOME/out directory from previous tests
            if (fs.existsSync(homeOutDir)) {
                console.warn(`Cleaning up existing HOME/out directory: ${homeOutDir}`);
                fs.rmSync(homeOutDir, { recursive: true, force: true });
            }

            // Change to HOME directory
            process.chdir(homeDir);

            // Unset AXIOM_REPO_ROOT to ensure fail-closed behavior
            delete process.env.AXIOM_REPO_ROOT;

            const manifest = createTestManifest();

            // Apply with repoPath="." - should FAIL with ERR_REPOPATH_RELATIVE_UNSAFE
            const result = await apply({
                manifest,
                mode: "fs",
                repoPath: "."
            });

            // Assertions
            expect(result.success).toBe(false);
            expect(result.error).toContain("ERR_REPOPATH_RELATIVE_UNSAFE");
            expect(result.filesWritten.length).toBe(0);
            expect(result.failures).toBeDefined();
            expect(result.failures![0].reason).toContain("ERR_REPOPATH_RELATIVE_UNSAFE");

            // Physical verification: NO files in HOME/out/
            const expectedFilePath = path.join(homeDir, "out", "manifest", "README.md");
            expect(fs.existsSync(expectedFilePath)).toBe(false);

        } finally {
            process.chdir(originalCwd);
        }
    });

    it("T2: CRITICAL - Same-drive absolute repoPath MUST write physical file", async () => {
        // Get current drive
        const cwdDrive = path.parse(process.cwd()).root;

        // Create fixture repository on SAME drive as process.cwd()
        // Use os.tmpdir() which is typically on C: (Windows) or system temp
        // Force same drive by using current drive's temp location
        const driveLetter = cwdDrive[0]; // E.g., "E"
        const fixturePath = path.join(`${driveLetter}:\\temp-axiom-test`, `test2-same-drive-repo-${Date.now()}`);

        fs.mkdirSync(fixturePath, { recursive: true });
        createGitFixture(fixturePath);
        cleanupPaths.push(fixturePath);

        // Verify we're on the same drive
        const fixtureDrive = path.parse(fixturePath).root;
        console.log(`Same-drive test: cwd=${cwdDrive}, fixture=${fixtureDrive}`);
        expect(cwdDrive.toLowerCase()).toBe(fixtureDrive.toLowerCase());

        // Unset AXIOM_OUT_ROOT to use default: repoPath/out
        delete process.env.AXIOM_OUT_ROOT;

        const manifest = createTestManifest();

        // Apply with ABSOLUTE repoPath on same drive
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: fixturePath
        });

        // CRITICAL ASSERTIONS
        expect(result.success).toBe(true);
        expect(result.filesWritten.length).toBe(1);
        expect(result.filesWritten[0]).toBe("manifest/README.md");
        expect(result.filesWrittenAbs).toBeDefined();
        expect(result.filesWrittenAbs!.length).toBe(1);
        expect(result.outRootAbs).toBeDefined();

        // CRITICAL: Physical file verification
        const expectedFilePath = path.join(fixturePath, "out", "manifest", "README.md");
        const reportedAbsPath = result.filesWrittenAbs![0];

        console.log(`Expected file path: ${expectedFilePath}`);
        console.log(`Reported abs path: ${reportedAbsPath}`);

        // Verify reported path matches expected path (case-insensitive on Windows)
        const normalizedExpected = path.normalize(expectedFilePath).toLowerCase();
        const normalizedReported = path.normalize(reportedAbsPath).toLowerCase();
        expect(normalizedReported).toBe(normalizedExpected);

        // CRITICAL: Physical verification - file MUST exist
        const verification = verifyPhysicalFile(expectedFilePath, TEST_BYTES, TEST_SHA256);

        if (!verification.exists) {
            throw new Error(
                `CRITICAL FAILURE: apply() reported success but file does not exist!\n` +
                `Expected: ${expectedFilePath}\n` +
                `Reported: ${reportedAbsPath}\n` +
                `Result: ${JSON.stringify(result, null, 2)}`
            );
        }

        expect(verification.exists).toBe(true);
        expect(verification.size).toBe(TEST_BYTES);
        expect(verification.sha256).toBe(TEST_SHA256);
        expect(verification.match).toBe(true);

        console.log(`✓ Physical verification PASSED: ${expectedFilePath}`);
        console.log(`  Size: ${verification.size} bytes (expected: ${TEST_BYTES})`);
        console.log(`  SHA256: ${verification.sha256}`);
    });

    it("T3: Cross-drive write with AXIOM_OUT_ROOT (Windows only, skip if unavailable)", async () => {
        // Skip on non-Windows platforms
        if (process.platform !== "win32") {
            console.log("Skipping cross-drive test on non-Windows platform");
            return;
        }

        // Detect available drives
        const drives = ["D:", "E:", "F:", "G:", "H:"];
        const currentDrive = path.parse(process.cwd()).root[0].toUpperCase();
        const availableDrive = drives.find(d => {
            try {
                const drivePath = `${d}\\`;
                return fs.existsSync(drivePath) && d[0].toUpperCase() !== currentDrive;
            } catch {
                return false;
            }
        });

        if (!availableDrive) {
            console.log("No secondary drive available for cross-drive test, skipping");
            return;
        }

        console.log(`Cross-drive test: current=${currentDrive}:, target=${availableDrive}`);

        // Create fixture repository on current drive
        const fixturePath = path.join(tmpBase, "test3-cross-drive-repo");
        fs.mkdirSync(fixturePath, { recursive: true });
        createGitFixture(fixturePath);
        cleanupPaths.push(tmpBase);

        // Set AXIOM_OUT_ROOT to different drive
        const crossDriveOut = `${availableDrive}\\AXIOM_TEST_CROSS_DRIVE_T3`;
        process.env.AXIOM_OUT_ROOT = crossDriveOut;
        cleanupPaths.push(crossDriveOut);

        const manifest = createTestManifest();

        // Apply with cross-drive AXIOM_OUT_ROOT
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: fixturePath
        });

        // Assertions
        expect(result.success).toBe(true);
        expect(result.filesWritten.length).toBe(1);
        expect(result.filesWrittenAbs).toBeDefined();
        expect(result.filesWrittenAbs![0]).toContain(availableDrive);
        expect(result.outRootAbs).toBe(crossDriveOut);

        // Physical verification on target drive
        const expectedFilePath = path.join(crossDriveOut, "manifest", "README.md");
        const verification = verifyPhysicalFile(expectedFilePath, TEST_BYTES, TEST_SHA256);

        expect(verification.exists).toBe(true);
        expect(verification.size).toBe(TEST_BYTES);
        expect(verification.sha256).toBe(TEST_SHA256);
        expect(verification.match).toBe(true);

        console.log(`✓ Cross-drive verification PASSED: ${expectedFilePath}`);

        // Cleanup env
        delete process.env.AXIOM_OUT_ROOT;
    });

    it("T4: AXIOM_OUT_ROOT absolute path overrides default out location", async () => {
        // Create fixture repository
        const fixturePath = path.join(tmpBase, "test4-outroot-override");
        fs.mkdirSync(fixturePath, { recursive: true });
        createGitFixture(fixturePath);
        cleanupPaths.push(tmpBase);

        // Set AXIOM_OUT_ROOT to custom absolute location
        const customOutRoot = path.join(tmpBase, "custom-output-location");
        process.env.AXIOM_OUT_ROOT = customOutRoot;
        cleanupPaths.push(customOutRoot);

        const manifest = createTestManifest();

        // Apply with custom AXIOM_OUT_ROOT
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: fixturePath
        });

        // Assertions
        expect(result.success).toBe(true);
        expect(result.filesWritten.length).toBe(1);
        expect(result.filesWrittenAbs).toBeDefined();
        expect(result.outRootAbs).toBe(customOutRoot);

        // Physical verification at custom location
        const expectedFilePath = path.join(customOutRoot, "manifest", "README.md");
        const reportedAbsPath = result.filesWrittenAbs![0];

        // Normalize paths for comparison (case-insensitive on Windows)
        const normalizedExpected = path.normalize(expectedFilePath).toLowerCase();
        const normalizedReported = path.normalize(reportedAbsPath).toLowerCase();
        expect(normalizedReported).toBe(normalizedExpected);

        const verification = verifyPhysicalFile(expectedFilePath, TEST_BYTES, TEST_SHA256);

        expect(verification.exists).toBe(true);
        expect(verification.size).toBe(TEST_BYTES);
        expect(verification.sha256).toBe(TEST_SHA256);
        expect(verification.match).toBe(true);

        console.log(`✓ AXIOM_OUT_ROOT override verification PASSED: ${expectedFilePath}`);

        // Cleanup env
        delete process.env.AXIOM_OUT_ROOT;
    });
});
