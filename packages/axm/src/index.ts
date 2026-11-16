/**
 * `@codai/axiom-axm` — the `.axm` v2 front-end.
 *
 *   parseAxm(source)  → { plan?, diagnostics[] }   (lexer → CST → Plan, PlanSchema-validated)
 *   formatAxm(plan)   → string                      (deterministic inverse; roundtrips any Plan)
 */
import type { Plan } from "@codai/axiom-schema";
import type { ILexingError, IRecognitionException, IToken } from "chevrotain";
import { compileCst } from "./compile.js";
import { type Diagnostic, offsetRange, tokenRange } from "./diagnostics.js";
import { axmLexer } from "./lexer.js";
import { axmParser } from "./parser.js";

export { AXM_VERSION } from "./compile.js";
export type { Diagnostic, Position, Range } from "./diagnostics.js";
export { formatAxm, hereDocTerminator } from "./format.js";
export { KEYWORD_IMAGES } from "./lexer.js";

export interface ParseResult {
  /** Present only when there are no error diagnostics. */
  plan?: Plan;
  diagnostics: Diagnostic[];
}

/**
 * Largest `.axm` document `parseAxm` will attempt: 4 MiB of characters (the same budget the
 * inline blob bundle gets). Nothing legitimate comes close — content that big belongs in a
 * `cas`/`ref` source — and a bound keeps a hostile file from costing unbounded work (A3-15).
 */
export const AXM_SOURCE_MAX: number = 4 * 1024 * 1024;

function atStart(message: string): Diagnostic {
  return {
    severity: "error",
    code: "ERR_INVALID_PLAN",
    message,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
  };
}

function fromLexError(e: ILexingError): Diagnostic {
  return {
    severity: "error",
    code: "ERR_INVALID_PLAN",
    message: e.message,
    range: offsetRange(e.line ?? 1, e.column ?? 1, e.length),
  };
}

function fromParseError(e: IRecognitionException, last: IToken | undefined): Diagnostic {
  const tok = e.token;
  const atEof = tok.tokenType.name === "EOF" || Number.isNaN(tok.startOffset);
  return {
    severity: "error",
    code: "ERR_INVALID_PLAN",
    message: atEof ? `${e.message} (at end of input)` : e.message,
    range: atEof ? eofRange(last) : tokenRange(tok),
  };
}

function eofRange(last: IToken | undefined): Diagnostic["range"] {
  if (last !== undefined && !Number.isNaN(last.startOffset)) {
    const r = tokenRange(last);
    return { start: r.end, end: r.end };
  }
  return { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
}

/**
 * Parse `.axm` text into a `Plan`. Never throws: every problem is a `Diagnostic`
 * with a 1-based `{line, column}` range. `plan` is set only when no error was found.
 */
export function parseAxm(source: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  // Position tracking counts LF; normalising CRLF up front keeps columns exact and makes
  // heredoc contents LF regardless of how the file was checked out.
  const text = source.replace(/\r\n/g, "\n");
  if (text.length > AXM_SOURCE_MAX) {
    return {
      diagnostics: [
        atStart(`source is ${text.length} characters, over the ${AXM_SOURCE_MAX} limit`),
      ],
    };
  }
  try {
    const lexed = axmLexer.tokenize(text);
    for (const e of lexed.errors) diagnostics.push(fromLexError(e));

    axmParser.input = lexed.tokens;
    const cst = axmParser.file();
    const last = lexed.tokens[lexed.tokens.length - 1];
    for (const e of axmParser.errors) diagnostics.push(fromParseError(e, last));

    const compiled = compileCst(diagnostics.length === 0 ? cst : undefined);
    diagnostics.push(...compiled.diagnostics);
    const hasError = diagnostics.some((d) => d.severity === "error");
    return hasError || compiled.plan === undefined
      ? { diagnostics }
      : { plan: compiled.plan, diagnostics };
  } catch (err) {
    // Lexer and parser report their own errors as data; what reaches here is a crash on
    // pathological input (a deeply nested document overflowing the parser's call stack, which
    // used to escape as a RangeError and surface as ERR_INTERNAL). "Never throws" is the
    // contract, so the crash becomes one more diagnostic.
    const reason = err instanceof Error ? err.message : String(err);
    return { diagnostics: [...diagnostics, atStart(`cannot parse: ${reason}`)] };
  }
}
