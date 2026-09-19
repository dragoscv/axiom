/**
 * `patch` artifact source (D-17, S-401): three parsers, one exact applier.
 *
 * Formats:
 *   - `unified`        — `@@ -a,b +c,d @@` hunks with ` `/`-`/`+` lines; file headers optional.
 *   - `v4a`            — OpenAI/Codex `apply_patch` text (`*** Begin Patch` … `*** End Patch`),
 *                        the raw string Codex hands to hooks. One file per source.
 *   - `search-replace` — Aider blocks: `<<<<<<< SEARCH` … `=======` … `>>>>>>> REPLACE`.
 *
 * Every format is reduced to `Hunk[] = { context-before, removed, added, context-after }`.
 * The applier locates each hunk by its (context-before + removed) block, which must
 * match EXACTLY ONCE in the remaining text — no whitespace ladder, no fuzz. Ambiguous or
 * absent → `ERR_PATCH_NO_MATCH`. Unified hunk line numbers are used only as a *hint* to
 * disambiguate when the block appears more than once; content decides.
 *
 * Everything here is pure: bytes in, bytes out, no I/O, no clock.
 */
import { AxiomError } from "@codai/axiom-schema";

export type PatchFormat = "unified" | "v4a" | "search-replace";

export interface Hunk {
  /** Lines that must precede `removed` (part of the match block). */
  before: string[];
  /** Lines replaced by `added`. */
  removed: string[];
  added: string[];
  /** Lines that must follow `removed` (part of the match block). */
  after: string[];
  /** Unified `-a` start (1-based), used only to disambiguate multiple exact matches. */
  hintLine?: number;
  /** V4A `*** End of File`: the block must match at the end of the file. */
  atEof?: boolean;
  /**
   * V4A `@@ <line>` change context: a line that must occur exactly once at/after the
   * cursor; the block is then searched strictly after it (Codex `change_context`).
   */
  anchor?: string;
}

export interface ParsedPatch {
  format: PatchFormat;
  hunks: Hunk[];
  /** V4A `*** Add File` / `*** Delete File` — whole-file operations. */
  op?: "add" | "delete";
  /** For `op: "add"`: the complete new content. */
  addContent?: string;
}

const FORMAT_ERR = (format: PatchFormat, message: string, details: Record<string, unknown> = {}) =>
  new AxiomError("ERR_PATCH_FORMAT", `${format} patch: ${message}`, {
    details: { format, ...details },
  });

/** Split keeping every line without its terminator; a trailing "\n" yields no phantom line. */
function lines(text: string): string[] {
  const out = text.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

// --- unified -------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnified(body: string): ParsedPatch {
  const ls = body.split("\n");
  const hunks: Hunk[] = [];
  let i = 0;
  // Skip any preamble / file headers up to the first hunk.
  while (i < ls.length && !HUNK_HEADER.test(ls[i] ?? "")) i++;
  if (i === ls.length) throw FORMAT_ERR("unified", "no @@ hunk header found");
  while (i < ls.length) {
    const header = ls[i] ?? "";
    const m = HUNK_HEADER.exec(header);
    if (m === null) {
      if (header.trim() === "") {
        i++;
        continue;
      }
      throw FORMAT_ERR("unified", `expected hunk header, got ${JSON.stringify(header)}`, {
        line: i + 1,
      });
    }
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    i++;
    const before: string[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    const after: string[] = [];
    let seenChange = false;
    let oldSeen = 0;
    let newSeen = 0;
    while (i < ls.length && !HUNK_HEADER.test(ls[i] ?? "")) {
      const l = ls[i] ?? "";
      if (l === "\\ No newline at end of file") {
        i++;
        continue;
      }
      const tag = l[0];
      const text = l.slice(1);
      if (l === "" && oldSeen >= oldCount) {
        // blank separator between hunks or the trailing newline of the body
        i++;
        continue;
      }
      if (tag === " " || l === "") {
        (seenChange ? after : before).push(text);
        oldSeen++;
        newSeen++;
      } else if (tag === "-") {
        if (after.length > 0) {
          // context between two change runs inside one hunk: fold it into the removed/added streams
          removed.push(...after);
          added.push(...after);
          after.length = 0;
        }
        removed.push(text);
        seenChange = true;
        oldSeen++;
      } else if (tag === "+") {
        if (after.length > 0) {
          removed.push(...after);
          added.push(...after);
          after.length = 0;
        }
        added.push(text);
        seenChange = true;
        newSeen++;
      } else if (tag === "d" && l.startsWith("diff ")) {
        break; // next file — unsupported in a single-artifact source
      } else {
        throw FORMAT_ERR("unified", `unexpected line ${JSON.stringify(l)}`, { line: i + 1 });
      }
      i++;
    }
    if (oldSeen !== oldCount || newSeen !== newCount) {
      throw FORMAT_ERR("unified", "hunk line counts do not match its header", {
        header,
        oldSeen,
        oldCount,
        newSeen,
        newCount,
      });
    }
    hunks.push({ before, removed, added, after, hintLine: oldStart });
  }
  return { format: "unified", hunks };
}

// --- v4a (OpenAI apply_patch) --------------------------------------------------------

export function parseV4A(body: string): ParsedPatch {
  const ls = body.split("\n");
  let i = 0;
  while (i < ls.length && (ls[i] ?? "").trim() === "") i++;
  if ((ls[i] ?? "").trim() !== "*** Begin Patch") {
    throw FORMAT_ERR("v4a", "must start with *** Begin Patch");
  }
  i++;
  const fileLine = ls[i] ?? "";
  const fm = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(fileLine);
  if (fm === null) throw FORMAT_ERR("v4a", "expected *** Add/Update/Delete File: <path>");
  const kind = fm[1];
  i++;
  if (kind === "Delete") {
    if ((ls[i] ?? "").trim() !== "*** End Patch") {
      throw FORMAT_ERR("v4a", "Delete File must be followed by *** End Patch");
    }
    return { format: "v4a", hunks: [], op: "delete" };
  }
  if (kind === "Add") {
    const content: string[] = [];
    for (; i < ls.length; i++) {
      const l = ls[i] ?? "";
      if (l.trim() === "*** End Patch") break;
      if (!l.startsWith("+"))
        throw FORMAT_ERR("v4a", "Add File lines must start with +", { line: i + 1 });
      content.push(l.slice(1));
    }
    if (i >= ls.length) throw FORMAT_ERR("v4a", "missing *** End Patch");
    return { format: "v4a", hunks: [], op: "add", addContent: `${content.join("\n")}\n` };
  }
  // Update File — optional `*** Move to:` (rejected: an artifact has one path), then hunks
  if ((ls[i] ?? "").startsWith("*** Move to:")) {
    throw FORMAT_ERR("v4a", "*** Move to: is not supported (an artifact has exactly one path)");
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let seenChange = false;
  const flush = (): void => {
    if (cur !== undefined && (cur.removed.length > 0 || cur.added.length > 0)) hunks.push(cur);
    else if (cur !== undefined && (cur.before.length > 0 || cur.after.length > 0)) {
      throw FORMAT_ERR("v4a", "hunk has context but no change");
    }
    cur = undefined;
    seenChange = false;
  };
  let sawAnyLine = false;
  let ended = false;
  for (; i < ls.length; i++) {
    const l = ls[i] ?? "";
    if (l.trim() === "*** End Patch") {
      ended = true;
      break;
    }
    if (l.startsWith("*** ") && /^\*\*\* (Add|Update|Delete) File:/.test(l)) {
      throw FORMAT_ERR("v4a", "a patch source targets exactly one file", { line: i + 1 });
    }
    if (l === "*** End of File") {
      if (cur === undefined)
        throw FORMAT_ERR("v4a", "*** End of File outside a hunk", { line: i + 1 });
      cur.atEof = true;
      flush();
      continue;
    }
    if (l.startsWith("@@")) {
      // `@@` alone or `@@ <context line>`: hunk separator; the trailing text is an *anchor*
      // context line that precedes the change.
      flush();
      cur = { before: [], removed: [], added: [], after: [] };
      const anchor = l.slice(2).trim();
      if (anchor !== "") cur.anchor = anchor;
      continue;
    }
    sawAnyLine = true;
    if (cur === undefined) cur = { before: [], removed: [], added: [], after: [] };
    const tag = l[0];
    const text = l.slice(1);
    if (tag === " " || l === "") {
      if (seenChange) cur.after.push(text);
      else cur.before.push(text);
    } else if (tag === "-") {
      if (cur.after.length > 0) {
        cur.removed.push(...cur.after);
        cur.added.push(...cur.after);
        cur.after.length = 0;
      }
      cur.removed.push(text);
      seenChange = true;
    } else if (tag === "+") {
      if (cur.after.length > 0) {
        cur.removed.push(...cur.after);
        cur.added.push(...cur.after);
        cur.after.length = 0;
      }
      cur.added.push(text);
      seenChange = true;
    } else {
      throw FORMAT_ERR("v4a", `unexpected line ${JSON.stringify(l)}`, { line: i + 1 });
    }
  }
  if (!ended) throw FORMAT_ERR("v4a", "missing *** End Patch");
  flush();
  if (!sawAnyLine || hunks.length === 0) throw FORMAT_ERR("v4a", "Update File has no hunks");
  return { format: "v4a", hunks };
}

// --- search / replace (Aider) ----------------------------------------------------------

const SR_SEARCH = /^<{5,9} SEARCH\s*$/;
const SR_DIVIDER = /^={5,9}\s*$/;
const SR_REPLACE = /^>{5,9} REPLACE\s*$/;

export function parseSearchReplace(body: string): ParsedPatch {
  const ls = body.split("\n");
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ls.length) {
    const l = ls[i] ?? "";
    if (!SR_SEARCH.test(l)) {
      if (l.trim() === "" || l.startsWith("```")) {
        i++;
        continue;
      }
      throw FORMAT_ERR("search-replace", `expected <<<<<<< SEARCH, got ${JSON.stringify(l)}`, {
        line: i + 1,
      });
    }
    i++;
    const search: string[] = [];
    while (i < ls.length && !SR_DIVIDER.test(ls[i] ?? "")) search.push(ls[i++] ?? "");
    if (i >= ls.length) throw FORMAT_ERR("search-replace", "missing ======= divider");
    i++;
    const replace: string[] = [];
    while (i < ls.length && !SR_REPLACE.test(ls[i] ?? "")) replace.push(ls[i++] ?? "");
    if (i >= ls.length) throw FORMAT_ERR("search-replace", "missing >>>>>>> REPLACE");
    i++;
    hunks.push({ before: [], removed: search, added: replace, after: [] });
  }
  if (hunks.length === 0) throw FORMAT_ERR("search-replace", "no SEARCH/REPLACE block found");
  return { format: "search-replace", hunks };
}

export function parsePatch(format: PatchFormat, body: string): ParsedPatch {
  switch (format) {
    case "unified":
      return parseUnified(body);
    case "v4a":
      return parseV4A(body);
    case "search-replace":
      return parseSearchReplace(body);
  }
}

// --- applier -----------------------------------------------------------------------------

function findAll(hay: string[], needle: string[], from: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

function noMatch(message: string, details: Record<string, unknown>): AxiomError {
  return new AxiomError("ERR_PATCH_NO_MATCH", message, { details });
}

/**
 * Apply `patch` to `text` with exact matching. Hunks are applied in order; each must
 * match exactly once at or after the end of the previous hunk. Returns the new text.
 * The pre-image's trailing-newline state is preserved unless a hunk changes it.
 */
export function applyParsedPatch(text: string, patch: ParsedPatch): string {
  if (patch.op === "delete") {
    throw noMatch("v4a Delete File cannot be a patch source; use op: delete", {});
  }
  if (patch.op === "add") {
    if (text !== "") {
      throw noMatch("v4a Add File requires preImage: absent", { existingBytes: text.length });
    }
    return patch.addContent ?? "";
  }
  const hadTrailingNewline = text.endsWith("\n") || text === "";
  let cur = lines(text);
  let cursor = 0;
  for (const [idx, h] of patch.hunks.entries()) {
    const block = [...h.before, ...h.removed, ...h.after];
    const replacement = [...h.before, ...h.added, ...h.after];
    if (h.anchor !== undefined) {
      const anchors = findAll(cur, [h.anchor], cursor);
      if (anchors.length !== 1) {
        throw noMatch(
          anchors.length === 0
            ? `hunk ${idx + 1}: @@ context ${JSON.stringify(h.anchor)} not found`
            : `hunk ${idx + 1}: @@ context ${JSON.stringify(h.anchor)} matches ${anchors.length} times`,
          {
            hunk: idx + 1,
            anchor: h.anchor,
            matches: anchors.length,
            searchedFromLine: cursor + 1,
          },
        );
      }
      cursor = (anchors[0] as number) + 1;
    }
    if (block.length === 0) {
      // Pure insertion: at the anchor (V4A), at EOF (`*** End of File`), or into an empty file.
      if (h.anchor !== undefined) {
        cur = [...cur.slice(0, cursor), ...replacement, ...cur.slice(cursor)];
        cursor += replacement.length;
        continue;
      }
      if (h.atEof) {
        cur = [...cur, ...replacement];
        cursor = cur.length;
        continue;
      }
      if (cur.length !== 0) {
        throw noMatch(`hunk ${idx + 1} has no context and no removed lines`, { hunk: idx + 1 });
      }
      cur = replacement;
      cursor = cur.length;
      continue;
    }
    let matches = findAll(cur, block, cursor);
    if (h.atEof) matches = matches.filter((m) => m + block.length === cur.length);
    if (matches.length > 1 && h.hintLine !== undefined) {
      // Unified line-number hint disambiguates identical blocks; content still had to match.
      const want = h.hintLine - 1 - h.before.length;
      const byDist = [...matches].sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
      const [best, second] = byDist;
      if (
        best !== undefined &&
        (second === undefined || Math.abs(best - want) < Math.abs(second - want))
      ) {
        matches = [best];
      }
    }
    if (matches.length !== 1) {
      throw noMatch(
        matches.length === 0
          ? `hunk ${idx + 1} does not match the pre-image exactly`
          : `hunk ${idx + 1} matches ${matches.length} times; make the context unique`,
        {
          hunk: idx + 1,
          matches: matches.length,
          searchedFromLine: cursor + 1,
          block: block.slice(0, 8),
        },
      );
    }
    const at = matches[0] as number;
    cur = [...cur.slice(0, at), ...replacement, ...cur.slice(at + block.length)];
    cursor = at + replacement.length;
  }
  const out = cur.join("\n");
  return hadTrailingNewline && cur.length > 0 ? `${out}\n` : out;
}

/** Parse + apply in one step; `preImage` text is the current file content ("" when absent). */
export function applyPatchText(format: PatchFormat, body: string, preImage: string): string {
  return applyParsedPatch(preImage, parsePatch(format, body));
}
