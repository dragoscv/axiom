/**
 * Test: Toate căile din manifest/artifacts TREBUIE să fie POSIX (doar /)
 * indiferent de OS-ul unde rulează generatorul
 */

import { describe, it, expect } from "vitest";
import { generate } from "@codai/axiom-engine/dist/generate.js";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Path Normalization - POSIX only", () => {
  it("should produce only forward slashes in artifact paths", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "test-agent",
          intent: "Test path normalization",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "my-webapp"
            }
          ]
        }
      ]
    };

    // Creează temp dir pentru teste
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-path-test-"));

    try {
      const { manifest } = await generate(ir, tmpDir, "edge");

      // DEBUG: Print first 5 artifact paths pentru diagnostic
      console.log("\n=== ARTIFACT PATHS DEBUG ===");
      manifest.artifacts.slice(0, 5).forEach((a, i) => {
        console.log(`${i + 1}. "${a.path}" - has backslash: ${a.path.includes('\\')}`);
      });
      console.log("===========================\n");

      // ASSERT: NICIO bară inversă în artifact paths
      for (const artifact of manifest.artifacts) {
        expect(artifact.path).not.toContain("\\");
        expect(artifact.path).toMatch(/^[a-zA-Z0-9\-_/.\[\]]+$/); // Include [] pentru dynamic routes

        // Path-urile trebuie să fie relative (nu absolute)
        expect(path.isAbsolute(artifact.path)).toBe(false);
      }

      // ASSERT: Primele 5 artifacts au doar "/"
      const first5 = manifest.artifacts.slice(0, 5);
      for (const artifact of first5) {
        const hasOnlyForwardSlash = !artifact.path.includes("\\");
        expect(hasOnlyForwardSlash).toBe(true);
      }

      console.log("[path-normalization.test] ✓ All paths are POSIX format");
      console.log("Sample paths:", first5.map(a => a.path));
    } finally {
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should write files correctly on disk despite POSIX paths in manifest", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "disk-test-agent",
          intent: "Verify disk writes work with POSIX paths",
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-disk-test-"));

    try {
      const { manifest } = await generate(ir, tmpDir);

      // Verifică că fișierele există fizic pe disc
      for (const artifact of manifest.artifacts) {
        // artifact.path e POSIX, convertim la OS path pentru verificare
        const posixPath = artifact.path;
        const osPath = path.join(tmpDir, ...posixPath.split('/'));

        const exists = fs.existsSync(osPath);
        expect(exists).toBe(true);
      }

      console.log("[path-normalization.test] ✓ Files written correctly despite POSIX manifest paths");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
