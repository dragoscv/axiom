import { z } from "zod";

export const REL_PATH_MAX_LENGTH = 1024;

/** Windows device names, reserved on every platform (§4.1-2: cross-platform manifests). */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^.]*)?$/i;
/** `<>:"|?*` plus C0 controls and DEL. `:` also rejects NTFS alternate data streams. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are exactly what we reject
const INVALID_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;

/**
 * Returns every issue with a candidate relative POSIX path, as error codes.
 * Empty array means valid. Deliberately reports all problems, not just the first,
 * so callers can surface a complete diagnosis.
 */
export function relPathIssues(p: string): string[] {
  const issues: string[] = [];
  if (typeof p !== "string" || p.length === 0 || p.length > REL_PATH_MAX_LENGTH) {
    issues.push("ERR_PATH_SEGMENT");
    if (typeof p !== "string" || p.length === 0) return issues;
  }
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.includes("\\")) {
    issues.push("ERR_PATH_NOT_RELATIVE_POSIX");
  }
  if (p !== p.normalize("NFC")) issues.push("ERR_PATH_NOT_NFC");
  if (INVALID_CHARS.test(p)) issues.push("ERR_PATH_INVALID_CHAR");

  let segmentBad = false;
  let reserved = false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") segmentBad = true;
    else if (seg.endsWith(".") || seg.endsWith(" ")) segmentBad = true;
    if (WINDOWS_RESERVED.test(seg)) reserved = true;
  }
  if (segmentBad && !issues.includes("ERR_PATH_SEGMENT")) issues.push("ERR_PATH_SEGMENT");
  if (reserved) issues.push("ERR_PATH_RESERVED_NAME");
  return issues;
}

export function isValidRelPath(p: string): boolean {
  return relPathIssues(p).length === 0;
}

/**
 * Relative POSIX path: no `\`, no leading `/` or drive letter, no empty/`.`/`..`
 * segments, NFC-normalised, ≤ 1024 chars, no Windows reserved names, no trailing
 * dot/space in a segment, no `<>:"|?*` or C0 controls, no NTFS ADS (`:`).
 */
export const RelPathSchema = z
  .string()
  .min(1)
  .max(REL_PATH_MAX_LENGTH)
  .superRefine((p, ctx) => {
    for (const code of relPathIssues(p)) {
      ctx.addIssue({ code: "custom", message: code, params: { code } });
    }
  })
  .describe("Relative POSIX path, NFC, no reserved names");

export type RelPath = z.infer<typeof RelPathSchema>;
