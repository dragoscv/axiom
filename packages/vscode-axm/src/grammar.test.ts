import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEYWORD_IMAGES } from "@codai/axiom-axm";
import { describe, expect, it } from "vitest";

const grammar = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "syntaxes", "axm.tmLanguage.json"), "utf8"),
) as unknown;

/** Every `match` / `begin` / `end` regex string in the grammar. */
function patterns(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) patterns(n, out);
  else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "match" || k === "begin" || k === "end") && typeof v === "string") out.push(v);
      else patterns(v, out);
    }
  }
  return out;
}

const all = patterns(grammar);
/** Keyword as a whole word inside a regex source (alternation member or literal). */
const mentions = (kw: string) =>
  all.some((p) =>
    new RegExp(
      `(^|[^A-Za-z0-9_-])${kw.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
    ).test(p),
  );

describe("axm.tmLanguage.json covers the lexer vocabulary", () => {
  it("has patterns and every pattern compiles as a JS RegExp", () => {
    expect(all.length).toBeGreaterThan(10);
    for (const p of all) expect(() => new RegExp(p.replace(/\\2/g, "x")), p).not.toThrow();
  });

  it.each([...KEYWORD_IMAGES])("keyword %s appears in the grammar", (kw) => {
    expect(mentions(kw), kw).toBe(true);
  });

  it.each(["unified", "v4a", "search-replace", "absent"])("patch vocabulary %s appears", (w) => {
    expect(mentions(w), w).toBe(true);
  });

  it("highlights a patch source line", () => {
    const re = all
      .map((p) => new RegExp(p))
      .find((r) => r.test("patch search-replace absent <<EOF"));
    expect(re).toBeDefined();
  });
});
