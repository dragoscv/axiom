import { createTwoFilesPatch } from "diff";

export const DIFF_CAP_BYTES: number = 1024 * 1024;

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Text = strictly UTF-8 decodable and contains no NUL byte. */
export function decodeText(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return "";
  if (bytes.includes(0)) return undefined;
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return undefined;
  }
}

export interface DiffEntry {
  path: string;
  before: Uint8Array | undefined;
  after: Uint8Array | undefined;
}

export function diffOne(e: DiffEntry): string {
  const a = decodeText(e.before);
  const b = decodeText(e.after);
  const oldName = e.before === undefined ? "/dev/null" : `a/${e.path}`;
  const newName = e.after === undefined ? "/dev/null" : `b/${e.path}`;
  if (a === undefined || b === undefined) {
    return `diff --axiom a/${e.path} b/${e.path}\nBinary files differ\n`;
  }
  return createTwoFilesPatch(oldName, newName, a, b, undefined, undefined, { context: 3 });
}

/** Concatenated unified diff, capped at 1 MiB (truncation is marked). */
export function unifiedDiff(entries: readonly DiffEntry[]): string {
  let out = "";
  let bytes = 0;
  for (const e of entries) {
    const chunk = diffOne(e);
    const len = Buffer.byteLength(chunk, "utf8");
    if (bytes + len > DIFF_CAP_BYTES) {
      const remaining = DIFF_CAP_BYTES - bytes;
      out += Buffer.from(chunk, "utf8").subarray(0, Math.max(0, remaining)).toString("utf8");
      out += "\n[diff truncated at 1 MiB]\n";
      return out;
    }
    out += chunk;
    bytes += len;
  }
  return out;
}
