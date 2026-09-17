import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { apply, generate } from "@codai/axiom-engine";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";

/**
 * SMOKE TEST: Verifică că apply.ts scrie REAL pe disc (fix phantom write bug)
 * 
 * ACCEPTANCE CRITERIA:
 * - `filesWritten` conține paths POSIX (fără backslash)
 * - Directorul `./out/` există pe disc
 * - Fișierele generate există și au content valid (SHA256 match)
 */
describe("apply phantom smoke test", () => {
    const testRepoPath = process.cwd();
    const outDir = join(testRepoPath, "out");

    beforeEach(() => {
        // Curăță out/ înainte de fiecare test
        if (existsSync(outDir)) {
            rmSync(outDir, { recursive: true, force: true });
        }
    });

    afterEach(() => {
        // Curăță out/ după fiecare test
        if (existsSync(outDir)) {
            rmSync(outDir, { recursive: true, force: true });
        }
    });

    it("should write real files to disk with valid content", async () => {
        // Step 1: IR minimal - un agent cu emit web-app
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "webapp",
                    intent: "smoke test webapp generation",
                    constraints: [],
                    capabilities: [],
                    checks: [],
                    emit: [
                        {
                            type: "service",
                            subtype: "web-app",
                            target: "smoke-app"
                        }
                    ]
                }
            ]
        };

        // Step 2: Generate manifest (creates .axiom/cache/ with SHA256 content)
        const { manifest, artifacts } = await generate(ir, testRepoPath);
        expect(manifest).toBeDefined();
        expect(artifacts.length).toBeGreaterThan(0);

        // Step 3: Apply manifest in fs mode
        const applyResult = await apply({
            manifest,
            mode: "fs",
            repoPath: testRepoPath
        });

        // ACCEPTANCE 1: success + filesWritten are POSIX paths (no backslash)
        expect(applyResult.success).toBe(true);
        expect(applyResult.filesWritten.length).toBeGreaterThan(0);
        applyResult.filesWritten.forEach(filePath => {
            expect(filePath).not.toContain("\\"); // Strict POSIX
        });

        // ACCEPTANCE 2: Directorul out/ există
        expect(existsSync(outDir)).toBe(true);

        // ACCEPTANCE 3: Fiecare artifact există pe disc cu content valid
        for (const artifact of artifacts) {
            if (artifact.path === "manifest.json") continue; // skip meta

            // Construiește path pe disc (artifact.path e deja POSIX)
            const diskPath = join(outDir, artifact.path.replace("out/", ""));
            expect(existsSync(diskPath), `File ${diskPath} should exist`).toBe(true);

            // Verifică că content match SHA256 din manifest
            const fileContent = readFileSync(diskPath);
            const expectedArtifact = manifest.artifacts.find(a => a.path === artifact.path);
            expect(expectedArtifact).toBeDefined();
            
            // SHA256 verification (deja făcut în apply.ts, dar validăm aici din nou)
            const crypto = await import("node:crypto");
            const actualSha256 = crypto.createHash("sha256").update(fileContent).digest("hex");
            expect(actualSha256).toBe(expectedArtifact?.sha256);
        }
    });

    it("should fail gracefully if artifact content missing from cache", async () => {
        // Creează manifest manual FĂRĂ să ruleze generate() (cache gol)
        const fakeManifest = {
            version: "1.0.0",
            name: "fake-test",
            buildId: "test-123",
            timestamp: new Date().toISOString(),
            artifacts: [
                {
                    path: "fake/file.txt",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                    bytes: 10
                }
            ]
        };

        // Apply ar trebui să eșueze cu ERR_ARTIFACT_CONTENT_MISSING
        const applyResult = await apply({
            manifest: fakeManifest as any,
            mode: "fs",
            repoPath: testRepoPath
        });

        expect(applyResult.success).toBe(false);
        expect(applyResult.error).toContain("ERR_ARTIFACT_CONTENT_MISSING");
        expect(applyResult.error).toContain("0000000000000000000000000000000000000000000000000000000000000000");
    });
});
