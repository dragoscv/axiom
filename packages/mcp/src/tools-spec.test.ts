import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCodaiToolsSpec, renderCodaiToolsSpec, renderToolsSpec } from "./spec.js";
import { TOOL_DEFS } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("spec/tools.json parity", () => {
  it("committed spec equals a fresh generation from TOOL_DEFS", () => {
    const committed = readFileSync(join(here, "..", "spec", "tools.json"), "utf8");
    expect(committed).toBe(renderToolsSpec());
  });

  it("committed spec/codai-tools.json equals a fresh generation (codai tools-v2.json shape)", () => {
    const committed = readFileSync(join(here, "..", "spec", "codai-tools.json"), "utf8");
    expect(committed).toBe(renderCodaiToolsSpec());
  });

  it("codai-tools.json entries carry exactly codai's fields with the registry risk", () => {
    const spec = buildCodaiToolsSpec();
    expect(spec.tools).toHaveLength(TOOL_DEFS.length);
    for (const [i, e] of spec.tools.entries()) {
      const def = TOOL_DEFS[i];
      expect(Object.keys(e).sort()).toEqual(["description", "name", "parameters", "risk"]);
      expect(e.name).toBe(def?.name);
      expect(e.risk).toBe(def?.riskClass);
      expect(e.parameters).not.toHaveProperty("$schema");
      expect(e.parameters.type).toBe("object");
    }
    const risk = Object.fromEntries(spec.tools.map((t) => [t.name, t.risk]));
    expect(risk.axiom_apply).toBe("SENSITIVE");
    expect(risk.axiom_rollback).toBe("SENSITIVE");
    expect(risk.axiom_plan_compile).toBe("ACT");
    expect(risk.axiom_check).toBe("READ");
    expect(risk.axiom_apply_dry_run).toBe("READ");
  });

  it("riskClass follows annotations; names are unique and snake_case", () => {
    const names = new Set<string>();
    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(/^axiom_[a-z_]+$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      if (t.annotations.readOnlyHint) expect(t.riskClass).toBe("READ");
      else if (t.annotations.destructiveHint) expect(t.riskClass).toBe("SENSITIVE");
      else expect(t.riskClass).toBe("ACT");
    }
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual([
      "axiom_apply",
      "axiom_apply_dry_run",
      "axiom_axm_parse",
      "axiom_check",
      "axiom_manifest_diff",
      "axiom_manifest_verify",
      "axiom_plan_compile",
      "axiom_plan_validate",
      "axiom_rollback",
      "axiom_roots_list",
    ]);
  });
});

describe("stdout cleanliness guard", () => {
  it("no console.log / process.stdout.write in src outside cli.ts / cli-main.ts", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(here)) {
      if (!f.endsWith(".ts") || f === "cli.ts" || f === "cli-main.ts" || f.endsWith(".test.ts"))
        continue;
      const text = readFileSync(join(here, f), "utf8");
      if (/console\.log\(|process\.stdout\.write\(/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
