import { z } from "zod";

export const REL_PATH_MAX_LENGTH = 1024;

/**
 * Windows device names, reserved on every platform (§4.1-2: cross-platform manifests).
 *
 * Windows resolves a device from the name up to the FIRST dot, after dropping the trailing dots
 * and spaces the filesystem itself strips, so `nul.tar.gz`, `con.a.b`, `aux .txt` and `CON.txt`
 * all name a device. It also accepts `COM0`/`LPT0` and the superscript digits
 * (`COM\u00b9`/`COM\u00b2`/`COM\u00b3`) as `COM1`-style device names, plus the `$` console
 * devices. The name is matched WITHOUT the extension, hence the anchors on the base name.
 */
const WINDOWS_RESERVED =
  /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])$/i;
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
    // Windows drops trailing dots/spaces and ignores everything from the first dot when it
    // resolves a device name, so test the trimmed name before the first dot.
    const base = seg.split(".", 1)[0] ?? "";
    if (WINDOWS_RESERVED.test(base.trim())) reserved = true;
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
