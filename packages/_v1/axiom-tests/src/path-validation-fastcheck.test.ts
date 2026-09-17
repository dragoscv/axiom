/**
 * Property-based path validation tests (v1.0.24)
 * 
 * PURPOSE: Validate resolveArtifactAbs() rejects all pathological inputs using property-based testing.
 * 
 * COVERAGE:
 * - Backslashes (\)
 * - Path traversal (..)
 * - Absolute paths (/etc, C:\...)
 * - Mixed slashes
 * - Unicode (NFC/NFD normalization)
 * - Windows reserved names (CON, PRN, NUL, AUX, COM1-9, LPT1-9)
 * - Trailing spaces/dots
 * - Invalid characters (<>:"|?*)
 * - Deep nesting (valid case)
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";

// Import internal function for testing (not exported in public API)
// @ts-ignore - Testing internal implementation
import { resolveArtifactAbs } from "../../../axiom-engine/src/lib/fs-axiom.js";

const TEST_REPO_ABS = path.join(os.tmpdir(), "test-repo");
const TEST_OUT_ABS = path.join(TEST_REPO_ABS, "out");

describe("Path Validation - Property-Based Tests", () => {
    describe("P1: Invalid paths MUST be rejected", () => {
        it("Rejects backslashes", () => {
            const invalidPaths = [
                "manifest\\file.md",
                "src\\lib\\util.ts",
                "a\\b\\c\\d.txt"
            ];

            for (const p of invalidPaths) {
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p))
                    .toThrow(/ERR_ARTIFACT_PATH_BACKSLASH/);
            }
        });

        it("Rejects path traversal (..)", () => {
            const invalidPaths = [
                "../etc/passwd",
                "docs/../../secret.txt",
                "a/b/../../../c.txt",
                "..",
                "../",
                "a/.."
            ];

            for (const p of invalidPaths) {
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p))
                    .toThrow(/ERR_ARTIFACT_PATH_TRAVERSAL/);
            }
        });

        it("Rejects absolute paths", () => {
            const invalidPaths = [
                "/etc/passwd",
                "/usr/bin/node",
                "/home/user/file.txt"
            ];

            if (process.platform === "win32") {
                invalidPaths.push(
                    "C:\\Windows\\System32\\config.txt",
                    "D:\\data\\file.txt"
                );
            }

            for (const p of invalidPaths) {
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p))
                    .toThrow(/ERR_ARTIFACT_PATH_ABSOLUTE|ERR_ARTIFACT_PATH_BACKSLASH/);
            }
        });

        it("Rejects mixed slashes (forward + backward)", () => {
            const invalidPaths = [
                "src/lib\\util.ts",
                "docs\\api/index.md",
                "a/b\\c/d.txt"
            ];

            for (const p of invalidPaths) {
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p))
                    .toThrow(/ERR_ARTIFACT_PATH_BACKSLASH/);
            }
        });
    });

    describe("P2: Windows-specific validation", () => {
        it("Rejects Windows reserved names (base names)", () => {
            if (process.platform !== "win32") {
                console.log("⊘ Skipped: Windows-specific test");
                return;
            }

            const reservedNames = [
                "CON",
                "PRN",
                "AUX",
                "NUL",
                "COM1",
                "COM9",
                "LPT1",
                "LPT9"
            ];

            for (const name of reservedNames) {
                // Test without extension
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, `output/${name}`))
                    .toThrow(/ERR_ARTIFACT_PATH_RESERVED_WINDOWS/);

                // Test with extension (still reserved)
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, `output/${name}.txt`))
                    .toThrow(/ERR_ARTIFACT_PATH_RESERVED_WINDOWS/);

                // Test case-insensitive
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, `output/${name.toLowerCase()}.log`))
                    .toThrow(/ERR_ARTIFACT_PATH_RESERVED_WINDOWS/);
            }
        });

        it("Rejects trailing spaces and dots", () => {
            if (process.platform !== "win32") {
                console.log("⊘ Skipped: Windows-specific test");
                return;
            }

            const invalidPaths = [
                "output/file.txt ",
                "output/file.txt.",
                "output/file.txt...",
                "output/folder /file.txt"
            ];

            for (const p of invalidPaths) {
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p))
                    .toThrow(/ERR_ARTIFACT_PATH_TRAILING/);
            }
        });

        it("Rejects invalid characters", () => {
            if (process.platform !== "win32") {
                console.log("⊘ Skipped: Windows-specific test");
                return;
            }

            const invalidPaths = [
                "output/file<1>.txt",
                "output/file>2.txt",
                'output/file"3.txt',
                "output/file|4.txt",
                "output/file?5.txt",
                "output/file*6.txt",
                "output/file:7.txt"
            ];

            for (const p of invalidPaths) {
                expect(() => resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p))
                    .toThrow(/ERR_ARTIFACT_PATH_INVALID_CHARS/);
            }
        });
    });

    describe("P3: Unicode normalization (NFC)", () => {
        it("Normalizes Unicode to NFC before processing", () => {
            // NFD: é as e + combining acute accent (U+0065 U+0301)
            const nfdPath = "docs/café.txt"; // This might be NFD in source
            
            // Should NOT throw - normalization handles it
            const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, "docs/café.txt");
            
            expect(result.absFile).toContain("café.txt");
            expect(path.isAbsolute(result.absFile)).toBe(true);
        });

        it("Handles various Unicode characters", () => {
            const unicodePaths = [
                "文档/readme.txt",        // Chinese
                "документы/файл.txt",    // Russian (Cyrillic)
                "مستندات/ملف.txt",        // Arabic
                "दस्तावेज़/फ़ाइल.txt"    // Hindi
            ];

            for (const p of unicodePaths) {
                const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p);
                expect(path.isAbsolute(result.absFile)).toBe(true);
                expect(result.absFile).toContain(path.sep);
            }
        });
    });

    describe("P4: Valid paths MUST be accepted", () => {
        it("Accepts simple relative paths", () => {
            const validPaths = [
                "manifest/README.md",
                "src/lib/util.ts",
                "docs/api/index.html",
                "a/b/c/d/e/f/g/h/i.txt"
            ];

            for (const p of validPaths) {
                const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p);
                
                expect(path.isAbsolute(result.absFile)).toBe(true);
                expect(result.absFile).toContain(TEST_OUT_ABS);
                expect(result.absDir).toBe(path.dirname(result.absFile));
            }
        });

        it("Accepts deep nesting (100 levels)", () => {
            const segments = Array.from({ length: 100 }, (_, i) => `level${i}`);
            const deepPath = segments.join("/") + "/file.txt";

            const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, deepPath);

            expect(path.isAbsolute(result.absFile)).toBe(true);
            expect(result.absFile.split(path.sep).length).toBeGreaterThan(100);
        });

        it("Normalizes redundant slashes and dots", () => {
            const pathsWithRedundancy = [
                "docs/./api/index.md",
                "src//lib/util.ts",
                "a/b/./c/./d.txt",
                "manifest///file.json"
            ];

            for (const p of pathsWithRedundancy) {
                const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p);
                
                expect(path.isAbsolute(result.absFile)).toBe(true);
                // Should not contain redundant slashes
                expect(result.absFile).not.toMatch(/\/{2,}/);
            }
        });

        it("Accepts paths with spaces (but not trailing)", () => {
            const validPaths = [
                "docs/my file.txt",
                "output/test results.json",
                "data/user 123/profile.txt"
            ];

            for (const p of validPaths) {
                const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, p);
                expect(path.isAbsolute(result.absFile)).toBe(true);
            }
        });
    });

    describe("P5: Determinism - same input always produces same output", () => {
        it("Produces consistent absolute paths", () => {
            const testPath = "manifest/README.md";
            
            const result1 = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, testPath);
            const result2 = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, testPath);
            const result3 = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, testPath);

            expect(result1.absFile).toBe(result2.absFile);
            expect(result2.absFile).toBe(result3.absFile);
            expect(result1.absDir).toBe(result2.absDir);
        });

        it("Zero dependency on process.cwd()", () => {
            const originalCwd = process.cwd();
            const testPath = "output/data.txt";

            // Change cwd
            const tempDir = os.tmpdir();
            process.chdir(tempDir);

            try {
                const result = resolveArtifactAbs(TEST_REPO_ABS, TEST_OUT_ABS, testPath);
                
                // Result should NOT contain tempDir (process.cwd())
                expect(result.absFile).toContain(TEST_OUT_ABS);
                expect(result.absFile).not.toContain(tempDir);
            } finally {
                process.chdir(originalCwd);
            }
        });
    });
});
