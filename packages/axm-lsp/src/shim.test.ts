import * as merged from "@codai/axiom-axm/lsp";
import { describe, expect, it } from "vitest";
import * as shim from "./index.js";

describe("@codai/axiom-axm-lsp (deprecated shim, D-45)", () => {
  it("re-exports exactly the merged @codai/axiom-axm/lsp surface", () => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(merged).sort());
    expect(shim.computeDiagnostics).toBe(merged.computeDiagnostics);
    expect(shim.startServer).toBe(merged.startServer);
  });

  it("still computes diagnostics through the merged path", () => {
    const diags = shim.computeDiagnostics('axiom "2"\nplan p {\n  intent 1\n}\n');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]?.source).toBe(shim.DIAGNOSTIC_SOURCE);
  });
});
