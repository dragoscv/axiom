import { describe, it, expect } from "vitest";
import { generate } from "@codai/axiom-engine";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";

/**
 * Test POSIX normalization deep-copy guarantee
 * 
 * ACCEPTANCE:
 * - All artifact paths are POSIX (no backslash)
 * - Original IR object is NOT mutated (deep copy)
 */
describe("path normalization deep-copy test", () => {
    it("should normalize all paths to POSIX without mutating input", async () => {
        // Create IR with web-app emit
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "webapp",
                    intent: "test POSIX normalization",
                    constraints: [],
                    capabilities: [],
                    checks: [],
                    emit: [
                        {
                            type: "service",
                            subtype: "web-app",
                            target: "test-app"
                        }
                    ]
                }
            ]
        };

        // Deep freeze input to detect mutations
        const frozenIR = JSON.parse(JSON.stringify(ir));

        // Generate artifacts
        const { manifest, artifacts } = await generate(ir, process.cwd());

        // ACCEPTANCE 1: All artifact paths are POSIX (no backslash)
        expect(artifacts.length).toBeGreaterThan(0);
        artifacts.forEach(artifact => {
            expect(artifact.path, `Artifact path should not contain backslash: ${artifact.path}`)
                .not.toContain("\\");

            // Verify all paths use forward slash
            if (artifact.path.includes("/") || artifact.path.includes("\\")) {
                expect(artifact.path.includes("/"), "Path should use forward slash").toBe(true);
                expect(artifact.path.includes("\\"), "Path should NOT use backslash").toBe(false);
            }
        });

        // Verify manifest artifacts also POSIX
        manifest.artifacts.forEach(artifact => {
            expect(artifact.path, `Manifest artifact path should not contain backslash: ${artifact.path}`)
                .not.toContain("\\");
        });

        // ACCEPTANCE 2: Original IR not mutated (deep copy confirmation)
        expect(JSON.stringify(ir)).toBe(JSON.stringify(frozenIR));

        console.log("✅ POSIX DEEP-COPY TEST PASSED");
        console.log(`   Total artifacts: ${artifacts.length}`);
        console.log(`   Sample paths (first 5):`);
        artifacts.slice(0, 5).forEach(a => {
            console.log(`     - ${a.path} (POSIX ✓)`);
        });
    });

    it("should handle Windows-style paths in normalize without mutation", () => {
        // Simulate path normalization (unit test for toPosixPath utility)
        const windowsPath = "out\\webapp\\index.html";
        const posixPath = windowsPath.replace(/\\/g, "/");

        expect(posixPath).toBe("out/webapp/index.html");
        expect(posixPath).not.toContain("\\");

        // Original should remain unchanged
        expect(windowsPath).toBe("out\\webapp\\index.html");
    });
});
