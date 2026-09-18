/**
 * `.axm` v2 lexer (docs/design/v2-architecture.md §6).
 *
 * Every terminal of the EBNF is a Chevrotain token. Two terminals need custom
 * matchers because they are not regular: `HereDoc` (the terminator is named in
 * the opener) and `Json` (balanced braces/brackets with string awareness).
 * `Json` additionally consults the already-lexed tokens so that the `{` of a
 * `plan … {` or `artifact … {` body is never mistaken for a JSON value: a JSON
 * block is only recognised right after `meta`, after `using QualIdent`, or
 * after `template QualIdent String`.
 */
import { type CustomPatternMatcherReturn, createToken, type IToken, Lexer } from "chevrotain";

// --- categories --------------------------------------------------------------------------------

/** Anything the grammar accepts where EBNF says `Ident` (plain identifiers and every keyword). */
export const IdentLike = createToken({ name: "IdentLike", pattern: Lexer.NA });
/** `Cap` production: `fs | net | secret | ai | compute | git`. */
export const CapKw = createToken({ name: "CapKw", pattern: Lexer.NA });
/** `op` values: `create | overwrite | delete`. */
export const OpValue = createToken({ name: "OpValue", pattern: Lexer.NA });
/** Anything the grammar accepts where EBNF says `String` (a `Digest` is also a string). */
export const StringLike = createToken({ name: "StringLike", pattern: Lexer.NA });

// --- identifiers & keywords ------------------------------------------------------------------

/**
 * Identifiers may start with a digit so every `PlanName` (`^[a-z0-9][a-z0-9-]*$`) and both
 * `mode` literals (`0644`, `0755`) are Idents; the compiler restricts them where the EBNF does.
 */
export const Ident = createToken({
  name: "Ident",
  pattern: /[A-Za-z0-9_][A-Za-z0-9_-]*/,
  categories: [IdentLike],
});

function keyword(name: string, image: string, extra: readonly (typeof IdentLike)[] = []) {
  return createToken({
    name,
    pattern: new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    longer_alt: Ident,
    categories: [IdentLike, ...extra],
  });
}

export const Axiom = keyword("Axiom", "axiom");
export const Plan = keyword("Plan", "plan");
export const Intent = keyword("Intent", "intent");
export const Profile = keyword("Profile", "profile");
export const Capabilities = keyword("Capabilities", "capabilities");
export const Artifact = keyword("Artifact", "artifact");
export const ModeKw = keyword("ModeKw", "mode");
export const OpKw = keyword("OpKw", "op");
export const Inline = keyword("Inline", "inline");
export const Template = keyword("Template", "template");
export const Cas = keyword("Cas", "cas");
export const Ref = keyword("Ref", "ref");
export const Check = keyword("Check", "check");
export const Using = keyword("Using", "using");
export const Meta = keyword("Meta", "meta");
export const Create = keyword("Create", "create", [OpValue]);
export const Overwrite = keyword("Overwrite", "overwrite", [OpValue]);
export const Delete = keyword("Delete", "delete", [OpValue]);
export const Fs = keyword("Fs", "fs", [CapKw]);
export const Net = keyword("Net", "net", [CapKw]);
export const Secret = keyword("Secret", "secret", [CapKw]);
export const Ai = keyword("Ai", "ai", [CapKw]);
export const Compute = keyword("Compute", "compute", [CapKw]);
export const Git = keyword("Git", "git", [CapKw]);

// --- punctuation & literals ------------------------------------------------------------------

export const LCurly = createToken({ name: "LCurly", pattern: /\{/ });
export const RCurly = createToken({ name: "RCurly", pattern: /\}/ });
export const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
export const RBracket = createToken({ name: "RBracket", pattern: /\]/ });
export const Comma = createToken({ name: "Comma", pattern: /,/ });
export const Dot = createToken({ name: "Dot", pattern: /\./ });

/** `'"sha256:' 64*HEXDIG '"'` — listed before `StringLit` so it wins on the same input. */
export const Digest = createToken({
  name: "Digest",
  pattern: /"sha256:[a-f0-9]{64}"/,
  categories: [StringLike],
});

/** Double-quoted string with JSON escapes (decoded by `JSON.parse` in the compiler). */
export const StringLit = createToken({
  name: "StringLit",
  pattern: /"(?:[^"\\\n\r]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/,
  categories: [StringLike],
});

// --- HereDoc --------------------------------------------------------------------------------

const HEREDOC_OPEN = /^<<([A-Za-z_][A-Za-z0-9_-]*)[ \t]*(\r?\n)/;

/**
 * `"<<", Ident, NEWLINE, { ANY }, NEWLINE, Ident`.
 * The terminator must be alone on its line — at column 1, no trailing spaces (a trailing `\r`
 * is tolerated). The content is the raw text between the two newlines with CRLF normalised to
 * LF; it excludes the newline that precedes the terminator, so `<<EOF\nEOF` is the empty
 * string and a file that must end in a newline needs an empty line before the terminator.
 * Returns `null` when unterminated, which surfaces as a lexer error at `<<`.
 */
function matchHereDoc(text: string, offset: number): CustomPatternMatcherReturn | null {
  const open = HEREDOC_OPEN.exec(text.slice(offset, offset + 256));
  if (open === null) return null;
  const terminator = open[1] ?? "";
  let lineStart = offset + open[0].length;
  const bodyStart = lineStart;
  while (lineStart <= text.length) {
    let eol = text.indexOf("\n", lineStart);
    if (eol < 0) eol = text.length;
    let line = text.slice(lineStart, eol);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === terminator) {
      const image = text.slice(offset, eol);
      const raw = text.slice(bodyStart, lineStart);
      // strip the newline that precedes the terminator (absent for an empty body)
      const body = raw.endsWith("\r\n")
        ? raw.slice(0, -2)
        : raw.endsWith("\n")
          ? raw.slice(0, -1)
          : raw;
      const out: CustomPatternMatcherReturn = [image];
      out.payload = { terminator, content: body.replace(/\r\n/g, "\n") };
      return out;
    }
    if (eol >= text.length) break;
    lineStart = eol + 1;
  }
  return null;
}

export const HereDoc = createToken({
  name: "HereDoc",
  pattern: { exec: matchHereDoc },
  line_breaks: true,
  start_chars_hint: ["<"],
});

// --- Json -----------------------------------------------------------------------------------

/** True when the lexed prefix ends in `meta`, `using QualIdent`, or `template QualIdent String`. */
function jsonExpected(tokens: readonly IToken[]): boolean {
  let i = tokens.length - 1;
  const at = (k: number): IToken | undefined => tokens[k];
  const is = (t: IToken | undefined, type: { name: string }): boolean =>
    t !== undefined &&
    (t.tokenType.name === type.name ||
      (t.tokenType.CATEGORIES ?? []).some((c) => c.name === type.name));
  if (is(at(i), Meta)) return true;
  if (is(at(i), StringLike)) i--; // template QualIdent String
  // QualIdent = IdentLike { "." IdentLike }
  if (!is(at(i), IdentLike)) return false;
  i--;
  while (is(at(i), Dot) && is(at(i - 1), IdentLike)) i -= 2;
  return is(at(i), Using) || is(at(i), Template);
}

/** Scan one balanced `{…}` / `[…]` region, string-aware. Returns the end offset or -1. */
export function scanJson(text: string, start: number): number {
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
  return -1;
}

function matchJson(
  text: string,
  offset: number,
  tokens: IToken[],
): CustomPatternMatcherReturn | null {
  const ch = text[offset];
  if ((ch !== "{" && ch !== "[") || !jsonExpected(tokens)) return null;
  const end = scanJson(text, offset);
  if (end < 0) return null;
  return [text.slice(offset, end)];
}

/** `Json = ? RFC 8259 value ?` restricted to objects and arrays (the only unambiguous forms). */
export const JsonBlock = createToken({
  name: "JsonBlock",
  pattern: { exec: matchJson },
  line_breaks: true,
  start_chars_hint: ["{", "["],
});

// --- skipped ---------------------------------------------------------------------------------

export const WhiteSpace = createToken({ name: "WhiteSpace", pattern: /\s+/, group: Lexer.SKIPPED });
export const LineComment = createToken({
  name: "LineComment",
  pattern: /\/\/[^\n\r]*/,
  group: Lexer.SKIPPED,
});
export const BlockComment = createToken({
  name: "BlockComment",
  pattern: /\/\*[\s\S]*?\*\//,
  line_breaks: true,
  group: Lexer.SKIPPED,
});

// --- vocabulary ------------------------------------------------------------------------------

/** Order matters: skipped first, custom matchers before the punctuation they overlap, keywords before Ident. */
export const allTokens = [
  WhiteSpace,
  LineComment,
  BlockComment,
  HereDoc,
  JsonBlock,
  LCurly,
  RCurly,
  LBracket,
  RBracket,
  Comma,
  Dot,
  Digest,
  StringLit,
  Axiom,
  Plan,
  Intent,
  Profile,
  Capabilities,
  Artifact,
  ModeKw,
  OpKw,
  Inline,
  Template,
  Cas,
  Ref,
  Check,
  Using,
  Meta,
  Create,
  Overwrite,
  Delete,
  Fs,
  Net,
  Secret,
  Ai,
  Compute,
  Git,
  Ident,
  IdentLike,
  CapKw,
  OpValue,
  StringLike,
];

export const axmLexer = new Lexer(allTokens, {
  positionTracking: "full",
  ensureOptimizations: false,
  // custom matchers report their own line breaks; skip Chevrotain's line-terminator validation
  skipValidations: false,
});

export interface HereDocPayload {
  terminator: string;
  content: string;
}
