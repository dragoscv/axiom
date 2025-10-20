import type { TAxiomIR, TAgentIR } from "@codai/axiom-core/dist/ir.js";

/**
 * JSON-Patch operations pentru IR
 * RFC 6902 simplificat pentru structuri AXIOM
 */
export type AXPatchOp =
    | { op: "add"; path: string; value: any }
    | { op: "remove"; path: string }
    | { op: "replace"; path: string; value: any };

export type AXPatch = AXPatchOp[];

/**
 * Generează un patch minimal între două IR-uri
 */
export function diff(oldIR: TAxiomIR, newIR: TAxiomIR): AXPatch {
    const patch: AXPatch = [];

    // Verifică versiune
    if (oldIR.version !== newIR.version) {
        patch.push({ op: "replace", path: "/version", value: newIR.version });
    }

    // Diff agents (presupunem un singur agent pentru simplitate)
    if (oldIR.agents.length !== newIR.agents.length) {
        // Replace complet dacă numărul diferă
        patch.push({ op: "replace", path: "/agents", value: newIR.agents });
        return patch;
    }

    // Diff primul agent (majoritatea cazurilor)
    const oldAgent = oldIR.agents[0];
    const newAgent = newIR.agents[0];

    if (oldAgent.name !== newAgent.name) {
        patch.push({ op: "replace", path: "/agents/0/name", value: newAgent.name });
    }

    if (oldAgent.intent !== newAgent.intent) {
        patch.push({ op: "replace", path: "/agents/0/intent", value: newAgent.intent });
    }

    // Diff constraints
    diffArray(patch, "/agents/0/constraints", oldAgent.constraints, newAgent.constraints);

    // Diff capabilities
    diffArray(patch, "/agents/0/capabilities", oldAgent.capabilities, newAgent.capabilities);

    // Diff checks
    diffArray(patch, "/agents/0/checks", oldAgent.checks, newAgent.checks, (c) => c.name);

    // Diff emit
    diffArray(patch, "/agents/0/emit", oldAgent.emit, newAgent.emit, (e) => e.target);

    return patch;
}

/**
 * Helper pentru diff arrays cu ID-uri opționale
 */
function diffArray<T>(
    patch: AXPatch,
    basePath: string,
    oldArr: T[],
    newArr: T[],
    keyFn?: (item: T) => string
): void {
    // Dacă nu avem key function, facem diff simplu
    if (!keyFn) {
        if (JSON.stringify(oldArr) !== JSON.stringify(newArr)) {
            patch.push({ op: "replace", path: basePath, value: newArr });
        }
        return;
    }

    // Diff inteligent cu key-uri
    const oldMap = new Map(oldArr.map(item => [keyFn(item), item]));
    const newMap = new Map(newArr.map(item => [keyFn(item), item]));

    // Detectează removes
    for (const [key, oldItem] of oldMap) {
        if (!newMap.has(key)) {
            const idx = oldArr.indexOf(oldItem);
            patch.push({ op: "remove", path: `${basePath}/${idx}` });
        }
    }

    // Detectează adds și replaces
    for (const [key, newItem] of newMap) {
        const oldItem = oldMap.get(key);
        if (!oldItem) {
            // Add
            patch.push({ op: "add", path: `${basePath}/-`, value: newItem });
        } else if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
            // Replace
            const idx = oldArr.findIndex(item => keyFn(item) === key);
            patch.push({ op: "replace", path: `${basePath}/${idx}`, value: newItem });
        }
    }
}

/**
 * Aplică un patch pe un IR
 */
export function applyPatch(ir: TAxiomIR, patch: AXPatch): TAxiomIR {
    // Deep clone pentru a nu muta originalul
    let result = JSON.parse(JSON.stringify(ir)) as TAxiomIR;

    for (const op of patch) {
        result = applyOp(result, op);
    }

    return result;
}

function applyOp(ir: TAxiomIR, op: AXPatchOp): TAxiomIR {
    const pathParts = op.path.split("/").filter(Boolean);

    switch (op.op) {
        case "replace":
            return setPath(ir, pathParts, op.value);
        case "add":
            return addPath(ir, pathParts, op.value);
        case "remove":
            return removePath(ir, pathParts);
        default:
            return ir;
    }
}

function setPath(obj: any, path: string[], value: any): any {
    if (path.length === 0) return value;

    const result = Array.isArray(obj) ? [...obj] : { ...obj };
    const key = path[0];

    if (path.length === 1) {
        if (Array.isArray(result) && key !== "-") {
            result[parseInt(key)] = value;
        } else {
            result[key] = value;
        }
    } else {
        result[key] = setPath(result[key], path.slice(1), value);
    }

    return result;
}

function addPath(obj: any, path: string[], value: any): any {
    if (path.length === 0) return value;

    const result = Array.isArray(obj) ? [...obj] : { ...obj };
    const key = path[0];

    if (path.length === 1) {
        if (Array.isArray(result)) {
            if (key === "-") {
                result.push(value);
            } else {
                result.splice(parseInt(key), 0, value);
            }
        } else {
            result[key] = value;
        }
    } else {
        result[key] = addPath(result[key], path.slice(1), value);
    }

    return result;
}

function removePath(obj: any, path: string[]): any {
    if (path.length === 0) return obj;

    const result = Array.isArray(obj) ? [...obj] : { ...obj };
    const key = path[0];

    if (path.length === 1) {
        if (Array.isArray(result)) {
            result.splice(parseInt(key), 1);
        } else {
            delete result[key];
        }
    } else {
        result[key] = removePath(result[key], path.slice(1));
    }

    return result;
}
