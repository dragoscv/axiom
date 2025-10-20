/**
 * Test: /apply trebuie să scrie în repo-ul curent când repoPath lipsește
 * și să creeze automat ./out
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generate } from "@codai/axiom-engine/dist/generate.js";
import { apply } from "@codai/axiom-engine/dist/apply.js";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Apply RepoRoot Default - process.cwd()", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    // Salvează cwd original
    originalCwd = process.cwd();

    // Creează temp dir și schimbă cwd
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-apply-cwd-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    // Restaurează cwd
    process.chdir(originalCwd);

    // Cleanup
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should use process.cwd() as default repoPath", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "cwd-test-agent",
          intent: "Test apply default cwd",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "test-webapp"
            }
          ]
        }
      ]
    };

    // Generate în tmpDir (care e acum cwd)
    const { manifest } = await generate(ir, tmpDir, "edge");

    // Apply FĂRĂ repoPath (trebuie să folosească process.cwd())
    const result = await apply({
      manifest,
      mode: "fs"
      // NU specificăm repoPath
    });

    // ASSERT: Success
    expect(result.success).toBe(true);

    // ASSERT: Fișiere scrise relative la process.cwd()
    expect(result.filesWritten.length).toBeGreaterThan(0);

    // ASSERT: Toate path-urile sunt relative (nu absolute)
    for (const file of result.filesWritten) {
      expect(path.isAbsolute(file)).toBe(false);
    }

    console.log("[apply-reporoot.test] ✓ Apply used process.cwd() as default");
    console.log("Files written:", result.filesWritten.slice(0, 3));
  });

  it("should create ./out directory if missing", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "out-creation-agent",
          intent: "Test out/ creation",
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

    // ASSERT: out/ nu există inițial
    const outPath = path.join(tmpDir, "out");
    if (fs.existsSync(outPath)) {
      fs.rmSync(outPath, { recursive: true });
    }
    expect(fs.existsSync(outPath)).toBe(false);

    // Generate
    const { manifest } = await generate(ir, tmpDir);

    // Apply (va crea out/)
    const result = await apply({
      manifest,
      mode: "fs"
    });

    // ASSERT: out/ a fost creat
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).isDirectory()).toBe(true);

    // ASSERT: Fișierele sunt sub out/
    expect(result.success).toBe(true);
    const firstFile = result.filesWritten[0];
    if (firstFile) {
      expect(firstFile).toMatch(/^out\//);
    }

    console.log("[apply-reporoot.test] ✓ ./out directory created automatically");
  });

  it("should report filesWritten as relative paths under out/", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "relative-path-agent",
          intent: "Test relative path reporting",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "my-service"
            }
          ]
        }
      ]
    };

    const { manifest } = await generate(ir, tmpDir);

    const result = await apply({
      manifest,
      mode: "fs"
    });

    // ASSERT: Success
    expect(result.success).toBe(true);

    // ASSERT: Toate filesWritten sunt relative la repo și sub out/**
    for (const file of result.filesWritten) {
      // Path relative (nu absolute)
      expect(path.isAbsolute(file)).toBe(false);

      // Sub out/ (sau manifest.json la root)
      const isUnderOut = file.startsWith("out/") || file === "out/manifest.json" || file === "manifest.json";
      expect(isUnderOut).toBe(true);
    }

    console.log("[apply-reporoot.test] ✓ filesWritten reported as relative paths");
    console.log("Sample paths:", result.filesWritten.slice(0, 5));
  });
});
