/**
 * Test: Parserul .axm trebuie să populeze complet IR
 * (capability, check, emit în toate formele)
 */

import { describe, it, expect } from "vitest";
import { parseAxiomSource } from "@codai/axiom-core/dist/parser.js";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";

describe("Parser Roundtrip - Complete .axm Parsing", () => {
  it("should parse inline capability, check, emit syntax", () => {
    const source = `
agent "test-agent" {
  intent "Test inline parsing"
  capability net("firebase","api")
  capability fs("./out")
  capability compute("artifact-scan","health-check")
  check policy "privacy_check" { expect "no_pii_in_artifacts == true" }
  check sla "bundle_size" { expect "frontend_bundle_kb <= 5120" }
  check sla "health_latency" { expect "cold_start_ms <= 500" }
  emit service "health-endpoint"
  emit service "dockerfile"
  emit tests "contract-tests"
  emit manifest "manifest"
}
    `.trim();

    const { ir, diagnostics } = parseAxiomSource(source);

    // ASSERT: Parse reușit
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
    expect(ir!.agents.length).toBe(1);

    const agent = ir!.agents[0];

    // ASSERT: Capabilities populate
    expect(agent.capabilities.length).toBe(3);
    expect(agent.capabilities).toContainEqual({
      kind: "net",
      args: ["firebase", "api"],
      optional: false
    });
    expect(agent.capabilities).toContainEqual({
      kind: "fs",
      args: ["./out"],
      optional: false
    });
    expect(agent.capabilities).toContainEqual({
      kind: "compute",
      args: ["artifact-scan", "health-check"],
      optional: false
    });

    // ASSERT: Checks populate
    expect(agent.checks.length).toBe(3);
    expect(agent.checks).toContainEqual({
      kind: "policy",
      name: "privacy_check",
      expect: "no_pii_in_artifacts == true"
    });
    expect(agent.checks).toContainEqual({
      kind: "sla",
      name: "bundle_size",
      expect: "frontend_bundle_kb <= 5120"
    });
    expect(agent.checks).toContainEqual({
      kind: "sla",
      name: "health_latency",
      expect: "cold_start_ms <= 500"
    });

    // ASSERT: Emit populate
    expect(agent.emit.length).toBe(4);
    expect(agent.emit).toContainEqual({
      type: "service",
      target: "health-endpoint"
    });
    expect(agent.emit).toContainEqual({
      type: "service",
      target: "dockerfile"
    });
    expect(agent.emit).toContainEqual({
      type: "tests",
      target: "contract-tests"
    });
    expect(agent.emit).toContainEqual({
      type: "manifest",
      target: "manifest"
    });

    console.log("[parser-roundtrip.test] ✓ Inline syntax parsed completely");
    console.log("IR:", JSON.stringify(ir, null, 2));
  });

  it("should parse block capability, check, emit syntax", () => {
    const source = `
agent "block-agent" {
  intent "Test block parsing"
  
  capabilities {
    net("http","https")
    fs("./data")?
    ai("gpt-4")
  }
  
  checks {
    policy "security" expect "no_telemetry == true"
    sla "performance" expect "cold_start_ms <= 100"
  }
  
  emit {
    service type="web-app" target="my-app"
    tests target="e2e-tests"
  }
}
    `.trim();

    const { ir, diagnostics } = parseAxiomSource(source);

    // ASSERT: Parse reușit
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();

    const agent = ir!.agents[0];

    // ASSERT: Capabilities din block
    expect(agent.capabilities.length).toBe(3);
    expect(agent.capabilities[0]).toEqual({
      kind: "net",
      args: ["http", "https"],
      optional: false
    });
    expect(agent.capabilities[1]).toEqual({
      kind: "fs",
      args: ["./data"],
      optional: true
    });
    expect(agent.capabilities[2]).toEqual({
      kind: "ai",
      args: ["gpt-4"],
      optional: false
    });

    // ASSERT: Checks din block
    expect(agent.checks.length).toBe(2);
    expect(agent.checks[0].kind).toBe("policy");
    expect(agent.checks[0].name).toBe("security");
    expect(agent.checks[1].kind).toBe("sla");
    expect(agent.checks[1].name).toBe("performance");

    // ASSERT: Emit din block
    expect(agent.emit.length).toBe(2);
    expect(agent.emit[0].type).toBe("service");
    expect(agent.emit[0].subtype).toBe("web-app");
    expect(agent.emit[0].target).toBe("my-app");
    expect(agent.emit[1].type).toBe("tests");
    expect(agent.emit[1].target).toBe("e2e-tests");

    console.log("[parser-roundtrip.test] ✓ Block syntax parsed completely");
  });

  it("should produce IR identical to golden for roundtrip", () => {
    const source = `
agent "roundtrip-agent" {
  intent "Golden IR comparison"
  capability net("api")
  check sla "latency" { expect "cold_start_ms <= 50" }
  emit service "app"
}
    `.trim();

    const { ir } = parseAxiomSource(source);

    const goldenIR: TAxiomIR = {
      version: "1.0.0",
      agents: [
        {
          name: "roundtrip-agent",
          intent: "Golden IR comparison",
          constraints: [],
          capabilities: [
            {
              kind: "net",
              args: ["api"],
              optional: false
            }
          ],
          checks: [
            {
              kind: "sla",
              name: "latency",
              expect: "cold_start_ms <= 50"
            }
          ],
          emit: [
            {
              type: "service",
              target: "app"
            }
          ]
        }
      ]
    };

    // ASSERT: IR matches golden
    expect(ir).toEqual(goldenIR);

    console.log("[parser-roundtrip.test] ✓ Roundtrip IR matches golden");
  });
});
