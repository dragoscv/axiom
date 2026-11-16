/**
 * Shell write-target scan (moved out of gate.ts in 4.0 so the gate core and the shell
 * classifier evolve separately): the paths a shell command would write or delete, as written.
 * A documented heuristic (D-18), not a shell parser — the Plan -> apply path is the guarantee.
 *
 * 4.0 (S-1409): a command is read under the PowerShell reading on Windows (`\` is a separator,
 * never an escape), tokens are expanded through `ShellScanOptions.home`, a leading
 * `cd` / `Set-Location` / `pushd` / `git -C` moves the relative operands that follow, trailing
 * dots and spaces are stripped per segment, and only real paths are returned.
 */
import { homedir } from "node:os";
import {
  expandNested,
  normalizeGit,
  programName,
  redirectTargets,
  type ShellMode,
  splitSegments,
  stripTrailingOverride,
  wordReadings,
} from "./shell-lex.js";
export interface GateTarget {
  /** Path as the agent supplied it (absolute or relative to cwd). */
  rawPath: string;
  /** New content when the payload carries it (full file, replacement string or `+` lines). */
  content: string | undefined;
  op: "write" | "delete";
  /**
   * 4.0 contract: the operation removes or replaces a whole directory tree (`rm -r`,
   * `Remove-Item -Recurse`, `rd /s`, `find -delete`, `git clean`). The gate core uses it for the
   * built-in tree-delete protection and for the bounded pre-delete snapshot.
   */
  recursive?: boolean;
  /**
   * 4.0 contract: `rawPath` is the POINTEE of a link being created (`ln`, `mklink`,
   * `New-Item -ItemType SymbolicLink|Junction|HardLink`, `fsutil hardlink create`). A link is a
   * second name for the pointee, so the pointee is judged as a write.
   */
  linkTo?: boolean;
  /**
   * 4.0 contract: the command resets or cleans the WHOLE work tree (`git clean -f…`,
   * `git reset --hard`, `git checkout -- .`, `git restore .`). `rawPath` is `.`. A plain `.`
   * operand of any other command (`Copy-Item . dest`, `ls .`) never sets it.
   */
  wholeTree?: boolean;
}

/** 4.0 contract: context the shell scan needs to turn a token into a path. */
export interface ShellScanOptions {
  /** Home directory: `~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%` expand to it. */
  home?: string;
  /** Windows semantics for `\` (a separator, never an escape) — default: `process.platform === "win32"`. */
  win32?: boolean;
}

// ------------------------------------------------------------ shell scan --

/**
 * Write primitives a shell command may contain. Each rule names the operand positions that
 * are *paths being written*. This is a documented heuristic (D-18), not a shell parser: it
 * catches the common agent idioms (`echo x > .env`, `rm -rf .git`, `sed -i … file`,
 * `git checkout -- file`) and is bypassable by construction; the full Plan→apply path is the
 * guarantee, the gate is the seatbelt.
 */
interface WriteRule {
  /** Flags are `-`-prefixed (a `/x` switch is filtered for the cmd.exe built-ins separately). */
  skipFlags: boolean;
  /** Operand positions that name a path: every one, the last (destination), or after `-i`. */
  operands: "all" | "last" | "afterI";
}

const WRITE_CMDS: Record<string, WriteRule> = {
  tee: { skipFlags: true, operands: "all" },
  rm: { skipFlags: true, operands: "all" },
  rmdir: { skipFlags: true, operands: "all" },
  mv: { skipFlags: true, operands: "last" },
  cp: { skipFlags: true, operands: "last" },
  touch: { skipFlags: true, operands: "all" },
  truncate: { skipFlags: true, operands: "all" },
  mkdir: { skipFlags: true, operands: "all" },
  ln: { skipFlags: true, operands: "last" },
  chmod: { skipFlags: true, operands: "all" },
  unlink: { skipFlags: true, operands: "all" },
  install: { skipFlags: true, operands: "last" },
  dd: { skipFlags: false, operands: "all" },
  sed: { skipFlags: true, operands: "afterI" },
  "remove-item": { skipFlags: true, operands: "all" },
  ri: { skipFlags: true, operands: "all" },
  rd: { skipFlags: true, operands: "all" },
  "set-content": { skipFlags: true, operands: "all" },
  sc: { skipFlags: true, operands: "all" },
  "add-content": { skipFlags: true, operands: "all" },
  ac: { skipFlags: true, operands: "all" },
  "clear-content": { skipFlags: true, operands: "all" },
  clc: { skipFlags: true, operands: "all" },
  "out-file": { skipFlags: true, operands: "all" },
  "move-item": { skipFlags: true, operands: "all" },
  mi: { skipFlags: true, operands: "all" },
  "copy-item": { skipFlags: true, operands: "all" },
  ci: { skipFlags: true, operands: "all" },
  cpi: { skipFlags: true, operands: "all" },
  "new-item": { skipFlags: true, operands: "all" },
  ni: { skipFlags: true, operands: "all" },
  "start-process": { skipFlags: true, operands: "all" },
  del: { skipFlags: true, operands: "all" },
  erase: { skipFlags: true, operands: "all" },
  move: { skipFlags: true, operands: "last" },
  copy: { skipFlags: true, operands: "last" },
};
/** PowerShell aliases that map to a delete. */
const DELETE_CMDS = new Set(["rm", "rmdir", "unlink", "del", "erase", "remove-item", "ri", "rd"]);
/** Programs that move the shell into a directory: the operands after them are relative to it. */
const CD_CMDS = new Set(["cd", "chdir", "set-location", "pushd", "push-location"]);
/** PowerShell cmdlet aliases that do not contain a `-`. */
const CMDLET_ALIASES = new Set(["ri", "rd", "sc", "ac", "mi", "ci", "cpi", "ni", "clc"]);
/** cmd.exe built-ins: a `/x` token is a switch, never a path. */
const CMD_BUILTINS = new Set([
  "rd",
  "rmdir",
  "del",
  "erase",
  "move",
  "copy",
  "mklink",
  "fsutil",
  "xcopy",
  "robocopy",
  "attrib",
  "md",
  "mkdir",
  "ren",
  "rename",
  "cmd",
  "start",
]);
/** Positional operands of a cmdlet that name a path (the default is every positional operand). */
const CMDLET_OPERANDS: Record<string, "all" | "first" | "last"> = {
  "set-content": "first",
  sc: "first",
  "add-content": "first",
  ac: "first",
  "clear-content": "first",
  clc: "first",
  "out-file": "first",
  "copy-item": "last",
  ci: "last",
  cpi: "last",
  "move-item": "last",
  mi: "last",
};
/** Named parameters whose VALUE is a path being written. */
const PATH_PARAMS = new Set([
  "path",
  "literalpath",
  "filepath",
  "destination",
  "newname",
  "target",
  "redirectstandardoutput",
  "redirectstandarderror",
]);
/**
 * Named parameters that take a value. Every one must be listed: an unlisted parameter's value
 * becomes a positional operand (a flag value reported as a path, OPS-18), and a listed one that
 * does NOT is consumed twice (a real path lost).
 */
const VALUE_PARAMS = new Set([
  ...PATH_PARAMS,
  "value",
  "inputobject",
  "encoding",
  "filter",
  "include",
  "exclude",
  "itemtype",
  "name",
  "credential",
  "erroraction",
  "errorvariable",
  "warningaction",
  "warningvariable",
  "informationaction",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
  "progressaction",
  "delimiter",
  "stream",
  "separator",
  "width",
  "argumentlist",
  "verb",
  "windowstyle",
  "workingdirectory",
  "environment",
  "username",
  "password",
  "domain",
  "attributes",
]);
/** A positional operand that opens a nested expression: the rest belongs to that command. */
const OPEN_EXPR = /^(?:\$\(|@\(|\(|\{|\$\{)/;
/** `.NET` static calls whose first argument is the path being written or deleted. */
const DOTNET_CALL = /\[(?:System\.)?(?:IO\.)?(File|Directory)\]\s*::\s*([A-Za-z]+)\s*\(/g;

// ------------------------------------------------------------ path shaping --

/** Environment forms that name a directory relative to `ShellScanOptions.home`. */
const HOME_REL: ReadonlyMap<string, string> = new Map([
  ["~", ""],
  ["home", ""],
  ["userprofile", ""],
  ["homepath", ""],
  ["appdata", "AppData/Roaming"],
  ["localappdata", "AppData/Local"],
]);

const VAR_PREFIXES: readonly RegExp[] = [
  /^~(?=[\\/]|$)/,
  /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?=[\\/]|$)/,
  /^\$env:([A-Za-z_][A-Za-z0-9_]*)(?=[\\/]|$)/i,
  /^\$([A-Za-z_][A-Za-z0-9_]*)(?=[\\/]|$)/,
  /^%([A-Za-z_][A-Za-z0-9_]*)%(?=[\\/]|$)/,
];

/** A cmd.exe `/x` switch (never a path for the cmd built-ins). */
const CMD_SWITCH = /^\/[A-Za-z]{1,3}$/;

function resolveHome(opts: ShellScanOptions | undefined): string | undefined {
  const given = opts?.home;
  if (given !== undefined && given !== "") return given;
  const env = process.env.HOME ?? process.env.USERPROFILE;
  return env !== undefined && env !== "" ? env : homedir() || undefined;
}

function isAbsolutePath(p: string): boolean {
  return /^[\\/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

/** A relative token moved into the directory a leading `cd` selected. */
function withCwd(word: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "" || isAbsolutePath(word)) return word;
  return joinPath(cwd, word);
}

/** `~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`, `%USERPROFILE%` and `$PWD` as a real path. */
function expandToken(word: string, home: string | undefined, cwd: string | undefined): string {
  let key: string | undefined;
  let rest = word;
  for (const re of VAR_PREFIXES) {
    const m = re.exec(word);
    if (m === null) continue;
    key = (m[1] ?? "~").toLowerCase();
    rest = word.slice(m[0].length);
    break;
  }
  if (key === undefined) return word;
  if (key === "pwd" || key === "cd") return rest === "" ? "." : `.${rest}`;
  const rel = HOME_REL.get(key);
  if (rel === undefined || home === undefined || home === "") return word; // opaque variable
  const base = rel === "" ? home : joinPath(home, rel);
  const abs = rest === "" ? base : joinPath(base, rest);
  return isAbsolutePath(abs) ? abs : withCwd(abs, cwd);
}

/** Win32 strips trailing dots and spaces per segment (`probe.` writes `probe`, `.env.` -> `.env`). */
function cleanSegment(s: string): string {
  if (/^\.+$/.test(s)) return s; // `.` and `..` are not trailing-dot names
  const t = s.replace(/[ .\u00a0]+$/u, "");
  return t === "" ? s : t;
}

function shapePath(raw: string): string {
  return raw
    .split(/([\\/])/)
    .map((p) => (p === "\\" || p === "/" ? p : cleanSegment(p)))
    .join("");
}

/** A token that is not a path: a flag, a substitution, a bracket, a leftover variable. */
function isPathLike(word: string): boolean {
  if (word === "" || word === "-" || word === "--") return false;
  if (/^[({[\])}!=+<>*?|&;,]/.test(word)) return false;
  if (/[()}\]]$/.test(word)) return false;
  if (word.startsWith("`") || word.includes("$(") || word.includes("${")) return false;
  if (/^\\?\$/.test(word) || /^%[A-Za-z_][A-Za-z0-9_]*%/.test(word)) return false;
  return true;
}

/** `dir/*` and `*` name every entry of a directory: a recursive delete of the directory itself. */
function everyEntryGlob(word: string): string | undefined {
  if (word === "*") return ".";
  const m = /^(.*?)[\\/]\*$/.exec(word);
  if (m === null) return undefined;
  return m[1] === "" ? "." : m[1];
}

/** Top-level arguments of a call whose `(` is at `open`, in order, as written. */
function callArguments(s: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let text = "";
  for (let i = open + 1; i < s.length; i++) {
    const c = s.charAt(i);
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      text += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      text += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) {
      out.push(text.trim());
      text = "";
      continue;
    }
    text += c;
  }
  if (text.trim() !== "") out.push(text.trim());
  return out;
}

/** The path one argument literal names (`"$PWD\\.env"` -> `$PWD\\.env`), or `undefined`. */
function argumentPath(arg: string | undefined): string | undefined {
  if (arg === undefined) return undefined;
  const t = arg.trim();
  const str = /^"([^"]*)"$/.exec(t) ?? /^'([^']*)'$/.exec(t);
  if (str !== null) return str[1] ?? "";
  return t !== "" && /^[A-Za-z0-9_.~$\\/:%{}-]+$/.test(t) ? t : undefined;
}

/**
 * Paths a shell command would write/delete, as written (with `~` / `$HOME` / `$env:USERPROFILE`
 * expanded through `opts.home` and a leading `cd` applied to the operands that follow). Empty when
 * the command has no recognised write primitive; a token that is not a path is never returned.
 */
export function extractShellWriteTargets(command: string, opts?: ShellScanOptions): GateTarget[] {
  const win32 = opts?.win32 ?? process.platform === "win32";
  const home = resolveHome(opts);
  /** On Windows the PowerShell reading decides: a backslash is a separator, never an escape. */
  const modes: readonly ShellMode[] = win32 ? ["pwsh"] : ["bash", "pwsh"];
  const out: GateTarget[] = [];
  const byKey = new Map<string, GateTarget>();
  /** The `cd` / `Set-Location` / `pushd` / `git -C` in force for the operands that follow it. */
  let cwd: string | undefined;

  const push = (
    rawPath: string,
    op: "write" | "delete",
    flags?: { recursive?: boolean; linkTo?: boolean; wholeTree?: boolean },
  ): void => {
    const shaped = shapePath(rawPath);
    if (!isPathLike(shaped)) return;
    const key = `${op}:${shaped}`;
    const known = byKey.get(key);
    if (known !== undefined) {
      // The same path reached twice (a named parameter and the pointee of a link, say) keeps
      // every flag either form carried.
      if (flags?.recursive === true) known.recursive = true;
      if (flags?.linkTo === true) known.linkTo = true;
      if (flags?.wholeTree === true) known.wholeTree = true;
      return;
    }
    const entry: GateTarget = {
      rawPath: shaped,
      op,
      content: undefined,
      ...(flags?.recursive === true ? { recursive: true } : {}),
      ...(flags?.linkTo === true ? { linkTo: true } : {}),
      ...(flags?.wholeTree === true ? { wholeTree: true } : {}),
    };
    byKey.set(key, entry);
    out.push(entry);
  };
  const target = (
    word: string,
    op: "write" | "delete",
    flags?: { recursive?: boolean; linkTo?: boolean; wholeTree?: boolean },
  ): void => {
    if (word === "." || word === "./" || word === ".\\") {
      // A bare `.` is the cwd: no target at all (OPS-2), except the git forms that clean the
      // whole tree and a recursive DELETE of it (`rm -rf .`, `Remove-Item -Recurse .` — a
      // recursive copy INTO `.` is an ordinary in-root write).
      if (flags?.wholeTree === true) push(".", op, flags);
      else if (flags?.recursive === true && op === "delete") push(".", op, { recursive: true });
      return;
    }
    if (flags?.recursive === true && op === "delete") {
      const dir = everyEntryGlob(word);
      if (dir !== undefined) {
        push(withCwd(expandToken(dir, home, cwd), cwd), op, { recursive: true });
        return;
      }
    }
    push(withCwd(expandToken(word, home, cwd), cwd), op, flags);
  };
  // Every segment (split on ; & | && || and newlines, heredoc bodies dropped) plus the
  // commands nested in `cmd /c`, `bash -c`, `pwsh -Command`, `-EncodedCommand`, `iex '…'`.
  const segments = splitSegments(stripTrailingOverride(command)).flatMap((s) => expandNested(s));
  /** Every simple command the scan reads, with the `cd` in force at that point of the command. */
  const units: { words: string[]; at: string | undefined }[] = [];
  for (const seg of segments) {
    const readings = wordReadings(seg, modes);
    // `cd <dir>` moves this segment's targets and every one after it (OPS-13). Resolved here,
    // in command order, so a redirect that follows the `cd` lands in the right directory.
    for (const r of readings) {
      if (!CD_CMDS.has(programName(r.words))) continue;
      const dir = r.words.slice(1).find((w) => !w.startsWith("-") && w !== "");
      if (dir !== undefined) cwd = withCwd(expandToken(dir, home, cwd), cwd);
      break;
    }
    // Redirection targets (`echo x> .env`, `cmd /c "echo x> .env"`, `>| .env`).
    for (const r of redirectTargets(seg, modes)) {
      if (!/^\/dev\/(?:null|stdout|stderr)$/.test(r)) target(r, "write");
    }
    // .NET static calls (`[IO.File]::WriteAllText($PWD\.env, 'x')`): the first argument is the path.
    for (const m of seg.matchAll(DOTNET_CALL)) {
      const args = callArguments(seg, (m.index ?? 0) + m[0].length - 1);
      const p = argumentPath(args[0]);
      if (p === undefined || p === "") continue;
      const dir = (m[1] ?? "").toLowerCase() === "directory";
      const del = (m[2] ?? "").toLowerCase() === "delete";
      target(p, del ? "delete" : "write", { recursive: dir && /^\$?true$/i.test(args[1] ?? "") });
    }
    // Env assignments and prefix commands (`sudo rm`) are stripped by the lexer.
    for (const r of readings) units.push({ words: r.words, at: cwd });
  }
  for (const unit of units) {
    cwd = unit.at;
    const words = unit.words;
    const cmd = programName(words);
    const rest = words.slice(1);
    if (CD_CMDS.has(cmd)) {
      // The `cd` was applied in the first pass (OPS-13): it writes nothing itself.
      continue;
    }
    if (cmd === "git") {
      // `git -C <dir>` moves every operand that follows it in this command (OPS-13).
      const c = words.indexOf("-C");
      const dir = c === -1 ? undefined : words[c + 1];
      if (dir !== undefined && dir !== "") cwd = withCwd(expandToken(dir, home, cwd), cwd);
      // Global options (`-C <dir>`, `-c k=v`, `--git-dir=…`) come before the subcommand.
      const g = normalizeGit(words);
      const sub = g?.sub;
      if (sub === undefined) continue;
      const args = g?.args ?? [];
      const dd = args.indexOf("--");
      const after = dd === -1 ? [] : args.slice(dd + 1);
      const plain = args.filter((w) => !w.startsWith("-"));
      if (sub === "clean") {
        // A dry run (`-n`, `--dry-run`) or a clean without `-f` removes nothing (OPS-2).
        const forced = args.some((w) => w === "--force" || /^-[a-zA-Z]*f/.test(w));
        const dry = args.some((w) => w === "--dry-run" || /^-[a-zA-Z]*n/.test(w));
        if (forced && !dry) push(".", "delete", { wholeTree: true, recursive: true });
        continue;
      }
      if (sub === "reset") {
        if (args.includes("--hard")) push(".", "delete", { wholeTree: true, recursive: true });
        else for (const w of after) target(w, "write");
        continue;
      }
      if (sub === "checkout" || sub === "restore") {
        // A path only follows `--` (or is the sole operand of `restore`); branch names and refs
        // before it are not paths (OPS-18).
        const ops = dd !== -1 ? after : sub === "restore" ? plain : [];
        const unstage = sub === "restore" && args.includes("--staged");
        for (const w of ops) target(w, "write", { wholeTree: w === "." && !unstage });
        continue;
      }
      if (sub === "rm") {
        for (const w of plain) target(w, "delete");
        continue;
      }
      if (sub === "mv") {
        const last = plain[plain.length - 1];
        if (last !== undefined) target(last, "write");
        continue;
      }
      if (sub === "stash") {
        for (const w of after) target(w, "write");
        continue;
      }
      continue;
    }
    if (cmd === "find") {
      const start = rest.find((w) => !w.startsWith("-")) ?? ".";
      const ex = rest.indexOf("-exec");
      const execDeletes = ex !== -1 && DELETE_CMDS.has((rest[ex + 1] ?? "").toLowerCase());
      if (rest.includes("-delete") || execDeletes) target(start, "delete", { recursive: true });
      continue;
    }
    if (cmd === "ln") {
      // `ln [-s] TARGET LINK_NAME` (or several targets and a directory): the POINTEE is judged.
      const ops = rest.filter((w) => !w.startsWith("-"));
      for (const w of ops.length >= 2 ? ops.slice(0, -1) : ops) {
        target(w, "write", { linkTo: true });
      }
      continue;
    }
    if (cmd === "mklink") {
      // `mklink [/D|/H|/J] LINK_NAME TARGET`: the target (pointee) is judged.
      const ops = rest.filter((w) => !w.startsWith("-") && !CMD_SWITCH.test(w));
      const pointee = ops.length >= 2 ? ops[ops.length - 1] : undefined;
      if (pointee !== undefined) target(pointee, "write", { linkTo: true });
      continue;
    }
    if (cmd === "fsutil") {
      // `fsutil hardlink create NEW_LINK EXISTING_FILE`: the existing file (pointee) is judged.
      if (
        (rest[0] ?? "").toLowerCase() === "hardlink" &&
        (rest[1] ?? "").toLowerCase() === "create"
      ) {
        const ops = rest.slice(2).filter((w) => !w.startsWith("-"));
        const pointee = ops.length >= 2 ? ops[ops.length - 1] : undefined;
        if (pointee !== undefined) target(pointee, "write", { linkTo: true });
      }
      continue;
    }
    if (cmd === "curl" || cmd === "wget") {
      const takesValue =
        cmd === "curl" ? ["-o", "--output"] : ["-o", "-O", "--output", "--output-document"];
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        const eq = /^--(?:output|output-document)=(.*)$/.exec(w);
        if (eq !== null && (eq[1] ?? "") !== "") {
          target(eq[1] ?? "", "write");
          continue;
        }
        if (!takesValue.includes(w)) continue;
        const v = rest[k + 1];
        if (v !== undefined && v !== "" && !v.startsWith("-")) {
          target(v, "write");
          k++;
        }
      }
      continue;
    }
    const rule = WRITE_CMDS[cmd];
    if (rule === undefined) continue;
    if (cmd === "sed") {
      if (
        !rest.some(
          (w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place" || w.startsWith("--in-place="),
        )
      )
        continue;
      const hasScriptFlag = rest.some(
        (w) => /^-[a-zA-Z]*[ef]/.test(w) || /^--(expression|file)/.test(w),
      );
      const nonFlags: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          // `-e SCRIPT` / `-f FILE` take a value
          if (/^-[a-zA-Z]*[ef]$/.test(w) || w === "--expression" || w === "--file") k++;
          continue;
        }
        nonFlags.push(w);
      }
      // Without -e/-f the first operand is the script; everything after it is a file.
      const files = hasScriptFlag ? nonFlags : nonFlags.slice(1);
      for (const w of files) target(w, "write");
      continue;
    }
    if (cmd === "dd") {
      for (const w of rest) if (w.startsWith("of=")) target(w.slice(3), "write");
      continue;
    }
    const op: "write" | "delete" = DELETE_CMDS.has(cmd) ? "delete" : "write";
    if (cmd.includes("-") || CMDLET_ALIASES.has(cmd)) {
      // PowerShell cmdlet: named parameters. Path-bearing ones name the target; every other
      // `-Name value` pair is skipped so `-Value "x"` is not mistaken for a file.
      const named = new Map<string, string>();
      const positional: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          // `-Path:value` binds the value in the same token.
          const colon = w.indexOf(":");
          if (colon > 1) {
            named.set(w.slice(1, colon).toLowerCase(), w.slice(colon + 1));
            continue;
          }
          const name = w.slice(1).toLowerCase();
          const val = rest[k + 1];
          // Only parameters known to take a value consume the next token; `-Recurse`,
          // `-Force`, `-WhatIf` are switches and the token after them is positional.
          if (VALUE_PARAMS.has(name) && val !== undefined && !val.startsWith("-")) {
            named.set(name, val);
            k++;
            continue;
          }
          named.set(name, "");
          continue;
        }
        // An opener (`(rg …)`, `$(@)`) starts a nested expression: the rest is that command's.
        if (OPEN_EXPR.test(w)) break;
        positional.push(w);
      }
      const recursive = [...named.keys()].some((n) => n !== "" && "recurse".startsWith(n));
      for (const [name, val] of named) {
        if (val !== "" && PATH_PARAMS.has(name)) target(val, op, { recursive });
      }
      const itemType = (named.get("itemtype") ?? "").toLowerCase();
      if (itemType === "symboliclink" || itemType === "junction" || itemType === "hardlink") {
        // A link is a second name for its pointee: the pointee is judged as a write.
        const pointee = named.get("target") ?? named.get("value");
        if (pointee !== undefined && pointee !== "") target(pointee, "write", { linkTo: true });
      }
      const pick = CMDLET_OPERANDS[cmd] ?? "all";
      const operands =
        pick === "first"
          ? positional.slice(0, 1)
          : pick === "last"
            ? positional.slice(-1)
            : positional;
      for (const w of operands) target(w, op, { recursive });
      continue;
    }
    const flags = rest.filter((w) => !w.startsWith("-") || w === "-");
    const operands = rule.skipFlags
      ? CMD_BUILTINS.has(cmd)
        ? flags.filter((w) => !CMD_SWITCH.test(w))
        : flags
      : rest;
    const recursive = rest.some((w) => w === "--recursive" || /^-[a-zA-Z]*[rR]/.test(w));
    if (rule.operands === "last") {
      const last = operands[operands.length - 1];
      if (last !== undefined) target(last, op, { recursive });
    } else {
      for (const w of operands) target(w, op, { recursive });
    }
  }
  return out;
}
