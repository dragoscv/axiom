import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { apply } from "@codai/axiom-engine";
import type { Manifest } from "@codai/axiom-engine/dist/manifest.js";

/**
 * SMOKE TEST: Repro "phantom write" bug
 * 
 * ACCEPTANCE:
 * - filesWritten === ["out/smoke/README.md"] (POSIX, prefix out/)
 * - Directory out/ exists in tmpRepo
 * - File out/smoke/README.md exists and contains exactly "AXIOM_SMOKE_OK\n"
 * 
 * EXPECTED: Currently FAILS (phantom write bug - files not actually written)
 */
describe("apply physical smoke test (repro phantom write)", () => {
    const tmpRepo = join(process.cwd(), "tmp-smoke-test");
    const outDir = join(tmpRepo, "out");
    const smokeFile = join(outDir, "smoke", "README.md");

    beforeEach(() => {
        // Clean up before each test
        if (existsSync(tmpRepo)) {
            rmSync(tmpRepo, { recursive: true, force: true });
        }
        mkdirSync(tmpRepo, { recursive: true });
    });

    afterEach(() => {
        // Clean up after each test
        if (existsSync(tmpRepo)) {
            rmSync(tmpRepo, { recursive: true, force: true });
        }
    });

    it("should write real files to disk with exact content", async () => {
        // Step 1: Create minimal manifest with embedded content
        const exactContent = "AXIOM_SMOKE_OK\n";
        const contentBuffer = Buffer.from(exactContent, "utf-8");

        // Calculate SHA256 for the content
        const crypto = await import("node:crypto");
        const sha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");

        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "smoke-123",
            irHash: "smoke-ir-hash",
            createdAt: new Date().toISOString(),
            evidence: [],
            artifacts: [
                {
                    path: "smoke/README.md",
                    kind: "file",
                    sha256: sha256,
                    bytes: contentBuffer.length,
                    // Embedded content fallback (no store needed for this test)
                    contentUtf8: exactContent
                } as any
            ]
        };

        // Step 2: Apply manifest in fs mode
        const applyResult = await apply({
            manifest,
            mode: "fs",
            repoPath: tmpRepo
        });

        // ACCEPTANCE 1: filesWritten contains exact POSIX path with out/ prefix
        expect(applyResult.success, "Apply should succeed").toBe(true);
        expect(applyResult.filesWritten, "filesWritten should contain smoke/README.md").toEqual(["out/smoke/README.md"]);

        // ACCEPTANCE 2: Directory out/ exists physically
        expect(existsSync(outDir), "Directory out/ should exist").toBe(true);
        const outStat = statSync(outDir);
        expect(outStat.isDirectory(), "out/ should be a directory").toBe(true);

        // ACCEPTANCE 3: File exists and contains exact content
        expect(existsSync(smokeFile), `File ${smokeFile} should exist physically`).toBe(true);
        const actualContent = readFileSync(smokeFile, "utf-8");
        expect(actualContent, "Content should match exactly").toBe(exactContent);

        console.log("✅ SMOKE TEST PASSED: Physical file written with correct content");
        console.log(`   File: ${smokeFile}`);
        console.log(`   Content: ${JSON.stringify(actualContent)}`);
        console.log(`   SHA256: ${sha256}`);
    });

    it("should fail gracefully if content missing from both manifest and store", async () => {
        // Manifest without contentUtf8/contentBase64 and no artifact store
        const manifest: Manifest = {
            version: "1.0.0",
            buildId: "missing-123",
            irHash: "missing-ir-hash",
            createdAt: new Date().toISOString(),
            evidence: [],
            artifacts: [
                {
                    path: "missing/file.txt",
                    kind: "file",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                    bytes: 10
                }
            ]
        };

        const applyResult = await apply({
            manifest,
            mode: "fs",
            repoPath: tmpRepo
        });

        // Should fail with clear error
        expect(applyResult.success).toBe(false);
        expect(applyResult.error).toContain("ERR_ARTIFACT_CONTENT_MISSING");
        expect(applyResult.error).toContain("missing/file.txt");
    });
});
