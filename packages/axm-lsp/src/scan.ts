/**
 * A tolerant, position-only scanner over `.axm` text used for the editor features that must
 * work on *broken* documents (completion context, hover word, symbols, semantic tokens).
 * It knows just enough of the lexical structure (strings, comments, heredocs, JSON blocks) to
 * never mis-nest braces; the real grammar is `@codai/axiom-axm` (`parseAxm`), which this
 * package reuses verbatim for diagnostics and formatting.
 */

export type TokenKind = "comment" | "string" | "digest" | "heredoc" | "json" | "ident" | "punct";

export interface ScanToken {
  kind: TokenKind;
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  image: string;
}

const IDENT_START = /[A-Za-z0-9_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
const DIGEST = /^"sha256:[a-f0-9]{64}"$/;

function isJsonExpected(sig: readonly ScanToken[]): boolean {
  let i = sig.length - 1;
  const at = (k: number): ScanToken | undefined => sig[k];
  if (at(i)?.image === "meta" && at(i)?.kind === "ident") return true;
  if (at(i)?.kind === "string" || at(i)?.kind === "digest") i--;
  if (at(i)?.kind !== "ident") return false;
  i--;
  while (at(i)?.image === "." && at(i - 1)?.kind === "ident") i -= 2;
  const head = at(i);
  return head?.kind === "ident" && (head.image === "using" || head.image === "template");
}

function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function scanHereDoc(text: string, start: number): number | null {
  const m = /^<<([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(text.slice(start, start + 256));
  if (m === null) return null;
  const term = m[1] ?? "";
  let lineStart = start + m[0].length;
  for (;;) {
    let eol = text.indexOf("\n", lineStart);
    if (eol < 0) eol = text.length;
    let line = text.slice(lineStart, eol);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === term) return eol;
    if (eol >= text.length) return text.length;
    lineStart = eol + 1;
  }
}

/** Tokenise `text` (whitespace dropped, comments kept). Never throws, never loops. */
export function scan(text: string): ScanToken[] {
  const out: ScanToken[] = [];
  const sig: ScanToken[] = [];
  const push = (kind: TokenKind, start: number, end: number): void => {
    const t: ScanToken = { kind, start, end, image: text.slice(start, end) };
    out.push(t);
    if (kind !== "comment") sig.push(t);
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      let eol = text.indexOf("\n", i);
      if (eol < 0) eol = text.length;
      push("comment", i, eol);
      i = eol;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      push("comment", i, end);
      i = end;
      continue;
    }
    if (ch === "<" && text[i + 1] === "<") {
      const end = scanHereDoc(text, i);
      if (end !== null) {
        push("heredoc", i, end);
        i = end;
        continue;
      }
      push("punct", i, i + 1);
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") j += 2;
        else if (c === '"') {
          j++;
          break;
        } else if (c === "\n") break;
        else j++;
      }
      const end = Math.min(j, text.length);
      push(DIGEST.test(text.slice(i, end)) ? "digest" : "string", i, end);
      i = end;
      continue;
    }
    if ((ch === "{" || ch === "[") && isJsonExpected(sig)) {
      const end = scanBalanced(text, i);
      push("json", i, end);
      i = end;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j] ?? "")) j++;
      push("ident", i, j);
      i = j;
      continue;
    }
    push("punct", i, i + 1);
    i++;
  }
  return out;
}

/** Brace depth (0 = file level, 1 = plan body, 2 = artifact body) just before `offset`. */
export function depthAt(tokens: readonly ScanToken[], offset: number): number {
  let depth = 0;
  for (const t of tokens) {
    if (t.start >= offset) break;
    if (t.kind !== "punct") continue;
    if (t.image === "{") depth++;
    else if (t.image === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

export class LineIndex {
  readonly #starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this.#starts.push(i + 1);
    }
  }

  /** 0-based line/character → offset. */
  offsetAt(line: number, character: number): number {
    const start = this.#starts[Math.min(line, this.#starts.length - 1)] ?? 0;
    return start + character;
  }

  /** offset → 0-based line/character. */
  positionAt(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.#starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.#starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - (this.#starts[lo] ?? 0) };
  }

  get lineCount(): number {
    return this.#starts.length;
  }
}
