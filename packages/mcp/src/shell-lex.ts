/**
 * shell-lex (v3): the one shell tokenizer shared by the gate and the command rules.
 *
 * Commands reach the gate as raw strings written for PowerShell, bash or cmd. Regexes over that
 * string are bypassed by quoting (`--forc"e"`), PowerShell backtick escapes (`p`ush`), global git
 * options (`git -C . push`), call operators (`& 'git'`), nesting (`bash -c`, `cmd /c`, `iex`,
 * `pwsh -EncodedCommand`) and extra lines. This module turns a command into the simple commands a
 * shell would run, and each of those into words, so rules can match semantically.
 *
 * Quoting differs between shells, so every command is read twice — bash rules and PowerShell
 * rules (plus cmd rules for strings handed to `cmd /c`) — and the union is returned: a command
 * that is dangerous under any plausible reading is seen. Linear in the input; never throws.
 */

/** Marker for a nested command that could not be decoded (bad base64, nesting too deep). */
export const UNDECODABLE = "__axiom_undecodable__";

type Mode = "bash" | "pwsh" | "cmd";
const TOP_MODES: readonly Mode[] = ["bash", "pwsh"];
const CMD_MODES: readonly Mode[] = ["cmd", "bash", "pwsh"];

const MAX_DEPTH = 3;
const MAX_VARIANTS = 16;
const BASH_DQ_ESCAPES = '"\\$`';
const ENV_ASSIGN = /^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*=/i;
const OPEN_PREFIX = /^(?:&|\$\(|@\(|\(|\{)/;
const OPEN_BRACKET = /^(?:\$\(|@\(|\(|\{)/;
const EXE_SUFFIX = /\.(?:exe|cmd|bat|com)$/i;
/** Words that run the rest of the line as a command (`sudo git ...`, `then git ...`). */
const PREFIX_WORDS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "command",
  "builtin",
  "exec",
  "nice",
  "then",
  "do",
  "else",
  "elif",
  "!",
  "call",
]);
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const PWSH = new Set(["pwsh", "powershell", "pwsh-preview"]);
const SHELLS = new Set([...POSIX_SHELLS, ...PWSH, "cmd"]);
const IEX = new Set(["iex", "invoke-expression"]);
const ECHOES = new Set(["echo", "printf", "write-output", "write-host"]);

// ------------------------------------------------------------------------------ scanning --

interface Segment {
  text: string;
  /** The segment reads the previous one's output through a pipe. */
  pipedFrom: boolean;
  /** Heredoc bodies fed to this segment's stdin. */
  heredocs: string[];
}

interface Comment {
  start: number;
  end: number;
  body: string;
}

interface Scan {
  segments: Segment[];
  /** The last shell comment outside quotes and heredoc bodies. */
  comment: Comment | undefined;
}

type Quote = "'" | '"' | "$'" | undefined;

function lineEnd(s: string, from: number): number {
  const j = s.indexOf("\n", from);
  return j === -1 ? s.length : j;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

/** `<<[-]DELIM` / `<<'DELIM'` at `i`: the delimiter and the index after it. */
function heredocAt(s: string, i: number): { delim: string; next: number } | undefined {
  let k = i + 2;
  if (s.charAt(k) === "-") k++;
  while (s.charAt(k) === " " || s.charAt(k) === "\t") k++;
  const q = s.charAt(k);
  if (q === "'" || q === '"') {
    const e = s.indexOf(q, k + 1);
    if (e === -1 || e === k + 1 || e - k > 256) return undefined;
    return { delim: s.slice(k + 1, e), next: e + 1 };
  }
  const m = /^\\?([A-Za-z0-9_.-]+)/.exec(s.slice(k, k + 256));
  if (m === null) return undefined;
  return { delim: m[1] ?? "", next: k + m[0].length };
}

/**
 * Consume heredoc bodies starting at `pos` (the line after the operator). A line whose trimmed
 * text equals the delimiter ends the body — looser than bash, so a body never runs past the
 * point where bash would stop reading it.
 */
function consumeHeredocs(
  s: string,
  pos: number,
  pending: { delim: string; target: string[] }[],
): number {
  let p = pos;
  for (const h of pending) {
    const body: string[] = [];
    while (p < s.length) {
      const e = lineEnd(s, p);
      const line = s.slice(p, e);
      p = e + 1;
      if (line.trim() === h.delim) break;
      body.push(line.replace(/\r$/, ""));
    }
    h.target.push(body.join("\n"));
  }
  pending.length = 0;
  return Math.max(p, pos);
}

/** Escape char outside quotes: bash `\`, PowerShell backtick, cmd caret. */
function escapeChar(mode: Mode): string {
  return mode === "bash" ? "\\" : mode === "pwsh" ? "`" : "^";
}

function scan(s: string, mode: Mode): Scan {
  const segments: Segment[] = [];
  const pending: { delim: string; target: string[] }[] = [];
  const esc = escapeChar(mode);
  let comment: Comment | undefined;
  let cur = "";
  let heredocs: string[] = [];
  let piped = false;
  let quote: Quote;
  const push = (pipeNext: boolean): void => {
    const text = cur.trim();
    if (text !== "") segments.push({ text, pipedFrom: piped, heredocs });
    cur = "";
    heredocs = [];
    piped = pipeNext;
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charAt(i);
    const next = s.charAt(i + 1);
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = undefined;
      i++;
      continue;
    }
    if (quote === "$'") {
      cur += c;
      if (c === "\\" && i + 1 < n) {
        cur += next;
        i += 2;
        continue;
      }
      if (c === "'") quote = undefined;
      i++;
      continue;
    }
    if (quote === '"') {
      cur += c;
      const escapes =
        (mode === "pwsh" && c === "`") ||
        (mode === "bash" && c === "\\" && BASH_DQ_ESCAPES.includes(next));
      if (escapes && i + 1 < n) {
        cur += next;
        i += 2;
        continue;
      }
      if (c === '"') quote = undefined;
      i++;
      continue;
    }
    if (c === esc && i + 1 < n) {
      const crlf = next === "\r" && s.charAt(i + 2) === "\n";
      if (next === "\n" || crlf) {
        cur += " "; // line continuation
        i += crlf ? 3 : 2;
        continue;
      }
      cur += c + next;
      i += 2;
      continue;
    }
    if (c === '"' || (c === "'" && mode !== "cmd")) {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (mode === "bash" && c === "$" && next === "'") {
      quote = "$'";
      cur += "$'";
      i += 2;
      continue;
    }
    if (mode === "pwsh" && c === "@" && (next === "'" || next === '"')) {
      const eol = lineEnd(s, i + 2);
      if (s.slice(i + 2, eol).trim() === "") {
        // PowerShell here-string: the body is data, not commands.
        const close = new RegExp(`\\n[ \\t]*${next}@`, "g");
        close.lastIndex = eol;
        const m = close.exec(s);
        cur += `@${next}${next}@`;
        i = m === null ? n : m.index + m[0].length;
        continue;
      }
    }
    if (mode === "pwsh" && c === "<" && next === "#") {
      const e = s.indexOf("#>", i + 2);
      cur += " ";
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (mode !== "cmd" && c === "#" && (cur === "" || isSpace(cur.charAt(cur.length - 1)))) {
      const e = lineEnd(s, i);
      comment = { start: i, end: e, body: s.slice(i + 1, e) };
      i = e;
      continue;
    }
    if (mode !== "cmd" && c === "<" && next === "<" && s.charAt(i + 2) !== "<") {
      const h = heredocAt(s, i);
      if (h !== undefined) {
        pending.push({ delim: h.delim, target: heredocs });
        cur += s.slice(i, h.next);
        i = h.next;
        continue;
      }
    }
    if (c === "\n") {
      push(false);
      i = consumeHeredocs(s, i + 1, pending);
      continue;
    }
    if (c === ";" && mode !== "cmd") {
      push(false);
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        push(false);
        i += 2;
      } else {
        push(true);
        i++;
      }
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        push(false);
        i += 2;
        continue;
      }
      const prev = cur.charAt(cur.length - 1);
      if (prev === "<" || prev === ">" || next === ">") {
        cur += c; // redirection: 2>&1, &>file
        i++;
        continue;
      }
      push(false);
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push(false);
  return { segments, comment };
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * Split a command into the simple commands a shell would run: on `;`, `&&`, `||`, `|`, `&` and
 * newlines outside quotes. Comments, heredoc bodies and PowerShell here-string bodies are dropped
 * (they are data). The bash and the PowerShell readings are both returned, deduplicated.
 */
export function splitSegments(command: string): string[] {
  return dedupe(TOP_MODES.flatMap((m) => scan(command, m).segments.map((s) => s.text)));
}

// ------------------------------------------------------------------------------- words --

const ANSI_SIMPLE: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
};

/** bash `$'...'` escape at `j` (just after the backslash). */
function ansiEscape(s: string, j: number): { ch: string; next: number } {
  const c = s.charAt(j);
  const mapped = ANSI_SIMPLE[c];
  if (mapped !== undefined) return { ch: mapped, next: j + 1 };
  if (c === "x") {
    const m = /^[0-9A-Fa-f]{1,2}/.exec(s.slice(j + 1, j + 3));
    if (m !== null) {
      return { ch: String.fromCharCode(Number.parseInt(m[0], 16)), next: j + 1 + m[0].length };
    }
  }
  const oct = /^[0-7]{1,3}/.exec(s.slice(j, j + 3));
  if (oct !== null) {
    return { ch: String.fromCharCode(Number.parseInt(oct[0], 8)), next: j + oct[0].length };
  }
  return { ch: c, next: j + 1 };
}

function rawWords(seg: string, mode: Mode): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: Quote;
  const n = seg.length;
  for (let i = 0; i < n; i++) {
    const c = seg.charAt(i);
    const next = seg.charAt(i + 1);
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
      continue;
    }
    if (quote === "$'") {
      if (c === "'") {
        quote = undefined;
      } else if (c === "\\" && i + 1 < n) {
        const r = ansiEscape(seg, i + 1);
        cur += r.ch;
        i = r.next - 1;
      } else {
        cur += c;
      }
      continue;
    }
    if (quote === '"') {
      const escapes =
        (mode !== "cmd" && c === "`") ||
        (mode === "bash" && c === "\\" && BASH_DQ_ESCAPES.includes(next));
      if (c === '"') quote = undefined;
      else if (escapes && i + 1 < n) {
        cur += next;
        i++;
      } else cur += c;
      continue;
    }
    if (isSpace(c)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    if (c === "#" && !inWord && mode !== "cmd") break;
    inWord = true;
    if (c === '"' || (c === "'" && mode !== "cmd")) {
      quote = c;
    } else if (mode === "bash" && c === "$" && (next === "'" || next === '"')) {
      quote = next === "'" ? "$'" : '"';
      i++;
    } else if (i + 1 < n && (c === escapeChar(mode) || c === "`")) {
      // The escape (and a stray backtick in any reading) makes the next char literal.
      cur += next;
      i++;
    } else {
      cur += c;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** Drop a leading `&` call operator and `(` / `$(` / `@(` / `{` openers with their closers. */
function tidy(words: readonly string[]): string[] {
  const w = [...words];
  let opened = 0;
  while (w.length > 0) {
    const first = w[0] ?? "";
    const m = OPEN_PREFIX.exec(first);
    if (m === null) break;
    if (m[0] !== "&") opened++;
    const rest = first.slice(m[0].length);
    if (rest === "") w.shift();
    else w[0] = rest;
  }
  while (opened > 0 && w.length > 0) {
    const last = w[w.length - 1] ?? "";
    const tail = last.charAt(last.length - 1);
    if (tail !== ")" && tail !== "}") break;
    const cut = last.slice(0, -1);
    if (cut === "") w.pop();
    else w[w.length - 1] = cut;
    opened--;
  }
  return w;
}

/**
 * Words of one simple command: quotes joined to adjacent text (`--forc"e"` → `--force`),
 * PowerShell backtick escapes removed outside single quotes (`p`ush` → `push`), bash `$'..'`
 * decoded, a leading `&` call operator and `(` / `$(` openers stripped, comments dropped.
 */
export function shellWords(segment: string): string[] {
  return tidy(rawWords(segment, "bash"));
}

function stripPrefix(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (!ENV_ASSIGN.test(w) && !PREFIX_WORDS.has(w.toLowerCase())) break;
    i++;
  }
  return words.slice(i);
}

/** Basename without `.exe` / `.cmd` / `.bat` / `.com`, case preserved. */
export function programBase(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return word.slice(slash + 1).replace(EXE_SUFFIX, "");
}

/**
 * Program of a word list: basename, lowercased, without `.exe` / `.cmd` / `.bat` / `.com`.
 * Leading env assignments and prefix commands (`sudo`, `env`, `then`, ...) are skipped.
 */
export function programName(words: readonly string[]): string {
  return programBase(stripPrefix(words)[0] ?? "").toLowerCase();
}

function variantsIn(segment: string, modes: readonly Mode[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const add = (w: string[]): void => {
    const s = stripPrefix(w);
    if (s.length === 0 || out.length >= MAX_VARIANTS) return;
    const key = JSON.stringify(s);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const mode of modes) {
    const words = tidy(rawWords(segment, mode));
    add(words);
    for (let i = 1; i < words.length && out.length < MAX_VARIANTS; i++) {
      const w = words[i] ?? "";
      if (w === "=") add(tidy(words.slice(i + 1)));
      else if (OPEN_BRACKET.test(w)) add(tidy(words.slice(i)));
    }
  }
  return out;
}

/**
 * Every word list a segment may run, under the bash and PowerShell readings: the command itself
 * plus what follows `=` (PowerShell `$x = git ...`) or an opener (`(git ...)`, `$(git ...)`).
 * Env assignments and prefix commands are stripped from each.
 */
export function wordVariants(segment: string): string[][] {
  return variantsIn(segment, TOP_MODES);
}

// --------------------------------------------------------------------------------- git --

/** Global git options that take a separate value (`git -C <dir> push`). */
const GIT_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

/**
 * For a git invocation: skip global options (`-C <v>`, `-c <v>`, `--git-dir[=]<v>`,
 * `--work-tree`, `--no-pager`, `-P`, `--paginate`, `--bare`, `--namespace`, ...) and return the
 * subcommand (lowercased) with the remaining args. `undefined` when the program is not git.
 */
export function normalizeGit(
  words: readonly string[],
): { sub: string | undefined; args: string[] } | undefined {
  const w = stripPrefix(words);
  if (programName(w) !== "git") return undefined;
  for (let i = 1; i < w.length; i++) {
    const a = w[i] ?? "";
    if (!a.startsWith("-")) return { sub: a.toLowerCase(), args: w.slice(i + 1) };
    if (GIT_VALUE_OPTS.has(a)) i++;
  }
  return { sub: undefined, args: [] };
}

// ------------------------------------------------------------------------------ nesting --

interface Nested {
  text: string;
  modes: readonly Mode[];
}

function decodeEncodedCommand(b64: string | undefined): string {
  if (b64 === undefined) return UNDECODABLE;
  const clean = b64.replace(/\s+/g, "");
  if (clean === "" || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    return UNDECODABLE;
  }
  const buf = Buffer.from(clean, "base64");
  if (buf.length % 2 !== 0) return UNDECODABLE;
  const text = buf.toString("utf16le").replace(/^\ufeff/, "");
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const control = code < 0x20 && ch !== "\t" && ch !== "\n" && ch !== "\r";
    if (control || code === 0xfffd) return UNDECODABLE;
  }
  return text;
}

const PWSH_VALUE_OPTS = [
  "-executionpolicy",
  "-workingdirectory",
  "-windowstyle",
  "-outputformat",
  "-inputformat",
  "-configurationname",
  "-configurationfile",
  "-settingsfile",
  "-custompipename",
  "-encodedarguments",
];
const PWSH_VALUE_ALIASES = new Set(["-ep", "-ex", "-wd", "-w", "-o", "-of", "-if", "-in", "-ea"]);

function abbrev(name: string, full: string, min: number): boolean {
  return name.length >= min && full.startsWith(name);
}

function pwshNested(prog: string, args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const raw = args[i] ?? "";
    if (!raw.startsWith("-") && !raw.startsWith("/")) {
      // powershell.exe treats the first bare word as -Command; pwsh treats it as -File.
      return prog === "powershell" ? [args.slice(i).join(" ")] : [];
    }
    const name = raw.toLowerCase().replace(/^(?:--|\/)/, "-");
    if (name === "-c" || abbrev(name, "-command", 4)) return [args.slice(i + 1).join(" ")];
    if (name === "-e" || name === "-ec" || abbrev(name, "-encodedcommand", 3)) {
      return [decodeEncodedCommand(args[i + 1])];
    }
    if (name === "-f" || abbrev(name, "-file", 3)) return [];
    if (PWSH_VALUE_ALIASES.has(name) || PWSH_VALUE_OPTS.some((o) => abbrev(name, o, 4))) i++;
  }
  return [];
}

function posixShellNested(args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-o" || a === "-O" || a === "+o" || a === "+O") {
      i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes("c")) return [args[i + 1] ?? ""];
      continue;
    }
    if (a.startsWith("--")) continue;
    return []; // a script file
  }
  return [];
}

function cmdNested(args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("/")) return [];
    if (/^\/[ck]/i.test(a)) {
      return [[a.slice(2), ...args.slice(i + 1)].filter((x) => x !== "").join(" ")];
    }
  }
  return [];
}

function iexNested(args: readonly string[]): string[] {
  const rest = args.filter((a, i) => !(i === 0 && abbrev(a.toLowerCase(), "-command", 2)));
  const text = rest.join(" ");
  // Only literals can be checked; `iex $cmd` / `iex (irm url)` are out of reach.
  return text === "" || text.startsWith("$") || text.startsWith("(") ? [] : [text];
}

const XARGS_VALUE = new Set(["-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a"]);
const WSL_VALUE = new Set(["-d", "--distribution", "-u", "--user", "--cd"]);
const WSL_EXEC = new Set(["-e", "--exec", "--"]);
const NO_EXEC = new Set<string>();

function restAfterOptions(
  args: readonly string[],
  valueOpts: ReadonlySet<string>,
  execOpts: ReadonlySet<string>,
): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (execOpts.has(a)) return [args.slice(i + 1).join(" ")];
    if (valueOpts.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return [args.slice(i).join(" ")];
  }
  return [];
}

/** Command strings a segment runs inside another interpreter (`bash -c`, `cmd /c`, `iex`, ...). */
function nestedIn(segment: string, modes: readonly Mode[]): Nested[] {
  const out: Nested[] = [];
  const seen = new Set<string>();
  const add = (texts: string[], m: readonly Mode[]): void => {
    for (const text of texts) {
      if (text.trim() === "" || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, modes: m });
    }
  };
  for (const v of variantsIn(segment, modes)) {
    const prog = programName(v);
    const args = v.slice(1);
    if (PWSH.has(prog)) add(pwshNested(prog === "powershell" ? prog : "pwsh", args), TOP_MODES);
    else if (POSIX_SHELLS.has(prog)) add(posixShellNested(args), TOP_MODES);
    else if (prog === "cmd") add(cmdNested(args), CMD_MODES);
    else if (IEX.has(prog)) add(iexNested(args), TOP_MODES);
    else if (prog === "xargs") add(restAfterOptions(args, XARGS_VALUE, NO_EXEC), TOP_MODES);
    else if (prog === "wsl") add(restAfterOptions(args, WSL_VALUE, WSL_EXEC), TOP_MODES);
  }
  return out;
}

/**
 * The segment plus every command nested inside it — `cmd /c`, `bash -c`, `sh -c`,
 * `pwsh|powershell -c|-Command`, `-EncodedCommand|-enc|-e <base64 UTF-16LE>`,
 * `iex|Invoke-Expression '<literal>'` — split into segments, recursively. A nested command that
 * cannot be decoded, or nesting deeper than `depth`, yields `UNDECODABLE`.
 */
export function expandNested(segment: string, depth = MAX_DEPTH): string[] {
  return dedupe([segment, ...commandUnits(segment, depth).map((u) => u.text)]);
}

export interface CommandUnit {
  /** One simple command, or `UNDECODABLE`. */
  text: string;
  /** It runs inside another interpreter (or from a heredoc / pipe into a shell). */
  nested: boolean;
  /** Its word lists under every applicable shell reading (see `wordVariants`). */
  variants: string[][];
}

function readsStdin(variants: readonly string[][]): boolean {
  return variants.some((v) => {
    const p = programName(v);
    if (!SHELLS.has(p) && !IEX.has(p)) return false;
    return v.slice(1).every((a) => a.startsWith("-") || a.startsWith("/"));
  });
}

/** Text an `echo 'x'` / `'x'` segment writes to stdout, when it is a literal. */
function literalOutput(segment: string, modes: readonly Mode[]): string | undefined {
  for (const v of variantsIn(segment, modes)) {
    if (ECHOES.has(programName(v))) {
      return v
        .slice(1)
        .filter((a) => !/^-[neEs]+$/.test(a))
        .join(" ")
        .replace(/\\n/g, "\n");
    }
    const first = segment.charAt(0);
    if (v.length === 1 && (first === "'" || first === '"')) return v[0];
  }
  return undefined;
}

function unitsOf(
  command: string,
  modes: readonly Mode[],
  depth: number,
  nested: boolean,
  out: Map<string, CommandUnit>,
): void {
  for (const mode of modes) {
    const { segments } = scan(command, mode);
    segments.forEach((seg, i) => {
      const key = `${nested ? 1 : 0}${seg.text}`;
      const variants = variantsIn(seg.text, modes);
      if (!out.has(key)) out.set(key, { text: seg.text, nested, variants });
      const inner = nestedIn(seg.text, modes);
      if (seg.heredocs.length > 0 && variants.some((v) => SHELLS.has(programName(v)))) {
        for (const text of seg.heredocs) inner.push({ text, modes: TOP_MODES });
      }
      const prev = segments[i - 1];
      if (seg.pipedFrom && prev !== undefined && readsStdin(variants)) {
        const lit = literalOutput(prev.text, modes);
        if (lit !== undefined && lit.trim() !== "") inner.push({ text: lit, modes: TOP_MODES });
      }
      for (const n of inner) {
        if (n.text === UNDECODABLE || depth <= 0) {
          out.set(`1${UNDECODABLE}`, { text: UNDECODABLE, nested: true, variants: [] });
        } else {
          unitsOf(n.text, n.modes, depth - 1, true, out);
        }
      }
    });
  }
}

/**
 * Every simple command `command` runs: its segments, commands nested in other interpreters (to
 * `depth` levels), heredoc bodies fed to a shell and literals piped into a shell or `iex`.
 * Deduplicated; an undecodable or too-deep nested command appears as `UNDECODABLE`.
 */
export function commandUnits(command: string, depth = MAX_DEPTH): CommandUnit[] {
  const out = new Map<string, CommandUnit>();
  unitsOf(command, TOP_MODES, depth, false, out);
  return [...out.values()];
}

// ----------------------------------------------------------------------------- override --

const OVERRIDE_BODY = /^\s*axiom-override:\s*(.*)$/i;
const MAX_REASON = 300;

function validReason(reason: string): boolean {
  if (reason === "" || reason.length > MAX_REASON) return false;
  const words = reason.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = reason.match(/\p{L}/gu)?.length ?? 0;
  return words.length >= 3 && letters >= 12;
}

function trailingOverride(command: string): { reason: string; start: number } | undefined {
  const a = scan(command, "bash").comment;
  const b = scan(command, "pwsh").comment;
  // Both readings must agree the comment is outside quotes, and nothing may follow it.
  if (a === undefined || b === undefined || a.start !== b.start) return undefined;
  if (command.slice(a.end).trim() !== "") return undefined;
  const m = OVERRIDE_BODY.exec(a.body);
  if (m === null) return undefined;
  const reason = (m[1] ?? "").trim();
  return validReason(reason) ? { reason, start: a.start } : undefined;
}

/**
 * The reason of a trailing `# axiom-override: <reason>` shell comment — outside quotes and
 * heredoc bodies, the last thing in the command. The reason needs ≥ 3 words with letters and
 * ≥ 12 letters, ≤ 300 chars; otherwise `undefined`.
 */
export function findTrailingOverride(command: string): string | undefined {
  return trailingOverride(command)?.reason;
}

/** `command` without its trailing override comment (unchanged when there is none). */
export function stripTrailingOverride(command: string): string {
  const o = trailingOverride(command);
  return o === undefined ? command : command.slice(0, o.start).trimEnd();
}
