import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToolsSpec } from "./spec.js";
import { TOOL_DEFS } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("spec/tools.json parity", () => {
  it("committed spec equals a fresh generation from TOOL_DEFS", () => {
    const committed = readFileSync(join(here, "..", "spec", "tools.json"), "utf8");
    expect(committed).toBe(renderToolsSpec());
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
