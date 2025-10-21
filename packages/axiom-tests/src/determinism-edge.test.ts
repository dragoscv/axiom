/**
 * Test: Determinism complet - două rulări consecutive pe același IR/profile
 * trebuie să producă manifest identic (incluzând buildId, createdAt)
 */

import { describe, it, expect } from "vitest";
import { generate } from "@codai/axiom-engine/dist/generate.js";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";
import { sha256 } from "@codai/axiom-engine/dist/util.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Determinism - Edge Profile", () => {
  it("should produce identical manifest SHA for two consecutive runs (edge)", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "determinism-agent",
          intent: "Test deterministic generation",
          constraints: [],
          capabilities: [],
          checks: [
            {
              kind: "sla",
              name: "cold_start",
              expect: "cold_start_ms <= 50"
            }
          ],
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

    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-det-1-"));
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-det-2-"));

    try {
      // Rundă 1
      const { manifest: manifest1 } = await generate(ir, tmpDir1, "edge");

      // Rundă 2 (același IR, același profil)
      const { manifest: manifest2 } = await generate(ir, tmpDir2, "edge");

      // ASSERT: buildId identic
      expect(manifest1.buildId).toBe(manifest2.buildId);

      // ASSERT: createdAt identic (determinist)
      expect(manifest1.createdAt).toBe(manifest2.createdAt);

      // ASSERT: irHash identic
      expect(manifest1.irHash).toBe(manifest2.irHash);

      // ASSERT: profile identic
      expect(manifest1.profile).toBe("edge");
      expect(manifest2.profile).toBe("edge");

      // ASSERT: Număr identic de artifacts
      expect(manifest1.artifacts.length).toBe(manifest2.artifacts.length);

      // ASSERT: SHA256 al manifestului complet e identic
      const manifestJson1 = JSON.stringify(manifest1, null, 2);
      const manifestJson2 = JSON.stringify(manifest2, null, 2);
      const hash1 = sha256(manifestJson1);
      const hash2 = sha256(manifestJson2);

      expect(hash1).toBe(hash2);

      console.log("[determinism-edge.test] ✓ Two runs produced identical manifest");
      console.log("Manifest SHA256:", hash1);
      console.log("buildId:", manifest1.buildId);
      console.log("createdAt:", manifest1.createdAt);
    } finally {
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it("should have different manifest SHA for different profiles", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "profile-test-agent",
          intent: "Test profile differentiation",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "app"
            }
          ]
        }
      ]
    };

    const tmpDirEdge = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-edge-"));
    const tmpDirBudget = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-budget-"));

    try {
      // Generate cu profil EDGE
      const { manifest: manifestEdge } = await generate(ir, tmpDirEdge, "edge");

      // Generate cu profil BUDGET
      const { manifest: manifestBudget } = await generate(ir, tmpDirBudget, "budget");

      // ASSERT: buildId diferit (depinde de profil)
      expect(manifestEdge.buildId).not.toBe(manifestBudget.buildId);

      // ASSERT: createdAt diferit (bazat pe buildId)
      expect(manifestEdge.createdAt).not.toBe(manifestBudget.createdAt);

      // ASSERT: profile diferit
      expect(manifestEdge.profile).toBe("edge");
      expect(manifestBudget.profile).toBe("budget");

      console.log("[determinism-edge.test] ✓ Different profiles produce different manifests");
      console.log("Edge buildId:", manifestEdge.buildId);
      console.log("Budget buildId:", manifestBudget.buildId);
    } finally {
      fs.rmSync(tmpDirEdge, { recursive: true, force: true });
      fs.rmSync(tmpDirBudget, { recursive: true, force: true });
    }
  });

  it("should produce consistent artifact hashes across runs", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "artifact-hash-agent",
          intent: "Test artifact hash consistency",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "consistent-app"
            }
          ]
        }
      ]
    };

    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-art-1-"));
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-art-2-"));

    try {
      const { manifest: m1 } = await generate(ir, tmpDir1, "edge");
      const { manifest: m2 } = await generate(ir, tmpDir2, "edge");

      // ASSERT: Artifacts au aceleași hash-uri în aceeași ordine
      expect(m1.artifacts.length).toBe(m2.artifacts.length);

      for (let i = 0; i < m1.artifacts.length; i++) {
        const art1 = m1.artifacts[i];
        const art2 = m2.artifacts[i];

        expect(art1.path).toBe(art2.path);
        expect(art1.sha256).toBe(art2.sha256);
        expect(art1.bytes).toBe(art2.bytes);
      }

      console.log("[determinism-edge.test] ✓ Artifact hashes consistent across runs");
    } finally {
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
