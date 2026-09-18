import type { ErrorCode } from "@codai/axiom-schema";
import type { IToken } from "chevrotain";

export interface Position {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  /** Always a member of the closed `ERROR_CODES` enum. */
  code: ErrorCode;
  range: Range;
}

export const ORIGIN: Range = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

/** Range covering one token (Chevrotain positions are 1-based, `end*` inclusive). */
export function tokenRange(t: IToken | undefined): Range {
  if (t === undefined || Number.isNaN(t.startLine ?? Number.NaN)) return ORIGIN;
  return {
    start: { line: t.startLine ?? 1, column: t.startColumn ?? 1 },
    end: { line: t.endLine ?? t.startLine ?? 1, column: (t.endColumn ?? t.startColumn ?? 1) + 1 },
  };
}

/** Range from the start of `a` to the end of `b`. */
export function spanRange(a: IToken | undefined, b: IToken | undefined): Range {
  const start = tokenRange(a).start;
  const end = tokenRange(b ?? a).end;
  return { start, end };
}

/** Range for a text offset (used for lexer errors, which carry offset + line/column). */
export function offsetRange(line: number, column: number, length: number): Range {
  return { start: { line, column }, end: { line, column: column + Math.max(length, 1) } };
}
