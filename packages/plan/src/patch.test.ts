import { type AxiomError, isAxiomError } from "@codai/axiom-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyParsedPatch,
  applyPatchText,
  parseSearchReplace,
  parseUnified,
  parseV4A,
} from "./patch.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (isAxiomError(err)) return (err as AxiomError).code;
    throw err;
  }
  throw new Error("expected an AxiomError");
}

const PRE = "a\nb\nc\nd\ne\nf\n";

describe("unified", () => {
  it("applies a hunk with context, preserving the trailing newline", () => {
    const body = "--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n";
    expect(applyPatchText("unified", body, PRE)).toBe("a\nb\nC\nd\ne\nf\n");
  });
  it("multiple hunks apply in order; a later hunk is searched after the earlier one", () => {
    const body = "@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -5,2 +5,2 @@\n e\n-f\n+F\n";
    expect(applyPatchText("unified", body, PRE)).toBe("A\nb\nc\nd\ne\nF\n");
  });
  it("ERR_PATCH_NO_MATCH when a context line differs by one character", () => {
    const body = "@@ -2,3 +2,3 @@\n b\n-c\n+C\n D\n";
    expect(codeOf(() => applyPatchText("unified", body, PRE))).toBe("ERR_PATCH_NO_MATCH");
  });
  it("ERR_PATCH_NO_MATCH when whitespace differs (no fuzz, D-17)", () => {
    const body = "@@ -2,3 +2,3 @@\n b \n-c\n+C\n d\n";
    expect(codeOf(() => applyPatchText("unified", body, PRE))).toBe("ERR_PATCH_NO_MATCH");
  });
  it("ambiguous block: the -a line hint picks the nearest occurrence; without it → no match", () => {
    const rep = "x\nk\nx\nk\nx\nk\n";
    // hint says line 3 → second `x`
    expect(applyPatchText("unified", "@@ -3,1 +3,1 @@\n-x\n+Y\n", rep)).toBe("x\nk\nY\nk\nx\nk\n");
    // search-replace has no hint → ambiguous
    expect(
      codeOf(() =>
        applyPatchText("search-replace", "<<<<<<< SEARCH\nx\n=======\nY\n>>>>>>> REPLACE\n", rep),
      ),
    ).toBe("ERR_PATCH_NO_MATCH");
  });
  it("ERR_PATCH_FORMAT on a header/line-count mismatch and on a body without hunks", () => {
    expect(codeOf(() => parseUnified("@@ -1,3 +1,3 @@\n-a\n+A\n"))).toBe("ERR_PATCH_FORMAT");
    expect(codeOf(() => parseUnified("just text\n"))).toBe("ERR_PATCH_FORMAT");
  });
  it("handles a file without trailing newline and the '\\ No newline' marker", () => {
    const pre = "a\nb";
    const body =
      "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n";
    expect(applyPatchText("unified", body, pre)).toBe("a\nB");
  });
});

describe("v4a", () => {
  it("Update File with @@ anchor: block is searched after the anchor line", () => {
    const pre = "h\nx\nsec1\nx\nsec2\nx\n";
    const body = "*** Begin Patch\n*** Update File: f\n@@ sec2\n-x\n+Y\n*** End Patch\n";
    expect(applyPatchText("v4a", body, pre)).toBe("h\nx\nsec1\nx\nsec2\nY\n");
  });
  it("Update File without anchor, context lines, multiple chunks", () => {
    const body =
      "*** Begin Patch\n*** Update File: f\n@@\n a\n-b\n+B\n@@\n d\n-e\n+E\n@@\n f\n+g\n*** End of File\n*** End Patch\n";
    expect(applyPatchText("v4a", body, PRE)).toBe("a\nB\nc\nd\nE\nf\ng\n");
  });
  it("*** End of File constrains the match to the file end", () => {
    const pre = "x\ny\nx\n";
    const ok = "*** Begin Patch\n*** Update File: f\n@@\n-x\n+Z\n*** End of File\n*** End Patch\n";
    expect(applyPatchText("v4a", ok, pre)).toBe("x\ny\nZ\n");
    const bad = "*** Begin Patch\n*** Update File: f\n@@\n-y\n+Z\n*** End of File\n*** End Patch\n";
    expect(codeOf(() => applyPatchText("v4a", bad, pre))).toBe("ERR_PATCH_NO_MATCH");
  });
  it("Add File yields the content; against a non-empty pre-image → ERR_PATCH_NO_MATCH", () => {
    const body = "*** Begin Patch\n*** Add File: n\n+one\n+two\n*** End Patch\n";
    expect(applyPatchText("v4a", body, "")).toBe("one\ntwo\n");
    expect(codeOf(() => applyPatchText("v4a", body, "x\n"))).toBe("ERR_PATCH_NO_MATCH");
  });
  it("rejects Delete File, Move to, multi-file and malformed envelopes as ERR_PATCH_FORMAT / NO_MATCH", () => {
    expect(
      codeOf(() =>
        parseV4A(
          "*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n-x\n+y\n*** End Patch\n",
        ),
      ),
    ).toBe("ERR_PATCH_FORMAT");
    expect(
      codeOf(() =>
        parseV4A(
          "*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\n*** Update File: b\n@@\n-x\n+y\n*** End Patch\n",
        ),
      ),
    ).toBe("ERR_PATCH_FORMAT");
    expect(codeOf(() => parseV4A("*** Update File: a\n@@\n-x\n+y\n*** End Patch\n"))).toBe(
      "ERR_PATCH_FORMAT",
    );
    expect(codeOf(() => parseV4A("*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\n"))).toBe(
      "ERR_PATCH_FORMAT",
    );
    expect(codeOf(() => parseV4A("*** Begin Patch\n*** Update File: a\n*** End Patch\n"))).toBe(
      "ERR_PATCH_FORMAT",
    );
    const del = parseV4A("*** Begin Patch\n*** Delete File: a\n*** End Patch\n");
    expect(del.op).toBe("delete");
    expect(codeOf(() => applyParsedPatch("x\n", del))).toBe("ERR_PATCH_NO_MATCH");
  });
});

describe("search-replace", () => {
  it("replaces an exact unique block; several blocks apply in order", () => {
    const body =
      "<<<<<<< SEARCH\nb\nc\n=======\nB\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ne\n=======\ne\ne2\n>>>>>>> REPLACE\n";
    expect(applyPatchText("search-replace", body, PRE)).toBe("a\nB\nd\ne\ne2\nf\n");
  });
  it("empty SEARCH creates content only in an empty file", () => {
    const body = "<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n";
    expect(applyPatchText("search-replace", body, "")).toBe("new\n");
    expect(codeOf(() => applyPatchText("search-replace", body, "x\n"))).toBe("ERR_PATCH_NO_MATCH");
  });
  it("tolerates a ``` fence and blank lines between blocks; rejects a missing divider", () => {
    const body = "```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n";
    expect(applyPatchText("search-replace", body, PRE)).toBe("A\nb\nc\nd\ne\nf\n");
    expect(codeOf(() => parseSearchReplace("<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n"))).toBe(
      "ERR_PATCH_FORMAT",
    );
    expect(codeOf(() => parseSearchReplace(""))).toBe("ERR_PATCH_FORMAT");
  });
});

describe("properties", () => {
  const line = fc.stringMatching(/^[a-z0-9 ]{0,12}$/);
  const doc = fc.array(line, { minLength: 1, maxLength: 30 });

  it("a search-replace block built from a unique slice of the document applies and yields the expected text", () => {
    fc.assert(
      fc.property(doc, fc.nat(), fc.nat(), fc.array(line, { maxLength: 5 }), (ls, s, n, repl) => {
        // make lines unique so the slice is unique
        const uniq = ls.map((l, i) => `${i}:${l}`);
        const start = s % uniq.length;
        const len = 1 + (n % (uniq.length - start));
        const search = uniq.slice(start, start + len);
        const replBlock = repl.length === 0 ? "" : `${repl.join("\n")}\n`;
        const body = `<<<<<<< SEARCH\n${search.join("\n")}\n=======\n${replBlock}>>>>>>> REPLACE\n`;
        const pre = `${uniq.join("\n")}\n`;
        const expected = [...uniq.slice(0, start), ...repl, ...uniq.slice(start + len)];
        const out = applyPatchText("search-replace", body, pre);
        expect(out).toBe(expected.length === 0 ? "" : `${expected.join("\n")}\n`);
      }),
      { numRuns: 200 },
    );
  });

  it("any single-character change to a context line of a unified hunk is rejected (no fuzz)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.string({ minLength: 1, maxLength: 1 }),
        (which, ch) => {
          const ctx = ["ctx one", "ctx two"];
          const target = ["old"];
          const pre = `${[...ctx, ...target, "tail"].join("\n")}\n`;
          const mutated = [...ctx];
          const k = which % 2;
          const orig = mutated[k] as string;
          const pos = which % orig.length;
          if (orig[pos] === ch) return true; // no-op mutation, skip
          mutated[k] = orig.slice(0, pos) + ch + orig.slice(pos + 1);
          const body = `@@ -1,3 +1,3 @@\n ${mutated[0]}\n ${mutated[1]}\n-old\n+new\n`;
          return codeOf(() => applyPatchText("unified", body, pre)) === "ERR_PATCH_NO_MATCH";
        },
      ),
      { numRuns: 100 },
    );
  });
});
