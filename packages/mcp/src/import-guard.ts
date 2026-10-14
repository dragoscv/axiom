/**
 * `axiom import-guard` (v2.6, S-1216): convert the rule tables of a PowerShell PreToolUse guard
 * into `command.deny` rules. Every `@{ ... }` / `[ordered]@{ ... }` hashtable whose entries are
 * `'regex' = "reason"` becomes a list of rules; .NET-only regex constructs are reported in
 * `skipped` with the reason instead of being translated approximately.
 *
 * Pure text in, data out: no filesystem, no PowerShell needed. The CLI verb reads the file and
 * prints `importGuardProfile(text)` as JSON for `.axiom/gate-profile.json`.
 */
import { type CommandRule, CommandRuleSchema, type CommandsConfig } from "./command-rules.js";

export interface ImportedGuard {
  rules: CommandRule[];
  skipped: { line: number; text: string; why: string }[];
}

interface Quoted {
  value: string;
  end: number;
  /** Unsupported content (interpolation), when the literal cannot be taken verbatim. */
  why?: string;
}

/** Parse a PowerShell string literal starting at `text[i]` (a `'` or `"`). */
function readQuoted(text: string, i: number): Quoted | undefined {
  const q = text[i];
  if (q !== "'" && q !== '"') return undefined;
  let value = "";
  let why: string | undefined;
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j] as string;
    if (ch === q) {
      if (text[j + 1] === q) {
        value += q;
        j += 2;
        continue;
      }
      const out: Quoted = { value, end: j + 1 };
      if (why !== undefined) out.why = why;
      return out;
    }
    if (q === '"' && ch === "`" && j + 1 < text.length) {
      const nx = text[j + 1] as string;
      value += nx === "n" ? "\n" : nx === "t" ? "\t" : nx === "r" ? "\r" : nx === "0" ? "\0" : nx;
      j += 2;
      continue;
    }
    if (q === '"' && ch === "$" && /[A-Za-z_({]/.test(text[j + 1] ?? "")) {
      why = "double-quoted string with variable interpolation";
    }
    value += ch;
    j++;
  }
  return undefined;
}

/** Index just past the `}` closing the hashtable whose `{` is at `open`, or -1. */
function closeBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"') {
      const q = readQuoted(text, i);
      if (!q) return -1;
      i = q.end;
      continue;
    }
    if (ch === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function restOfLine(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
}

interface RawEntry {
  line: number;
  key: string;
  value: string;
  text: string;
  why?: string;
}

/** Entries of one hashtable body; `undefined` when it has no quoted-key entry (not a rule table). */
function parseTable(
  text: string,
  start: number,
  end: number,
): { entries: RawEntry[]; bad: ImportedGuard["skipped"] } | undefined {
  const entries: RawEntry[] = [];
  const bad: ImportedGuard["skipped"] = [];
  let i = start;
  while (i < end) {
    const ch = text[i] as string;
    if (/\s|;/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      i = restOfLine(text, i);
      continue;
    }
    const line = lineAt(text, i);
    const eol = Math.min(restOfLine(text, i), end);
    const key = readQuoted(text, i);
    if (!key) {
      bad.push({ line, text: text.slice(i, eol).trim(), why: "entry key is not a quoted string" });
      i = eol + 1;
      continue;
    }
    let j = key.end;
    while (j < end && /[ \t]/.test(text[j] as string)) j++;
    if (text[j] !== "=") {
      bad.push({ line, text: text.slice(i, eol).trim(), why: "expected `=` after the key" });
      i = eol + 1;
      continue;
    }
    j++;
    while (j < end && /[ \t]/.test(text[j] as string)) j++;
    const value = readQuoted(text, j);
    const why = key.why ?? value?.why;
    if (!value || value.end > end) {
      bad.push({ line, text: text.slice(i, eol).trim(), why: "value is not a string literal" });
      i = eol + 1;
      continue;
    }
    const entry: RawEntry = {
      line,
      key: key.value,
      value: value.value,
      text: text.slice(i, value.end),
    };
    if (why !== undefined) entry.why = why;
    entries.push(entry);
    i = value.end;
  }
  return entries.length > 0 ? { entries, bad } : undefined;
}

/** Translate a .NET regex to JS source, or explain why it cannot be translated faithfully. */
export function dotnetToJsRegex(src: string): { source: string } | { why: string } {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (ch === "\\") {
      const nx = src[i + 1];
      if (nx === undefined) return { why: "trailing backslash" };
      if (!inClass && nx === "A") out += "^";
      else if (!inClass && (nx === "z" || nx === "Z")) out += "$";
      else if (nx === "G") return { why: "\\G anchor is not supported in JS" };
      else if (nx === "p" || nx === "P") return { why: "Unicode category \\p{} needs the u flag" };
      else out += ch + nx;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "-" && src[i + 1] === "[") {
        return { why: "character class subtraction is .NET-only" };
      }
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      if (src[i + 1] === "^") out += src[++i];
      if (src[i + 1] === "]") out += src[++i];
      continue;
    }
    if (ch === "(" && src[i + 1] === "?") {
      const rest = src.slice(i + 2);
      const inline = /^([imnsx]*)(?:-([imnsx]+))?([:)])/.exec(rest);
      if (inline && (inline[1] !== "" || inline[2] !== undefined)) {
        const on = inline[1] ?? "";
        if (inline[2] !== undefined || /[mnsx]/.test(on)) {
          return { why: `inline option (?${inline[0].slice(0, -1)}) has no JS equivalent` };
        }
        // `(?i)` / `(?i:` - matching is already case-insensitive by default.
        if (inline[3] === ")") {
          i += 2 + inline[0].length - 1;
        } else {
          out += "(?:";
          i += 2 + inline[0].length - 1;
        }
        continue;
      }
      if (rest.startsWith(">")) return { why: "atomic group (?>...) is not supported in JS" };
      if (rest.startsWith("'")) return { why: "(?'name'...) group syntax is .NET-only" };
      if (/^<[A-Za-z_]\w*-/.test(rest) || /^<-/.test(rest)) {
        return { why: "balancing group (?<a-b>...) is .NET-only" };
      }
      if (rest.startsWith("(")) return { why: "conditional (?(...)...) is .NET-only" };
      if (rest.startsWith("#")) return { why: "inline comment (?#...) is .NET-only" };
    }
    if ((ch === "*" || ch === "+" || ch === "?" || ch === "}") && src[i + 1] === "+") {
      return { why: "possessive quantifier is not supported in JS" };
    }
    out += ch;
  }
  return { source: out };
}

export function importGuard(ps1Text: string): ImportedGuard {
  const rules: CommandRule[] = [];
  const skipped: ImportedGuard["skipped"] = [];
  let n = 0;
  let from = 0;
  for (;;) {
    const at = ps1Text.indexOf("@{", from);
    if (at < 0) break;
    const open = at + 1;
    const end = closeBrace(ps1Text, open);
    if (end < 0) {
      skipped.push({
        line: lineAt(ps1Text, at),
        text: ps1Text.slice(at, restOfLine(ps1Text, at)).trim(),
        why: "unterminated hashtable",
      });
      break;
    }
    const table = parseTable(ps1Text, open + 1, end - 1);
    if (!table) {
      from = open + 1; // not a rule table: look for rule tables nested inside it
      continue;
    }
    skipped.push(...table.bad);
    for (const e of table.entries) {
      if (e.why !== undefined) {
        skipped.push({ line: e.line, text: e.text, why: e.why });
        continue;
      }
      const js = dotnetToJsRegex(e.key);
      if ("why" in js) {
        skipped.push({ line: e.line, text: e.text, why: js.why });
        continue;
      }
      const parsed = CommandRuleSchema.safeParse({
        id: `imported.${n + 1}`,
        pattern: js.source,
        reason: e.value,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        skipped.push({ line: e.line, text: e.text, why: issue ? issue.message : "invalid rule" });
        continue;
      }
      n++;
      rules.push(parsed.data);
    }
    from = end;
  }
  return { rules, skipped };
}

export function importGuardProfile(ps1Text: string): {
  commands: CommandsConfig;
  skipped: ImportedGuard["skipped"];
} {
  const { rules, skipped } = importGuard(ps1Text);
  return { commands: { deny: rules, pack: "none" }, skipped };
}
