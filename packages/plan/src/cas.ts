import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";

/** `<root>/.axiom/cas/sha256/<aa>/<hex>` (§2.5). */
export function casPath(root: string, hex: string): string {
  return join(root, ".axiom", "cas", "sha256", hex.slice(0, 2), hex);
}

export async function casHas(root: string, hex: string): Promise<boolean> {
  try {
    const s = await stat(casPath(root, hex));
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Store bytes under their sha256. Write is tmp → fsync → rename; an existing
 * entry is left untouched (content-addressed, so it is identical by definition).
 * Returns the hex digest.
 */
export async function casPut(root: string, bytes: Uint8Array): Promise<string> {
  const hex = sha256Hex(bytes);
  const target = casPath(root, hex);
  if (await casHas(root, hex)) return hex;
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    // Lost a race with a concurrent writer of the same content: that is fine.
    if (await casHas(root, hex)) return hex;
    throw err;
  }
  return hex;
}

/** Read bytes by hex digest; `undefined` when absent. Does NOT re-hash — callers do. */
export async function casGet(root: string, hex: string): Promise<Uint8Array | undefined> {
  try {
    const buf = await readFile(casPath(root, hex));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
