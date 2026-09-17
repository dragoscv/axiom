import { describe, it, expect } from "vitest";
import { check, generate } from "@codai/axiom-engine";
import type { TAxiomIR } from "@codai/axiom-core/dist/ir.js";

/**
 * Test verifică că evaluatorul check:
 * 1. Setează `details.evaluated = true` pentru fiecare check evaluat
 * 2. Calculează `passed` real din measurements vs expect
 * 3. Agregat AND logic: passed = toate checks passed
 * 
 * ACCEPTANCE:
 * - Toate evidence items au `details.evaluated === true`
 * - Când TOATE checks pass → agregat `passed = true`
 * - Când ORICE check fails → agregat `passed = false`
 */
describe("check evaluator AND aggregation logic", () => {
    it("should set evaluated:true for all checks and use AND aggregation", async () => {
        // IR cu mai multe checks (unele vor pica, altele vor trece)
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "test-agent",
                    intent: "test check aggregation",
                    constraints: [],
                    capabilities: [],
                    checks: [
                        {
                            kind: "sla",
                            name: "cold_start_check",
                            expect: "cold_start_ms <= 100" // va trece (default 100)
                        },
                        {
                            kind: "policy",
                            name: "bundle_size_check",
                            expect: "frontend_bundle_kb <= 50" // va pica (webapp > 50kb)
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

        // Generate și check
        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // ACCEPTANCE 1: evaluated flag la nivel de rezultat final
        expect(checkResult.evaluated).toBe(true);

        // ACCEPTANCE 2: Toate evidence items au details.evaluated === true
        expect(checkResult.report.length).toBe(2);
        checkResult.report.forEach(evidence => {
            expect((evidence.details as any).evaluated, `Check ${evidence.checkName} should have evaluated:true`).toBe(true);
        });

        // ACCEPTANCE 3: AND aggregation - dacă orice check pică, rezultat = false
        // cold_start_check va trece (100 <= 100)
        // bundle_size_check va pica (webapp bundle > 50kb)
        const coldStartEvidence = checkResult.report.find(e => e.checkName === "cold_start_check");
        const bundleEvidence = checkResult.report.find(e => e.checkName === "bundle_size_check");

        expect(coldStartEvidence?.passed).toBe(true);
        expect(bundleEvidence?.passed).toBe(false);

        // Agregat trebuie să fie false (AND logic)
        expect(checkResult.passed).toBe(false);
    });

    it("should return passed:true when ALL checks pass", async () => {
        // IR cu checks care vor trece TOATE
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
                            expect: "cold_start_ms <= 500" // va trece (default 100 < 500)
                        },
                        {
                            kind: "policy",
                            name: "no_heavy_fs",
                            expect: "no_fs_heavy == true" // va trece (webapp nu face fs heavy)
                        }
                    ],
                    emit: [
                        {
                            type: "service",
                            subtype: "web-app",
                            target: "clean-app"
                        }
                    ]
                }
            ]
        };

        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // Toate checks ar trebui să treacă
        expect(checkResult.report.length).toBe(2);
        checkResult.report.forEach(evidence => {
            expect(evidence.passed, `Check ${evidence.checkName} should pass`).toBe(true);
            expect((evidence.details as any).evaluated).toBe(true);
        });

        // Agregat AND: toate true → passed = true
        expect(checkResult.passed).toBe(true);
    });

    it("should return passed:false when ANY check fails", async () => {
        // IR unde toate checks pică
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "failing-agent",
                    intent: "checks should fail",
                    constraints: [],
                    capabilities: [],
                    checks: [
                        {
                            kind: "sla",
                            name: "impossible_cold_start",
                            expect: "cold_start_ms <= 10" // va pica (default 100 > 10)
                        },
                        {
                            kind: "policy",
                            name: "impossible_bundle",
                            expect: "frontend_bundle_kb <= 1" // va pica (webapp > 1kb)
                        }
                    ],
                    emit: [
                        {
                            type: "service",
                            subtype: "web-app",
                            target: "heavy-app"
                        }
                    ]
                }
            ]
        };

        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // Toate checks ar trebui să pice
        expect(checkResult.report.length).toBe(2);
        checkResult.report.forEach(evidence => {
            expect(evidence.passed, `Check ${evidence.checkName} should fail`).toBe(false);
            expect((evidence.details as any).evaluated).toBe(true);
        });

        // Agregat AND: toate false → passed = false
        expect(checkResult.passed).toBe(false);
    });

    it("should handle empty checks gracefully", async () => {
        // IR fără checks
        const ir: TAxiomIR = {
            version: "1.0.0",
            agents: [
                {
                    name: "no-checks-agent",
                    intent: "no checks to evaluate",
                    constraints: [],
                    capabilities: [],
                    checks: [], // empty
                    emit: [
                        {
                            type: "service",
                            subtype: "web-app",
                            target: "simple-app"
                        }
                    ]
                }
            ]
        };

        const { manifest } = await generate(ir, process.cwd());
        const checkResult = await check(manifest, ir, process.cwd());

        // Fără checks, passed ar trebui să fie true (vacuous truth)
        expect(checkResult.report.length).toBe(0);
        expect(checkResult.passed).toBe(true);
        expect(checkResult.evaluated).toBe(true);
    });
});
