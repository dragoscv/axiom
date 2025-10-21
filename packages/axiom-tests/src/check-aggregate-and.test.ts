import { describe, it, expect } from "vitest";
import { check, generate } from "@codai/axiom-engine";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";

/**
 * Test check evaluator AND aggregation logic
 * 
 * ACCEPTANCE:
 * - All evidence items have details.evaluated === true
 * - Aggregate passed uses AND logic: all checks must pass
 * - Case PASS: all true → aggregate true
 * - Case FAIL: one false → aggregate false
 */
describe("check aggregate AND logic test", () => {
    it("should return passed=true when ALL checks pass (AND logic)", async () => {
        // IR with checks that will ALL pass
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "passing-agent",
                    intent: "all checks should pass",
                    constraints: [],
                    capabilities: [],
                    checks: [
                        {
                            kind: "sla",
                            name: "reasonable_cold_start",
                            expect: "cold_start_ms <= 500" // Will pass (default 100 < 500)
                        },
                        {
                            kind: "policy",
                            name: "reasonable_size",
                            expect: "frontend_bundle_kb <= 10000" // Will pass (much larger limit)
                        },
                        {
                            kind: "policy",
                            name: "response_ok",
                            expect: "response_under_500ms == true" // Will pass (100ms < 500ms)
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

        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // ACCEPTANCE 1: All evidence items have evaluated:true
        expect(checkResult.report.length).toBe(3);
        checkResult.report.forEach((evidence, idx) => {
            const details = evidence.details as any;
            expect(details.evaluated, `Check ${idx} (${evidence.checkName}) should have evaluated:true`)
                .toBe(true);
        });

        // ACCEPTANCE 2: All checks pass individually
        checkResult.report.forEach(evidence => {
            expect(evidence.passed, `Check ${evidence.checkName} should pass`).toBe(true);
        });

        // ACCEPTANCE 3: Aggregate uses AND logic - all true → passed = true
        expect(checkResult.passed, "Aggregate passed should be true when all checks pass").toBe(true);
        expect(checkResult.evaluated).toBe(true);

        console.log("✅ CHECK AND AGGREGATION TEST PASSED (all true case)");
        console.log(`   Total checks: ${checkResult.report.length}`);
        console.log(`   All passed: ${checkResult.report.every(e => e.passed)}`);
        console.log(`   Aggregate: ${checkResult.passed}`);
    });

    it("should return passed=false when ANY check fails (AND logic)", async () => {
        // IR with mixed checks (some pass, one fails)
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "mixed-agent",
                    intent: "one check will fail",
                    constraints: [],
                    capabilities: [],
                    checks: [
                        {
                            kind: "sla",
                            name: "reasonable_cold_start",
                            expect: "cold_start_ms <= 500" // Will pass
                        },
                        {
                            kind: "policy",
                            name: "impossible_bundle_size",
                            expect: "frontend_bundle_kb <= 1" // Will FAIL (webapp > 1kb)
                        },
                        {
                            kind: "policy",
                            name: "response_ok",
                            expect: "response_under_500ms == true" // Will pass
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

        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // ACCEPTANCE 1: All evidence items have evaluated:true
        expect(checkResult.report.length).toBe(3);
        checkResult.report.forEach((evidence, idx) => {
            const details = evidence.details as any;
            expect(details.evaluated, `Check ${idx} (${evidence.checkName}) should have evaluated:true`)
                .toBe(true);
        });

        // ACCEPTANCE 2: At least one check fails
        const failedChecks = checkResult.report.filter(e => !e.passed);
        expect(failedChecks.length).toBeGreaterThan(0);

        // Find the impossible bundle size check (should fail)
        const bundleCheck = checkResult.report.find(e => e.checkName === "impossible_bundle_size");
        expect(bundleCheck?.passed, "impossible_bundle_size should fail").toBe(false);

        // ACCEPTANCE 3: Aggregate uses AND logic - one false → passed = false
        expect(checkResult.passed, "Aggregate passed should be false when any check fails").toBe(false);
        expect(checkResult.evaluated).toBe(true);

        console.log("✅ CHECK AND AGGREGATION TEST PASSED (one false case)");
        console.log(`   Total checks: ${checkResult.report.length}`);
        console.log(`   Failed checks: ${failedChecks.length}`);
        console.log(`   Aggregate: ${checkResult.passed}`);
    });

    it("should handle empty checks gracefully (vacuous truth)", async () => {
        // IR with no checks
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "no-checks-agent",
                    intent: "no checks to evaluate",
                    constraints: [],
                    capabilities: [],
                    checks: [], // Empty
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

        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // ACCEPTANCE: Empty checks should return passed=true (vacuous truth)
        expect(checkResult.report.length).toBe(0);
        expect(checkResult.passed).toBe(true);
        expect(checkResult.evaluated).toBe(true);

        console.log("✅ CHECK AND AGGREGATION TEST PASSED (empty case)");
        console.log(`   Total checks: ${checkResult.report.length}`);
        console.log(`   Aggregate: ${checkResult.passed} (vacuous truth)`);
    });
});
