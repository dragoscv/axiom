/**
 * Shell write-target scan (moved out of gate.ts in 4.0 so the gate core and the shell
 * classifier evolve separately): the paths a shell command would write or delete, as written.
 * A documented heuristic (D-18), not a shell parser — the Plan -> apply path is the guarantee.
 */
import {
  expandNested,
  normalizeGit,
  programName,
  shellWords,
  splitSegments,
  stripTrailingOverride,
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
const REDIRECT_RE = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*("([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
const WRITE_CMDS: Record<string, { skipFlags: boolean; operands: "all" | "last" | "afterI" }> = {
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
  "out-file": { skipFlags: true, operands: "all" },
  "move-item": { skipFlags: true, operands: "all" },
  mi: { skipFlags: true, operands: "all" },
  "copy-item": { skipFlags: true, operands: "all" },
  ci: { skipFlags: true, operands: "all" },
  cpi: { skipFlags: true, operands: "all" },
  "new-item": { skipFlags: true, operands: "all" },
  ni: { skipFlags: true, operands: "all" },
  del: { skipFlags: true, operands: "all" },
  erase: { skipFlags: true, operands: "all" },
  move: { skipFlags: true, operands: "all" },
  copy: { skipFlags: true, operands: "all" },
};
const GIT_WRITE_SUBCMDS = new Set(["checkout", "reset", "clean", "restore", "rm", "mv", "stash"]);
/** PowerShell aliases that map to a delete. */
const DELETE_CMDS = new Set(["rm", "rmdir", "unlink", "del", "erase", "remove-item", "ri", "rd"]);

function looksLikePath(word: string): boolean {
  if (word === "" || word === "-" || word === "--") return false;
  if (word.startsWith("-") && !word.startsWith("./") && !word.startsWith("../")) return false;
  if (/^\$\(|^`|^\$[A-Za-z_{]/.test(word)) return false; // substitutions: unknown target
  return true;
}

/**
 * Paths a shell command would write/delete, as written. Empty when the command has no
 * recognised write primitive. Substitutions (`$(…)`, `$VAR`) are opaque and not returned.
 */
export function extractShellWriteTargets(command: string): GateTarget[] {
  const out: GateTarget[] = [];
  const seen = new Set<string>();
  const push = (rawPath: string, op: "write" | "delete") => {
    if (!looksLikePath(rawPath) || seen.has(rawPath)) return;
    seen.add(rawPath);
    out.push({ rawPath, op, content: undefined });
  };
  // Every segment (split on ; & | && || and newlines, heredoc bodies dropped) plus the
  // commands nested in `cmd /c`, `bash -c`, `pwsh -Command`, `-EncodedCommand`, `iex '…'`.
  const segments = splitSegments(stripTrailingOverride(command)).flatMap((s) => expandNested(s));
  for (const seg of segments) {
    for (let m = REDIRECT_RE.exec(seg); m !== null; m = REDIRECT_RE.exec(seg)) {
      const target = m[2] ?? m[3] ?? m[4] ?? "";
      if (target !== "" && !/^&\d$/.test(target) && !/^\/dev\//.test(target)) push(target, "write");
    }
    REDIRECT_RE.lastIndex = 0;
    const words = shellWords(seg);
    // skip env assignments and sudo/exec prefixes
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
    while (
      i < words.length &&
      ["sudo", "exec", "command", "nohup", "time"].includes(words[i] ?? "")
    )
      i++;
    const cmd = programName(words.slice(i));
    const rest = words.slice(i + 1);
    if (cmd === "git") {
      // Global options (`-C <dir>`, `-c k=v`, `--git-dir=…`) come before the subcommand.
      const g = normalizeGit(words.slice(i));
      const sub = g?.sub;
      if (sub !== undefined && GIT_WRITE_SUBCMDS.has(sub)) {
        const afterSub = g?.args ?? [];
        const dd = afterSub.indexOf("--");
        const operands =
          dd === -1 ? afterSub.filter((w) => !w.startsWith("-")) : afterSub.slice(dd + 1);
        if (sub === "clean" || (sub === "reset" && afterSub.includes("--hard"))) {
          push(".", "delete");
          continue;
        }
        for (const p of operands) push(p, sub === "rm" ? "delete" : "write");
      }
      continue;
    }
    if (cmd === "find") {
      if (rest.includes("-delete")) {
        const start = rest.find((w) => !w.startsWith("-"));
        push(start ?? ".", "delete");
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
      for (const w of files) push(w, "write");
      continue;
    }
    if (cmd === "dd") {
      for (const w of rest) if (w.startsWith("of=")) push(w.slice(3), "write");
      continue;
    }
    let operands: string[];
    if (cmd.includes("-") || /^(ri|rd|sc|ac|mi|ci|cpi|ni)$/.test(cmd)) {
      // PowerShell cmdlet: named parameters. Path-bearing ones name the target; every other
      // `-Name value` pair is skipped so `-Value "x"` is not mistaken for a file.
      operands = [];
      const PATH_PARAMS = ["path", "literalpath", "filepath", "destination", "newname", "target"];
      const VALUE_PARAMS = new Set([
        ...PATH_PARAMS,
        "value",
        "encoding",
        "filter",
        "include",
        "exclude",
        "itemtype",
        "name",
      ]);
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          // `-Path:value` binds the value in the same token.
          const colon = w.indexOf(":");
          if (colon > 1) {
            const pname = w.slice(1, colon).toLowerCase();
            if (PATH_PARAMS.includes(pname)) operands.push(w.slice(colon + 1));
            continue;
          }
          const name = w.slice(1).toLowerCase();
          const val = rest[k + 1];
          if (PATH_PARAMS.includes(name) && val !== undefined) operands.push(val);
          // Only parameters known to take a value consume the next token; `-Recurse`,
          // `-Force`, `-WhatIf` are switches and the token after them is positional.
          if (VALUE_PARAMS.has(name) && val !== undefined && !val.startsWith("-")) k++;
          continue;
        }
        operands.push(w);
      }
    } else {
      operands = rule.skipFlags ? rest.filter((w) => !w.startsWith("-") || w === "-") : rest;
    }
    const op: "write" | "delete" = DELETE_CMDS.has(cmd) ? "delete" : "write";
    if (rule.operands === "last") {
      const last = operands[operands.length - 1];
      if (last !== undefined) push(last, op);
    } else {
      for (const w of operands) push(w, op);
    }
  }
  return out;
}
