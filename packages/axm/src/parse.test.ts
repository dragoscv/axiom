import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlan } from "@codai/axiom-plan";
import type { Plan } from "@codai/axiom-schema";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Diagnostic, formatAxm, hereDocTerminator, parseAxm } from "./index.js";
import { planArb } from "./test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "..", "examples", "notes.axm"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "..", "examples", "notes.plan.json"), "utf8"),
) as Plan;

const wrap = (items: string, name = "p") => `axiom "2"\nplan ${name} {\n${items}\n}\n`;
const ART = 'artifact "a.txt" { inline <<EOF\nhi\nEOF\n }';
const minimal = (items = "") => wrap(`intent "x"\n${ART}\n${items}`);

function errors(src: string): Diagnostic[] {
  return parseAxm(src).diagnostics.filter((d) => d.severity === "error");
}
function firstError(src: string): Diagnostic {
  const e = errors(src)[0];
  if (e === undefined) throw new Error("expected an error diagnostic");
  return e;
}

describe("golden fixture", () => {
  it("examples/notes.axm compiles to examples/notes.plan.json", () => {
    const r = parseAxm(fixture);
    expect(r.diagnostics).toEqual([]);
    expect(r.plan).toStrictEqual(golden);
  });

  it("fixture survives CRLF checkout byte-for-byte in the heredoc", () => {
    const r = parseAxm(fixture.replace(/\n/g, "\r\n"));
    expect(r.plan).toStrictEqual(golden);
  });

  it("compile-through: parseAxm → compilePlan yields a stable manifestDigest", async () => {
    const plan = parseAxm(fixture).plan;
    expect(plan).toBeDefined();
    // the fixture has a cas source that is not resolvable without a root; use inline-only subset
    const inlineOnly: Plan = {
      ...(plan as Plan),
      artifacts: (plan as Plan).artifacts.filter((a) => a.source?.type !== "cas"),
    };
    const a = await compilePlan(inlineOnly, { store: "inline" });
    const b = await compilePlan(parseAxm(formatAxm(inlineOnly)).plan as Plan, { store: "inline" });
    expect(a.bundle.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.bundle.manifestDigest).toBe(a.bundle.manifestDigest);
  });
});

describe("EBNF productions", () => {
  it("header: missing `axiom` → error at 1:1", () => {
    const d = firstError('plan p { intent "x" }');
    expect(d.code).toBe("ERR_INVALID_PLAN");
    expect(d.range.start).toEqual({ line: 1, column: 1 });
  });

  it("header: wrong version string → error pointing at the string", () => {
    const d = firstError('axiom "1"\nplan p { intent "x" }');
    expect(d.range.start).toEqual({ line: 1, column: 7 });
    expect(d.message).toMatch(/version/);
  });

  it("planDecl: name may be a keyword-looking Ident; two plans → error on the second", () => {
    expect(parseAxm(wrap(`intent "x"\n${ART}`, "plan-1")).plan?.name).toBe("plan-1");
    const two = `${minimal()}plan q { intent "y"\n${ART} }`;
    const d = firstError(two);
    expect(d.range.start.line).toBe(10);
  });

  it("intent: required, at most once", () => {
    expect(firstError(wrap(ART)).message).toMatch(/intent/);
    expect(firstError(minimal('intent "again"')).message).toMatch(/duplicate intent/);
  });

  it("profile: defaults to `default`, accepts any Ident", () => {
    expect(parseAxm(minimal()).plan?.profile).toBe("default");
    expect(parseAxm(minimal("profile my_profile-2")).plan?.profile).toBe("my_profile-2");
  });

  it("capabilities: empty list, full list, unknown cap → error at the cap", () => {
    expect(parseAxm(minimal("capabilities []")).plan?.capabilities).toEqual([]);
    expect(
      parseAxm(minimal("capabilities [fs, net, secret, ai, compute, git]")).plan?.capabilities,
    ).toEqual(["fs", "net", "secret", "ai", "compute", "git"]);
    const d = firstError(minimal("capabilities [fs, sudo]"));
    expect(d.message).toMatch(/unknown capability "sudo"/);
    expect(d.range.start).toEqual({ line: 8, column: 19 });
    expect(firstError(minimal("capabilities [fs, fs]")).message).toMatch(/duplicate capability/);
    expect(errors(minimal("capabilities [fs,]")).length).toBeGreaterThan(0);
  });

  it("artifact: mode/op defaults, explicit values, delete without source", () => {
    const p = parseAxm(
      wrap(
        'intent "x"\nartifact "a" { inline <<E\nx\nE\n }\nartifact "b" { mode 0755 op overwrite cas "sha256:' +
          "a".repeat(64) +
          '" }\nartifact "c" { op delete }',
      ),
    ).plan;
    expect(p?.artifacts).toEqual([
      {
        path: "a",
        mode: "0644",
        op: "create",
        source: { type: "inline", encoding: "utf8", content: "x" },
      },
      {
        path: "b",
        mode: "0755",
        op: "overwrite",
        source: { type: "cas", digest: `sha256:${"a".repeat(64)}` },
      },
      { path: "c", mode: "0644", op: "delete" },
    ]);
  });

  it("artifact: duplicate path → ERR_INVALID_PLAN at the second path literal", () => {
    const d = firstError(wrap(`intent "x"\n${ART}\n${ART}`));
    expect(d.code).toBe("ERR_INVALID_PLAN");
    expect(d.message).toMatch(/duplicate artifact path "a.txt"/);
    expect(d.range.start).toEqual({ line: 8, column: 10 });
  });

  it("artifact: delete with a source, create without a source, two sources → errors", () => {
    expect(firstError(wrap('intent "x"\nartifact "a" { op delete inline <<E\nE\n }')).code).toBe(
      "ERR_INVALID_PLAN",
    );
    const d = firstError(wrap('intent "x"\nartifact "a" { mode 0644 }'));
    expect(d.message).toMatch(/source is required/);
    expect(d.range.start).toEqual({ line: 4, column: 14 });
    expect(
      firstError(
        wrap('intent "x"\nartifact "a" { inline <<E\nE\n cas "sha256:' + "b".repeat(64) + '" }'),
      ).message,
    ).toMatch(/exactly one source/);
  });

  it("artifact: invalid mode literal, invalid op, bad path → errors with positions", () => {
    const m = firstError(wrap('intent "x"\nartifact "a" { mode 0600 inline <<E\nE\n }'));
    expect(m.message).toMatch(/mode must be 0644 or 0755/);
    expect(m.range.start).toEqual({ line: 4, column: 21 });
    expect(
      errors(wrap('intent "x"\nartifact "a" { op rename inline <<E\nE\n }')).length,
    ).toBeGreaterThan(0);
    const bad = firstError(wrap(`intent "x"\nartifact "../a" { inline <<E\nE\n }`));
    expect(bad.code).toBe("ERR_PATH_SEGMENT");
    expect(bad.range.start).toEqual({ line: 4, column: 10 });
  });

  it("source ref: uri + digest; file/https only", () => {
    const d = `"sha256:${"c".repeat(64)}"`;
    const ok = parseAxm(wrap(`intent "x"\nartifact "a" { ref "https://h/x" ${d} }`)).plan;
    expect(ok?.artifacts[0]?.source).toEqual({
      type: "ref",
      uri: "https://h/x",
      digest: `sha256:${"c".repeat(64)}`,
    });
    const bad = firstError(wrap(`intent "x"\nartifact "a" { ref "ftp://h/x" ${d} }`));
    expect(bad.range.start).toEqual({ line: 4, column: 20 });
  });

  it("source cas: a non-digest string is a syntax error at that string", () => {
    const d = firstError(wrap('intent "x"\nartifact "a" { cas "sha256:short" }'));
    expect(d.range.start).toEqual({ line: 4, column: 20 });
  });

  it("source template: QualIdent String [Json]", () => {
    const p = parseAxm(
      wrap(
        'intent "x"\nartifact "a" { template web.next16 "page" {"title":"Hi"} }\nartifact "b" { template web.next16 "layout" }',
      ),
    ).plan;
    expect(p?.artifacts[0]?.source).toEqual({
      type: "template",
      emitter: "web.next16",
      template: "page",
      params: { title: "Hi" },
    });
    expect(p?.artifacts[1]?.source).toEqual({
      type: "template",
      emitter: "web.next16",
      template: "layout",
      params: {},
    });
  });

  it("check: id using QualIdent [Json]; params default {}; malformed predicate → schema error at predicate", () => {
    const p = parseAxm(
      minimal('check a using content.noSecrets\ncheck b using path.deny {"globs":["x"]}'),
    ).plan;
    expect(p?.checks).toEqual([
      { id: "a", predicate: "content.noSecrets", params: {}, severity: "error" },
      { id: "b", predicate: "path.deny", params: { globs: ["x"] }, severity: "error" },
    ]);
    const d = firstError(minimal("check a using nodots"));
    expect(d.range.start).toEqual({ line: 8, column: 15 });
    // unknown predicate ids are NOT an error here — the checks registry decides at runtime
    expect(parseAxm(minimal("check a using totally.unknown")).plan?.checks[0]?.predicate).toBe(
      "totally.unknown",
    );
  });

  it("check: params that are not JSON → error at the block", () => {
    const d = firstError(minimal("check a using content.noSecrets {oops}"));
    expect(d.range.start).toEqual({ line: 8, column: 33 });
    expect(d.message).toMatch(/check params/);
  });

  it("meta: object required; array → error; duplicate → error", () => {
    expect(parseAxm(minimal('meta {"k":[1,{"n":null}]}')).plan?.metadata).toEqual({
      k: [1, { n: null }],
    });
    expect(firstError(minimal("meta [1]")).message).toMatch(/object/);
    expect(firstError(minimal("meta {}\nmeta {}")).message).toMatch(/duplicate meta/);
  });

  it("comments are skipped everywhere", () => {
    const p = parseAxm(
      `// top\naxiom "2" /* block\nover lines */\nplan p { // c\n intent "x" /* c */\n ${ART} }`,
    ).plan;
    expect(p?.intent).toBe("x");
  });

  it("parse error carries Chevrotain's expected-token message and an exact position", () => {
    const d = firstError('axiom "2"\nplan p {\n  intent 42\n}');
    expect(d.message).toMatch(/Expecting token of type/);
    expect(d.range.start).toEqual({ line: 3, column: 10 });
  });

  it("unexpected end of input → position after the last token", () => {
    const d = firstError('axiom "2"\nplan p {\n  intent "x"');
    expect(d.message).toMatch(/end of input/);
    expect(d.range.start).toEqual({ line: 3, column: 13 });
  });

  it("lexer error: stray character → error at its offset", () => {
    const d = firstError('axiom "2"\nplan p {\n  intent "x" §\n}');
    expect(d.range.start).toEqual({ line: 3, column: 14 });
  });

  it("never throws on garbage", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const r = parseAxm(s);
        return r.plan !== undefined || r.diagnostics.length > 0;
      }),
      { numRuns: 300 },
    );
  });
});

describe("heredoc", () => {
  const inline = (body: string, term = "EOF") =>
    parseAxm(wrap(`intent "x"\nartifact "a" { inline <<${term}\n${body}${term}\n }`)).plan
      ?.artifacts[0]?.source;

  it("content excludes the final newline; trailing newline needs an empty line", () => {
    expect(inline("a\n")).toMatchObject({ content: "a" });
    expect(inline("a\n\n")).toMatchObject({ content: "a\n" });
  });

  it("empty body", () => {
    expect(inline("")).toMatchObject({ content: "" });
  });

  it("terminator text inside content only ends the block when alone on a line", () => {
    expect(inline("say EOF now\n EOF\nEOF \n")).toMatchObject({
      content: "say EOF now\n EOF\nEOF ",
    });
  });

  it("braces, quotes, `}` lines and `//` inside content are raw bytes", () => {
    expect(inline('}\n{"a":"//x"} // not a comment\n')).toMatchObject({
      content: '}\n{"a":"//x"} // not a comment',
    });
  });

  it("CRLF input is normalised to LF", () => {
    const src = wrap('intent "x"\nartifact "a" { inline <<E\nl1\nl2\nE\n }').replace(/\n/g, "\r\n");
    expect(parseAxm(src).plan?.artifacts[0]?.source).toMatchObject({ content: "l1\nl2" });
  });

  it("unterminated heredoc → lexer error at `<<`", () => {
    const d = firstError(
      'axiom "2"\nplan p {\n intent "x"\n artifact "a" { inline <<END\nno end\n }\n}',
    );
    expect(d.range.start).toEqual({ line: 4, column: 24 });
  });

  it("hereDocTerminator avoids collisions", () => {
    expect(hereDocTerminator("x")).toBe("EOF");
    expect(hereDocTerminator("EOF")).toBe("EOF_1");
    expect(hereDocTerminator("EOF\nEOF_1")).toBe("EOF_2");
  });
});

describe("formatAxm", () => {
  it("is the inverse of parseAxm on the golden plan", () => {
    const text = formatAxm(golden);
    expect(parseAxm(text).plan).toStrictEqual(golden);
    expect(formatAxm(parseAxm(text).plan as Plan)).toBe(text);
  });

  it("roundtrip property: parseAxm(formatAxm(p)).plan deep-equals p", () => {
    fc.assert(
      fc.property(planArb, (p) => {
        const r = parseAxm(formatAxm(p));
        expect(r.diagnostics).toEqual([]);
        expect(r.plan).toStrictEqual(p);
      }),
      { numRuns: 200 },
    );
  });

  it("uses 2-space indentation and LF only", () => {
    const text = formatAxm(golden);
    expect(text).not.toMatch(/\r/);
    expect(text).toMatch(
      /\n {2}artifact "src\/notes.ts" \{\n {4}mode 0644\n {4}op create\n {4}inline <<EOF\n/,
    );
  });
});
