/**
 * Pure LSP feature functions over `.axm` text. No connection, no documents manager — the
 * server (`server.ts`) is a thin adapter, so every feature is unit-testable in-process.
 *
 * Diagnostics and formatting come straight from `@codai/axiom-axm` (`parseAxm` / `formatAxm`);
 * the remaining features run on the tolerant scanner in `scan.ts` so they keep working while
 * the user is mid-edit and the real parser reports errors.
 */
import { type Diagnostic as AxmDiagnostic, formatAxm, parseAxm } from "@codai/axiom-axm";
import {
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic,
  DiagnosticSeverity,
  type DocumentSymbol,
  type Hover,
  InsertTextFormat,
  MarkupKind,
  type Position,
  type Range,
  type SemanticTokens,
  type SemanticTokensLegend,
  SymbolKind,
  type TextEdit,
} from "vscode-languageserver";
import { depthAt, LineIndex, type ScanToken, scan } from "./scan.js";
import {
  CAPABILITIES,
  KEYWORDS,
  MODE_VALUES,
  OP_VALUES,
  PREDICATE_IDS,
  PREDICATES,
  PROFILE_VALUES,
} from "./vocabulary.js";

export const DIAGNOSTIC_SOURCE = "axm";

// --- diagnostics -----------------------------------------------------------------------------

/** `parseAxm` ranges are 1-based `{line, column}`; LSP is 0-based `{line, character}`. */
export function toLspRange(r: AxmDiagnostic["range"]): Range {
  return {
    start: { line: Math.max(0, r.start.line - 1), character: Math.max(0, r.start.column - 1) },
    end: { line: Math.max(0, r.end.line - 1), character: Math.max(0, r.end.column - 1) },
  };
}

export function computeDiagnostics(text: string): Diagnostic[] {
  return parseAxm(text).diagnostics.map((d) => ({
    range: toLspRange(d.range),
    severity: d.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    code: d.code,
    source: DIAGNOSTIC_SOURCE,
    message: d.message,
  }));
}

// --- completion ------------------------------------------------------------------------------

interface Cursor {
  /** Significant (non-comment) tokens that end strictly before the word under the cursor. */
  prev: ScanToken[];
  /** The identifier the cursor is inside/at the end of, if any. */
  word: ScanToken | undefined;
  offset: number;
  depth: number;
}

function cursorAt(tokens: readonly ScanToken[], offset: number): Cursor {
  const significant = tokens.filter((t) => t.kind !== "comment");
  const word = significant.find((t) => t.kind === "ident" && t.start < offset && offset <= t.end);
  const prev = significant.filter((t) => t.end <= (word ? word.start : offset));
  return { prev, word, offset, depth: depthAt(tokens, word ? word.start : offset) };
}

function last(c: Cursor, n = 1): ScanToken | undefined {
  return c.prev[c.prev.length - n];
}

function isKw(t: ScanToken | undefined, kw: string): boolean {
  return t !== undefined && t.kind === "ident" && t.image === kw;
}

/** Walk back over `Ident { "." Ident }` preceding the cursor word; returns the index of its head. */
function qualifiedHead(c: Cursor): number {
  let i = c.prev.length;
  // pattern before the word: … head ident ( "." ident )* [ "." ]
  if (c.prev[i - 1]?.image === "." && c.prev[i - 1]?.kind === "punct") i--;
  while (i >= 2 && c.prev[i - 1]?.kind === "ident" && c.prev[i - 2]?.image === ".") i -= 2;
  if (c.prev[i - 1]?.kind === "ident" && c.prev[i - 1]?.image !== "using") i--;
  return i;
}

function replaceRange(idx: LineIndex, start: number, end: number): Range {
  return { start: idx.positionAt(start), end: idx.positionAt(end) };
}

function items(
  values: readonly string[],
  kind: CompletionItemKind,
  range: Range,
  detail?: (v: string) => string | undefined,
): CompletionItem[] {
  return values.map((v, i) => {
    const d = detail?.(v);
    const item: CompletionItem = {
      label: v,
      kind,
      sortText: String(i).padStart(3, "0"),
      textEdit: { range, newText: v },
    };
    if (d !== undefined) item.detail = d;
    return item;
  });
}

export function computeCompletions(text: string, position: Position): CompletionItem[] {
  const idx = new LineIndex(text);
  const offset = idx.offsetAt(position.line, position.character);
  const tokens = scan(text);
  const c = cursorAt(tokens, offset);
  const wordRange = replaceRange(idx, c.word ? c.word.start : offset, offset);

  // `check ID using <predicate>` — the qualified ident may be partially typed (`content.no`).
  const head = qualifiedHead(c);
  if (isKw(c.prev[head - 1], "using")) {
    const from = c.prev[head]?.start ?? (c.word ? c.word.start : offset);
    const range = replaceRange(idx, from, offset);
    return items(PREDICATE_IDS, CompletionItemKind.Function, range, (id) => PREDICATES[id]);
  }

  // `capabilities [ a, b, <cap>` — open bracket without a closing one before the cursor.
  const openBracket = findOpenBracket(c);
  if (openBracket !== undefined && isKw(c.prev[openBracket - 1], "capabilities")) {
    const used = new Set(
      c.prev
        .slice(openBracket + 1)
        .filter((t) => t.kind === "ident")
        .map((t) => t.image),
    );
    return items(
      CAPABILITIES.filter((cap) => !used.has(cap)),
      CompletionItemKind.EnumMember,
      wordRange,
    );
  }

  const l1 = last(c);
  if (isKw(l1, "mode")) return items(MODE_VALUES, CompletionItemKind.Value, wordRange);
  if (isKw(l1, "op")) return items(OP_VALUES, CompletionItemKind.EnumMember, wordRange);
  if (isKw(l1, "profile")) return items(PROFILE_VALUES, CompletionItemKind.EnumMember, wordRange);

  // Statement start: keywords valid at the current nesting depth.
  const depth = Math.min(c.depth, 2) as 0 | 1 | 2;
  return Object.entries(KEYWORDS)
    .filter(([kw, k]) => k.depth === depth && kw !== "using")
    .map(([kw, k], i) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
      detail: k.doc,
      sortText: String(i).padStart(3, "0"),
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit: { range: wordRange, newText: k.snippet },
    }));
}

function findOpenBracket(c: Cursor): number | undefined {
  for (let i = c.prev.length - 1; i >= 0; i--) {
    const t = c.prev[i];
    if (t?.kind !== "punct") continue;
    if (t.image === "]" || t.image === "{" || t.image === "}") return undefined;
    if (t.image === "[") return i;
  }
  return undefined;
}

// --- hover -----------------------------------------------------------------------------------

export function computeHover(text: string, position: Position): Hover | null {
  const idx = new LineIndex(text);
  const offset = idx.offsetAt(position.line, position.character);
  const tokens = scan(text).filter((t) => t.kind !== "comment");
  const i = tokens.findIndex((t) => t.kind === "ident" && t.start <= offset && offset <= t.end);
  if (i < 0) return null;

  // Expand to the qualified identifier around the word (predicate ids are `group.name`).
  let lo = i;
  let hi = i;
  while (lo >= 2 && tokens[lo - 1]?.image === "." && tokens[lo - 2]?.kind === "ident") lo -= 2;
  while (tokens[hi + 1]?.image === "." && tokens[hi + 2]?.kind === "ident") hi += 2;
  const first = tokens[lo];
  const lastTok = tokens[hi];
  if (first === undefined || lastTok === undefined) return null;
  const qualified = text.slice(first.start, lastTok.end);
  const range = replaceRange(idx, first.start, lastTok.end);

  const predicateDoc = PREDICATES[qualified];
  if (predicateDoc !== undefined && isKw(tokens[lo - 1], "using")) {
    return md(`**${qualified}** — predicate\n\n${predicateDoc}`, range);
  }
  const word = tokens[i];
  if (word === undefined) return null;
  // `plan check {…}` names a plan "check" — do not document the keyword there.
  const prevTok = tokens[i - 1];
  if (isKw(prevTok, "plan") || isKw(prevTok, "check")) return null;
  const kw = KEYWORDS[word.image];
  if (kw !== undefined) {
    return md(`**${word.image}** — keyword\n\n${kw.doc}`, replaceRange(idx, word.start, word.end));
  }
  return null;
}

function md(value: string, range: Range): Hover {
  return { contents: { kind: MarkupKind.Markdown, value }, range };
}

// --- document symbols ------------------------------------------------------------------------

export function computeSymbols(text: string): DocumentSymbol[] {
  const idx = new LineIndex(text);
  const tokens = scan(text).filter((t) => t.kind !== "comment");
  const out: DocumentSymbol[] = [];
  const closeOf = (openIdx: number): number => {
    let depth = 0;
    for (let j = openIdx; j < tokens.length; j++) {
      const t = tokens[j];
      if (t?.kind !== "punct") continue;
      if (t.image === "{") depth++;
      else if (t.image === "}" && --depth === 0) return t.end;
    }
    return text.length;
  };
  const nextOpen = (from: number): number => {
    for (let j = from; j < tokens.length; j++) {
      const t = tokens[j];
      if (t?.kind === "punct" && t.image === "{") return j;
      if (t?.kind === "punct" && t.image === "}") return -1;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined || !isKw(t, "plan") || depthAt(tokens, t.start) !== 0) continue;
    const name = tokens[i + 1];
    if (name?.kind !== "ident") continue;
    const open = nextOpen(i + 2);
    const end = open < 0 ? name.end : closeOf(open);
    const plan: DocumentSymbol = {
      name: name.image,
      detail: "plan",
      kind: SymbolKind.Module,
      range: replaceRange(idx, t.start, end),
      selectionRange: replaceRange(idx, name.start, name.end),
      children: [],
    };
    for (let j = open + 1; j < tokens.length; j++) {
      const k = tokens[j];
      if (k === undefined || k.end > end) break;
      if (depthAt(tokens, k.start) !== 1) continue;
      const p = tokens[j + 1];
      if (p === undefined) continue;
      if (isKw(k, "artifact") && (p.kind === "string" || p.kind === "digest")) {
        const o = nextOpen(j + 2);
        const e = o < 0 ? p.end : closeOf(o);
        plan.children?.push({
          name: JSON.parse(safeString(p.image)) as string,
          detail: "artifact",
          kind: SymbolKind.File,
          range: replaceRange(idx, k.start, e),
          selectionRange: replaceRange(idx, p.start, p.end),
        });
      } else if (isKw(k, "check") && p.kind === "ident") {
        const id = p;
        let e = id.end;
        let pred = "";
        if (isKw(tokens[j + 2], "using")) {
          let q = j + 3;
          while (tokens[q]?.kind === "ident" || tokens[q]?.image === ".") q++;
          pred = text.slice(tokens[j + 3]?.start ?? id.end, tokens[q - 1]?.end ?? id.end);
          e = tokens[q - 1]?.end ?? id.end;
          const json = tokens[q];
          if (json?.kind === "json") e = json.end;
        }
        plan.children?.push({
          name: id.image,
          detail: pred ? `check using ${pred}` : "check",
          kind: SymbolKind.Function,
          range: replaceRange(idx, k.start, e),
          selectionRange: replaceRange(idx, id.start, id.end),
        });
      }
    }
    out.push(plan);
  }
  return out;
}

function safeString(image: string): string {
  try {
    JSON.parse(image);
    return image;
  } catch {
    return JSON.stringify(image.replace(/^"|"$/g, ""));
  }
}

// --- formatting ------------------------------------------------------------------------------

/**
 * Canonical `formatAxm` output as one whole-document edit. Only when the document parses with
 * zero diagnostics — reformatting a broken file would silently drop what the parser skipped.
 */
export function formatDocument(text: string): TextEdit[] {
  const r = parseAxm(text);
  if (r.diagnostics.length > 0 || r.plan === undefined) return [];
  let formatted: string;
  try {
    formatted = formatAxm(r.plan);
  } catch {
    return [];
  }
  if (formatted === text) return [];
  const idx = new LineIndex(text);
  return [{ range: replaceRange(idx, 0, text.length), newText: formatted }];
}

// --- semantic tokens -------------------------------------------------------------------------

export const SEMANTIC_TOKEN_TYPES = ["keyword", "string", "number", "comment", "property"] as const;
export const SEMANTIC_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [],
};
type SemanticType = (typeof SEMANTIC_TOKEN_TYPES)[number];

function classify(tokens: readonly ScanToken[], i: number): SemanticType | undefined {
  const t = tokens[i];
  if (t === undefined) return undefined;
  switch (t.kind) {
    case "comment":
      return "comment";
    case "string":
    case "digest":
    case "heredoc":
    case "json":
      return "string";
    case "punct":
      return undefined;
    case "ident": {
      const prev = tokens[i - 1];
      if (isKw(prev, "plan") || isKw(prev, "check") || isKw(prev, "profile")) return "property";
      if (isKw(prev, "mode") && MODE_VALUES.includes(t.image)) return "number";
      if (isKw(prev, "using") || prev?.image === "." || tokens[i + 1]?.image === ".") {
        return "property";
      }
      if (KEYWORDS[t.image] !== undefined) return "keyword";
      if (OP_VALUES.includes(t.image) && isKw(prev, "op")) return "keyword";
      if (CAPABILITIES.includes(t.image)) return "keyword";
      return undefined;
    }
  }
}

export function computeSemanticTokens(text: string): SemanticTokens {
  const idx = new LineIndex(text);
  const tokens = scan(text);
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  const emit = (line: number, char: number, len: number, type: SemanticType): void => {
    if (len <= 0) return;
    data.push(
      line - prevLine,
      line === prevLine ? char - prevChar : char,
      len,
      SEMANTIC_TOKEN_TYPES.indexOf(type),
      0,
    );
    prevLine = line;
    prevChar = char;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as ScanToken;
    const type = classify(tokens, i);
    if (type === undefined) continue;
    // Tokens may span lines (heredoc, JSON, block comment): emit one range per line.
    const start = idx.positionAt(t.start);
    const end = idx.positionAt(t.end);
    if (start.line === end.line) {
      emit(start.line, start.character, end.character - start.character, type);
      continue;
    }
    for (let line = start.line; line <= end.line; line++) {
      const lineStart = idx.offsetAt(line, 0);
      const lineEnd = line < end.line ? idx.offsetAt(line + 1, 0) - 1 : t.end;
      const from = line === start.line ? t.start : lineStart;
      emit(line, from - lineStart, Math.max(0, lineEnd - from), type);
    }
  }
  return { data };
}
