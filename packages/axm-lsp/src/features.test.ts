import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAxm } from "@codai/axiom-axm";
import { builtinRegistry } from "@codai/axiom-checks";
import { describe, expect, it } from "vitest";
import { CompletionItemKind, DiagnosticSeverity, SymbolKind } from "vscode-languageserver";
import {
  computeCompletions,
  computeDiagnostics,
  computeHover,
  computeSemanticTokens,
  computeSymbols,
  formatDocument,
  SEMANTIC_TOKEN_TYPES,
  toLspRange,
} from "./features.js";
import { LineIndex, scan } from "./scan.js";
import { KEYWORDS, PREDICATE_IDS, PREDICATES } from "./vocabulary.js";

const NOTES = readFileSync(
  join(import.meta.dirname, "..", "..", "axm", "examples", "notes.axm"),
  "utf8",
).replace(/\r\n/g, "\n");

const MINIMAL = `axiom "2"

plan demo {
  intent "x"
  artifact "a.txt" {
    op create
    inline <<EOF
hello
EOF
  }
}
`;

/** Position of the end of the first occurrence of `needle` (0-based LSP position). */
function after(text: string, needle: string): { line: number; character: number } {
  const off = text.indexOf(needle);
  if (off < 0) throw new Error(`needle not found: ${needle}`);
  return new LineIndex(text).positionAt(off + needle.length);
}

function labels(text: string, needle: string): string[] {
  return computeCompletions(text, after(text, needle)).map((c) => c.label);
}

describe("diagnostics", () => {
  it("fixture notes.axm has 0 diagnostics", () => {
    expect(computeDiagnostics(NOTES)).toEqual([]);
  });

  it("maps a 1-based parseAxm range to a 0-based LSP range (minus one on both axes)", () => {
    const text = 'axiom "2"\nplan p {\n  intent 1\n}\n';
    const axm = parseAxm(text).diagnostics;
    expect(axm.length).toBeGreaterThan(0);
    const lsp = computeDiagnostics(text);
    expect(lsp).toHaveLength(axm.length);
    for (let i = 0; i < axm.length; i++) {
      const a = axm[i]!;
      const l = lsp[i]!;
      expect(l.range.start).toEqual({
        line: a.range.start.line - 1,
        character: a.range.start.column - 1,
      });
      expect(l.range.end).toEqual({
        line: a.range.end.line - 1,
        character: a.range.end.column - 1,
      });
      expect(l.code).toBe(a.code);
      expect(l.source).toBe("axm");
      expect(l.severity).toBe(DiagnosticSeverity.Error);
    }
  });

  it("points at the offending token, not the file start", () => {
    const text = 'axiom "2"\nplan p {\n  intent 1\n}\n';
    const [d] = computeDiagnostics(text);
    expect(d?.range.start.line).toBe(2);
    expect(d?.range.start.character).toBe(9);
  });

  it("toLspRange clamps below zero", () => {
    expect(toLspRange({ start: { line: 0, column: 0 }, end: { line: 0, column: 0 } })).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  });

  it("an unterminated heredoc is an error at the `<<`", () => {
    const text =
      'axiom "2"\nplan p {\n  intent "x"\n  artifact "a" {\n    inline <<EOF\nnever closed\n  }\n}\n';
    const ds = computeDiagnostics(text);
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.some((d) => d.range.start.line === 4 && d.range.start.character === 11)).toBe(true);
  });
});

describe("completion", () => {
  it("lists all 15 built-in predicate ids after `using ` (parity with @codai/axiom-checks)", () => {
    const text = 'axiom "2"\nplan p {\n  intent "x"\n  check c using \n}\n';
    const got = labels(text, "using ").sort();
    const registry = builtinRegistry().list().sort();
    expect(registry).toHaveLength(15);
    expect(got).toEqual(registry);
    expect([...PREDICATE_IDS].sort()).toEqual(registry);
    for (const id of registry) expect(PREDICATES[id]).toBeTruthy();
  });

  it("replaces a partially typed qualified predicate id as one edit", () => {
    const text = 'axiom "2"\nplan p {\n  intent "x"\n  check c using content.no\n}\n';
    const pos = after(text, "content.no");
    const items = computeCompletions(text, pos);
    expect(items.map((i) => i.label)).toContain("content.noSecrets");
    const edit = items[0]?.textEdit;
    expect(edit && "range" in edit ? edit.range : undefined).toEqual({
      start: { line: 3, character: 16 },
      end: pos,
    });
    expect(items.every((i) => i.kind === CompletionItemKind.Function)).toBe(true);
  });

  it("offers capability names inside `capabilities [` minus the ones already used", () => {
    const text = 'axiom "2"\nplan p {\n  intent "x"\n  capabilities [fs, \n}\n';
    const got = labels(text, "capabilities [fs, ");
    expect(got.sort()).toEqual(["ai", "compute", "git", "net", "secret"]);
  });

  it("offers 0644|0755 after `mode `", () => {
    const text = `${MINIMAL.replace("op create", "mode ")}`;
    expect(labels(text, "mode ")).toEqual(["0644", "0755"]);
  });

  it("offers create|overwrite|delete after `op `", () => {
    expect(labels(MINIMAL, "op ")).toEqual(["create", "overwrite", "delete"]);
  });

  it("offers profiles after `profile `", () => {
    const text = 'axiom "2"\nplan p {\n  intent "x"\n  profile \n}\n';
    expect(labels(text, "profile ")).toEqual(["default", "strict", "permissive"]);
  });

  it("offers plan-body keywords at statement start inside a plan", () => {
    const text = 'axiom "2"\nplan p {\n  intent "x"\n  \n}\n';
    const got = labels(text, 'intent "x"\n  ');
    expect(got).toEqual(["intent", "profile", "capabilities", "artifact", "check", "meta"]);
  });

  it("offers artifact-body keywords inside an artifact", () => {
    const got = labels(MINIMAL, "op create\n    ");
    expect(got).toEqual(["mode", "op", "inline", "template", "cas", "ref"]);
  });

  it("offers file-level keywords at depth 0", () => {
    expect(labels("", "")).toEqual(["axiom", "plan"]);
  });

  it("keyword completions are snippets whose textEdit replaces the typed prefix", () => {
    const text = 'axiom "2"\nplan p {\n  intent "x"\n  arti\n}\n';
    const pos = after(text, "arti");
    const item = computeCompletions(text, pos).find((i) => i.label === "artifact");
    expect(item?.insertTextFormat).toBe(2);
    const edit = item?.textEdit;
    expect(edit && "range" in edit ? edit.range.start : undefined).toEqual({
      line: 3,
      character: 2,
    });
    expect(edit?.newText).toBe(KEYWORDS.artifact?.snippet);
  });
});

describe("hover", () => {
  it("documents a keyword", () => {
    const h = computeHover(MINIMAL, after(MINIMAL, "inten"));
    expect(h).not.toBeNull();
    const v = h?.contents;
    expect(typeof v === "object" && "value" in v ? v.value : "").toContain("**intent**");
  });

  it("documents a predicate id after `using`, covering the full qualified range", () => {
    const pos = after(NOTES, "content.noSec");
    const h = computeHover(NOTES, pos);
    const v = h?.contents;
    expect(typeof v === "object" && "value" in v ? v.value : "").toContain("content.noSecrets");
    const line = pos.line;
    const text = NOTES.split("\n")[line] ?? "";
    expect(h?.range?.start.line).toBe(line);
    expect(text.slice(h?.range?.start.character, h?.range?.end.character)).toBe(
      "content.noSecrets",
    );
  });

  it("does not document a plan or check name that happens to be a keyword", () => {
    const text = 'axiom "2"\nplan check {\n  intent "x"\n}\n';
    expect(computeHover(text, after(text, "plan che"))).toBeNull();
  });

  it("returns null on strings and whitespace", () => {
    expect(computeHover(MINIMAL, after(MINIMAL, 'intent "'))).toBeNull();
  });
});

describe("document symbols", () => {
  it("yields plan → artifacts + checks for the fixture", () => {
    const syms = computeSymbols(NOTES);
    expect(syms).toHaveLength(1);
    const plan = syms[0]!;
    expect(plan.name).toBe("notes-app");
    expect(plan.kind).toBe(SymbolKind.Module);
    const names = plan.children?.map((c) => `${c.detail?.split(" ")[0]}:${c.name}`);
    expect(names).toEqual([
      "artifact:src/notes.ts",
      "artifact:bin/notes",
      "artifact:legacy/shim.js",
      "check:no-secrets",
      "check:readme-with-src",
    ]);
    const check = plan.children?.find((c) => c.name === "no-secrets");
    expect(check?.detail).toBe("check using content.noSecrets");
  });

  it("plan range spans to the closing brace and selectionRange is the name", () => {
    const [plan] = computeSymbols(MINIMAL);
    expect(plan?.selectionRange).toEqual({
      start: { line: 2, character: 5 },
      end: { line: 2, character: 9 },
    });
    expect(plan?.range.end.line).toBe(MINIMAL.split("\n").length - 2);
  });

  it("survives an unclosed plan body", () => {
    const text = 'axiom "2"\nplan p {\n  artifact "a" {\n';
    const [plan] = computeSymbols(text);
    expect(plan?.name).toBe("p");
    expect(plan?.children?.[0]?.name).toBe("a");
  });
});

describe("formatting", () => {
  it("returns [] when the document has diagnostics", () => {
    expect(formatDocument('axiom "2"\nplan p {\n  intent 1\n}\n')).toEqual([]);
  });

  it("returns a single whole-document edit producing formatAxm output", () => {
    const messy =
      'axiom "2"\nplan   demo {\n intent "x"\n artifact "a.txt" { op create\n inline <<EOF\nhello\nEOF\n }\n}\n';
    const edits = formatDocument(messy);
    expect(edits).toHaveLength(1);
    const e = edits[0]!;
    expect(e.range.start).toEqual({ line: 0, character: 0 });
    expect(e.range.end.line).toBe(messy.split("\n").length - 1);
    expect(e.newText).toContain("plan demo {");
    expect(e.newText).toContain('  artifact "a.txt" {');
  });

  it("is idempotent: formatting the formatted text yields no edits", () => {
    const messy =
      'axiom "2"\nplan   demo {\n intent "x"\n artifact "a.txt" { op create\n inline <<EOF\nhello\nEOF\n }\n}\n';
    const once = formatDocument(messy)[0]!.newText;
    expect(formatDocument(once)).toEqual([]);
    expect(parseAxm(once).plan).toEqual(parseAxm(messy).plan);
  });
});

describe("semantic tokens", () => {
  it("legend has exactly the five documented types", () => {
    expect([...SEMANTIC_TOKEN_TYPES]).toEqual([
      "keyword",
      "string",
      "number",
      "comment",
      "property",
    ]);
  });

  it("emits well-formed relative data with only legend indices", () => {
    const { data } = computeSemanticTokens(NOTES);
    expect(data.length % 5).toBe(0);
    expect(data.length).toBeGreaterThan(25);
    for (let i = 0; i < data.length; i += 5) {
      expect(data[i]).toBeGreaterThanOrEqual(0);
      expect(data[i + 2]).toBeGreaterThan(0);
      expect(data[i + 3]).toBeGreaterThanOrEqual(0);
      expect(data[i + 3]).toBeLessThan(SEMANTIC_TOKEN_TYPES.length);
    }
  });

  it("classifies the first line: `axiom` keyword then a string", () => {
    const { data } = computeSemanticTokens('axiom "2"\n');
    expect(data).toEqual([0, 0, 5, 0, 0, 0, 6, 3, 1, 0]);
  });

  it("classifies mode value as number and a comment as comment", () => {
    const text = '// hi\nplan p {\n  artifact "a" {\n    mode 0755\n  }\n}\n';
    const { data } = computeSemanticTokens(text);
    const types = [];
    for (let i = 0; i < data.length; i += 5) types.push(SEMANTIC_TOKEN_TYPES[data[i + 3]!]);
    expect(types[0]).toBe("comment");
    expect(types).toContain("number");
  });
});

describe("scanner", () => {
  it("treats braces inside a heredoc as raw bytes (no depth change)", () => {
    const toks = scan(MINIMAL.replace("hello", "{ { {"));
    const punct = toks.filter((t) => t.kind === "punct").map((t) => t.image);
    expect(punct.filter((p) => p === "{")).toHaveLength(2);
    expect(punct.filter((p) => p === "}")).toHaveLength(2);
    expect(toks.some((t) => t.kind === "heredoc")).toBe(true);
  });

  it("recognises the JSON block after `using pred` and after `meta`", () => {
    const toks = scan(NOTES)
      .filter((t) => t.kind === "json")
      .map((t) => t.image);
    expect(toks).toHaveLength(3);
    expect(toks[0]).toBe("{}");
    expect(toks[2]).toContain('"ticket":"S-204"');
  });

  it("LineIndex roundtrips offsets", () => {
    const idx = new LineIndex(NOTES);
    for (const off of [0, 5, 10, 57, NOTES.length - 1]) {
      const p = idx.positionAt(off);
      expect(idx.offsetAt(p.line, p.character)).toBe(off);
    }
  });
});
