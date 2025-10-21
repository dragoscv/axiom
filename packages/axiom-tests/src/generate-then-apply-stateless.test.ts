import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "@codai/axiom-engine/dist/generate.js";
import { apply } from "@codai/axiom-engine";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";

/**
 * CRITICAL TEST: Stateless Pipeline
 * 
 * Simulates MCP tool invocations where artifact store is lost between calls.
 * 
 * SCENARIO:
 * 1. generate(ir, profile:"edge") → manifest with inline content
 * 2. Simulate "new process" - store is lost (MCP stateless behavior)
 * 3. apply(manifest, repoPath) → should succeed using ONLY inline content
 * 
 * ACCEPTANCE:
 * - generate() includes contentUtf8/contentBase64 for small files
 * - apply() succeeds without artifact store
 * - Physical files written correctly
 * - SHA256 validation passes
 */
describe("generate() → apply() stateless pipeline", () => {
  let tmpRepoAbs: string;

  beforeEach(async () => {
    tmpRepoAbs = await mkdtemp(join(tmpdir(), "axiom-stateless-"));
  });

  afterEach(async () => {
    await rm(tmpRepoAbs, { recursive: true, force: true });
  });

  it("should apply manifest from generate() without artifact store (stateless)", async () => {
    // Step 1: Create minimal IR for edge profile
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "test-agent",
          intent: "Stateless pipeline test",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "stateless-test"
            }
          ]
        }
      ]
    };

    // Step 2: Generate manifest with edge profile (should include inline content)
    const { manifest } = await generate(ir, tmpRepoAbs, "edge");

    // Step 3: Verify inline content is present in manifest
    // Edge profile should generate some artifacts (e.g., web app files)
    expect(manifest.artifacts.length).toBeGreaterThan(0);

    // Check that at least one artifact has inline content
    const hasInlineContent = manifest.artifacts.some(
      artifact => artifact.contentUtf8 !== undefined || artifact.contentBase64 !== undefined
    );
    expect(hasInlineContent).toBe(true);

    // Step 4: Simulate "new process" - create new tmp directory for stateless apply
    const statelessRepoAbs = await mkdtemp(join(tmpdir(), "axiom-stateless-apply-"));

    try {
      // Step 5: Apply manifest WITHOUT artifact store (stateless scenario)
      // This simulates MCP tool invocation where store is lost between calls
      const applyResult = await apply({
        manifest,
        mode: "fs",
        repoPath: statelessRepoAbs
      });

      // ACCEPTANCE: Apply succeeds using only inline content
      expect(applyResult.success).toBe(true);
      expect(applyResult.filesWritten.length).toBeGreaterThan(0);

      // ACCEPTANCE: Files are physically written
      for (const filePath of applyResult.filesWritten) {
        // Remove "out/" prefix to get actual path
        const relPath = filePath.replace(/^out\//, "");
        const fullPath = join(statelessRepoAbs, "out", relPath);
        
        // File must exist
        const content = await readFile(fullPath);
        expect(content.byteLength).toBeGreaterThan(0);

        // Find corresponding artifact
        const artifact = manifest.artifacts.find(a => a.path === relPath);
        expect(artifact).toBeDefined();

        // Verify size matches
        expect(content.byteLength).toBe(artifact!.bytes);
      }
    } finally {
      await rm(statelessRepoAbs, { recursive: true, force: true });
    }
  });

  it("should handle text files via contentUtf8 in stateless pipeline", async () => {
    // Create IR with a simple text file
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "text-test-agent",
          intent: "Test text file inline content",
          constraints: [],
          capabilities: [],
          checks: [],
          emit: [
            {
              type: "service",
              subtype: "web-app",
              target: "text-test"
            }
          ]
        }
      ]
    };

    // Generate manifest
    const { manifest } = await generate(ir, tmpRepoAbs, "edge");

    // Verify at least one artifact has contentUtf8
    const textArtifact = manifest.artifacts.find(a => a.contentUtf8 !== undefined);
    expect(textArtifact).toBeDefined();
    expect(textArtifact!.contentUtf8).toBeDefined();

    // Apply in new directory without store
    const statelessRepoAbs = await mkdtemp(join(tmpdir(), "axiom-stateless-text-"));

    try {
      const applyResult = await apply({
        manifest,
        mode: "fs",
        repoPath: statelessRepoAbs
      });

      expect(applyResult.success).toBe(true);

      // Verify physical file content
      const writtenFile = applyResult.filesWritten.find(f => 
        manifest.artifacts.some(a => a.contentUtf8 && f.includes(a.path))
      );
      expect(writtenFile).toBeDefined();

      const artifactForFile = manifest.artifacts.find(a => 
        writtenFile!.includes(a.path) && a.contentUtf8
      );
      expect(artifactForFile).toBeDefined();

      const relPath = writtenFile!.replace(/^out\//, "");
      const fullPath = join(statelessRepoAbs, "out", relPath);
      const fileContent = await readFile(fullPath, "utf-8");

      expect(fileContent).toBe(artifactForFile!.contentUtf8);
    } finally {
      await rm(statelessRepoAbs, { recursive: true, force: true });
    }
  });
});
