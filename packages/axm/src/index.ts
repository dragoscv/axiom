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

export interface ParseResult {
  /** Present only when there are no error diagnostics. */
  plan?: Plan;
  diagnostics: Diagnostic[];
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
}
