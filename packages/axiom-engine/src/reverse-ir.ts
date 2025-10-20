import fs from "node:fs";
import path from "node:path";
import type { TAxiomIR, TAgentIR } from "@codai/axiom-core/dist/ir.js";

export interface ReverseIROptions {
    repoPath: string;
    outDir?: string;
}

type EmitItem = TAxiomIR["agents"][0]["emit"][0];

/**
 * Reverse-IR: detectează structura existentă și generează un IR "de stare"
 * pentru a descrie ce există deja în ./out/*
 */
export function reverseIR(options: ReverseIROptions): TAxiomIR {
    const { repoPath, outDir = "out" } = options;
    const outRoot = path.join(repoPath, outDir);

    // Detectează structuri existente
    const emit: EmitItem[] = [];
    const capabilities: TAgentIR["capabilities"] = [
        { kind: "fs", args: [`./${outDir}`], optional: false }
    ];

    if (!fs.existsSync(outRoot)) {
        // Dacă out/ nu există, returnează IR minimal
        return {
            version: "1.0.0",
            agents: [{
                name: "detected-project",
                intent: "Reverse-engineered from empty project structure",
                constraints: [],
                capabilities,
                checks: [],
                emit: []
            }]
        };
    }

    // Scanează subdirectories în out/
    const subdirs = fs.readdirSync(outRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const dir of subdirs) {
        const dirPath = path.join(outRoot, dir);
        const subStructure = detectServiceType(dirPath);

        if (subStructure) {
            emit.push({
                type: "service",
                subtype: subStructure.subtype,
                target: `./${outDir}/${dir}`
            });

            // Dacă detectăm API endpoints, adăugăm net capability
            if (subStructure.hasApi) {
                if (!capabilities.some(c => c.kind === "net")) {
                    capabilities.push({ kind: "net", args: ["http"], optional: false });
                }
            }
        } else {
            // Generic service
            emit.push({
                type: "service",
                target: `./${outDir}/${dir}`
            });
        }
    }

    // Detectează manifest dacă există
    const manifestPath = path.join(repoPath, "manifest.json");
    if (fs.existsSync(manifestPath)) {
        emit.push({
            type: "manifest",
            target: "./manifest.json"
        });
    }

    // Construiește constraints bazate pe ce vedem
    const constraints: TAgentIR["constraints"] = [
        { lhs: "latency_p50_ms", op: "<=", rhs: 100 }, // default reasonable
        { lhs: "pii_leak", op: "==", rhs: false }
    ];

    // Construiește checks bazate pe capabilities
    const checks: TAgentIR["checks"] = [];
    if (capabilities.some(c => c.kind === "fs")) {
        checks.push({
            kind: "policy",
            name: "no-pii",
            expect: "scan.artifacts.no_personal_data()"
        });
    }

    const agent: TAgentIR = {
        name: "detected-project",
        intent: `Reverse-engineered from existing structure in ${outDir}/`,
        constraints,
        capabilities,
        checks,
        emit
    };

    return {
        version: "1.0.0",
        agents: [agent]
    };
}

interface ServiceStructure {
    subtype?: string;
    hasApi: boolean;
}

function detectServiceType(dirPath: string): ServiceStructure | null {
    try {
        const files = fs.readdirSync(dirPath);

        // Detectează web-app patterns
        if (files.includes("package.json")) {
            const pkgPath = path.join(dirPath, "package.json");
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

            // Next.js app
            if (pkg.dependencies?.next || files.includes("next.config.ts") || files.includes("next.config.js")) {
                return { subtype: "web-app", hasApi: false };
            }

            // Express/Fastify API
            if (pkg.dependencies?.express || pkg.dependencies?.fastify) {
                return { subtype: "api-service", hasApi: true };
            }

            // Generic Node.js service
            if (files.some(f => f.endsWith(".js") || f.endsWith(".ts"))) {
                return { subtype: "api-service", hasApi: true };
            }
        }

        // Detectează Dockerfile
        if (files.includes("Dockerfile")) {
            return { subtype: "docker-image", hasApi: false };
        }

        // Detectează structuri de teste
        if (files.includes("test") || files.includes("tests") || files.some(f => f.includes(".test.") || f.includes(".spec."))) {
            return { subtype: "contract", hasApi: false };
        }

        return null;
    } catch {
        return null;
    }
}
