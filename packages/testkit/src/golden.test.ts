import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compileGolden, type GoldenExpected, listGoldenCases } from "./golden.js";

/**
 * Cross-OS determinism guard: every `golden/*.plan.json` must compile to the
 * digest committed in `golden/*.expected.json`. Regenerate with
 * `pnpm --filter @codai/axiom-testkit update-golden` only when the manifest
 * format changes on purpose.
 */
describe("golden manifests", async () => {
  const cases = await listGoldenCases();
  it("has at least one golden case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const c of cases) {
    it(`${c.name} compiles to its committed digest`, async () => {
      const expected = JSON.parse(await readFile(c.expectedPath, "utf8")) as GoldenExpected;
      const actual = await compileGolden(c.planPath);
      expect(actual.manifestDigest).toBe(expected.manifestDigest);
      expect(actual).toEqual(expected);
    });
  }

  it("D-17: a patch plan and its inline twin share planDigest and artifact digests (only origin differs)", async () => {
    const byName = new Map(cases.map((c) => [c.name, c]));
    const patch = byName.get("plan-patch");
    const inline = byName.get("plan-patch-inline");
    if (patch === undefined || inline === undefined) throw new Error("golden twins missing");
    const a = await compileGolden(patch.planPath);
    const b = await compileGolden(inline.planPath);
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.artifacts).toEqual(b.artifacts);
    // manifestDigest differs because `origin` (patch vs inline) is recorded per artifact.
    expect(a.manifestDigest).not.toBe(b.manifestDigest);
  });

  it("D-41: a 2.x plan (axiom.dev/v2) still compiles, to its 2.x digest; v3 differs only in digests", async () => {
    const byName = new Map(cases.map((c) => [c.name, c]));
    const v3 = byName.get("plan-basic");
    const v2 = byName.get("plan-basic-v2");
    if (v3 === undefined || v2 === undefined) throw new Error("plan-basic twins missing");
    expect(JSON.parse(await readFile(v2.planPath, "utf8")).apiVersion).toBe("axiom.dev/v2");
    expect(JSON.parse(await readFile(v3.planPath, "utf8")).apiVersion).toBe("axiom.codai.ro/v3");
    const a = await compileGolden(v3.planPath);
    const b = await compileGolden(v2.planPath);
    expect(b.manifestDigest).toBe(
      "sha256:dc486d57187df44cd3bcaa93a43422da84e8808bbb6bc28cd9d24f3ecbf585e0",
    );
    expect(a.manifestDigest).not.toBe(b.manifestDigest);
    expect(a.planDigest).not.toBe(b.planDigest);
    expect(a.artifacts).toEqual(b.artifacts);
  });
});
