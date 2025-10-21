/**
 * Test: Evaluatorul /check trebuie să fie determinist și să evalueze corect
 * policy/sla/constraints bazat pe measurements reale
 */

import { describe, it, expect } from "vitest";
import { generate } from "@codai/axiom-engine/dist/generate.js";
import { check } from "@codai/axiom-engine/dist/check.js";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Check Evaluator - Deterministic & Real", () => {
  it("should set evaluated:true and pass when constraint is met (edge profile)", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "edge-agent",
          intent: "Test edge profile constraints",
          constraints: [],
          capabilities: [],
          checks: [
            {
              kind: "sla",
              name: "cold_start_check",
              expect: "cold_start_ms <= 50" // edge profile => 50ms
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-check-pass-"));

    try {
      const { manifest } = await generate(ir, tmpDir, "edge");
      const result = await check(manifest, ir, tmpDir);

      // ASSERT: evaluated trebuie să fie true
      expect(result.evaluated).toBe(true);

      // ASSERT: passed trebuie să fie true (edge => cold_start_ms=50, check e <=50)
      expect(result.passed).toBe(true);

      // ASSERT: evidence conține measurements
      expect(result.report.length).toBeGreaterThan(0);
      const evidence = result.report[0];
      expect(evidence.checkName).toBe("cold_start_check");
      expect(evidence.passed).toBe(true);
      expect(evidence.details).toHaveProperty("measurements");
      expect((evidence.details as any).measurements.cold_start_ms).toBe(50);

      console.log("[check-evaluator.test] ✓ Check passed with edge profile");
      console.log("Evidence:", JSON.stringify(evidence, null, 2));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should set passed:false when constraint is NOT met (default vs edge)", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "default-agent",
          intent: "Test default profile fails edge constraint",
          constraints: [],
          capabilities: [],
          checks: [
            {
              kind: "sla",
              name: "strict_cold_start",
              expect: "cold_start_ms <= 50" // default profile => 100ms, check e <=50
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-check-fail-"));

    try {
      // Generate cu profil DEFAULT (cold_start_ms = 100)
      const { manifest } = await generate(ir, tmpDir, "default");
      const result = await check(manifest, ir, tmpDir);

      // ASSERT: evaluated=true
      expect(result.evaluated).toBe(true);

      // ASSERT: passed=false (100 > 50)
      expect(result.passed).toBe(false);

      // ASSERT: report conține motivul
      const evidence = result.report[0];
      expect(evidence.checkName).toBe("strict_cold_start");
      expect(evidence.passed).toBe(false);
      expect((evidence.details as any).measurements.cold_start_ms).toBe(100);

      console.log("[check-evaluator.test] ✓ Check failed as expected (100ms > 50ms)");
      console.log("Evidence:", JSON.stringify(evidence, null, 2));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should evaluate multiple checks and aggregate passed status", async () => {
    const ir: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "multi-check-agent",
          intent: "Test multiple checks aggregation",
          constraints: [],
          capabilities: [],
          checks: [
            {
              kind: "sla",
              name: "check_cold_start",
              expect: "cold_start_ms <= 50" // edge => PASS
            },
            {
              kind: "sla",
              name: "check_bundle_size",
              expect: "frontend_bundle_kb <= 5120" // PASS (sub 5MB)
            },
            {
              kind: "policy",
              name: "check_no_telemetry",
              expect: "no_telemetry == true" // PASS (nicio dep telemetry)
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-multi-check-"));

    try {
      const { manifest } = await generate(ir, tmpDir, "edge");
      const result = await check(manifest, ir, tmpDir);

      // ASSERT: evaluated=true
      expect(result.evaluated).toBe(true);

      // ASSERT: toate checks au passed
      expect(result.report.length).toBe(3);
      expect(result.report.every(e => e.passed)).toBe(true);

      // ASSERT: passed global e true
      expect(result.passed).toBe(true);

      console.log("[check-evaluator.test] ✓ Multiple checks all passed");
      console.log(`Checks: ${result.report.map(e => e.checkName).join(", ")}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
