import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const IS_WIN32: boolean = process.platform === "win32";

/** §4.4: prefix `\\?\` on win32 when a path gets long. */
export function nsPath(abs: string): string {
  return IS_WIN32 && abs.length > 240 ? path.toNamespacedPath(abs) : abs;
}

export function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export async function lstatOrNull(abs: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(nsPath(abs));
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") return null;
    throw err;
  }
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 hex of a file, or `"absent"` when it does not exist. Never follows symlinks. */
export async function fileDigestOrAbsent(abs: string): Promise<string> {
  const st = await lstatOrNull(abs);
  if (st === null) return "absent";
  if (!st.isFile())
    return `non-file:${st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "other"}`;
  return sha256Of(await fs.readFile(nsPath(abs)));
}

/** Compare two absolute paths for containment; case-insensitive on win32 (§4.1-4). */
export function isContained(rootReal: string, candidateReal: string): boolean {
  const a = IS_WIN32 ? rootReal.toLowerCase() : rootReal;
  const b = IS_WIN32 ? candidateReal.toLowerCase() : candidateReal;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export async function fsyncDir(absDir: string): Promise<void> {
  // Directory fsync is a no-op / EPERM on Windows (§4.4) — accepted.
  if (IS_WIN32) return;
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(absDir, "r");
    await fh.sync();
  } catch {
    // best effort
  } finally {
    await fh?.close();
  }
}

export async function rmrf(abs: string): Promise<void> {
  await fs.rm(nsPath(abs), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
