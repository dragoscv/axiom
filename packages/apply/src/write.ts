import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ArtifactMode, AxiomError } from "@codai/axiom-schema";
import { errnoCode, fsyncDir, IS_WIN32, nsPath, sha256Of } from "./fsx.js";

export const RENAME_RETRIES = 5;
export const RENAME_BACKOFF_MS = 50;

/**
 * `rename` with retry on EBUSY/EPERM/EACCES (Windows: target open by another
 * process). After the retries → ERR_EBUSY.
 */
export async function renameRetry(from: string, to: string, relPath?: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await fs.rename(nsPath(from), nsPath(to));
      return;
    } catch (err) {
      lastErr = err;
      const c = errnoCode(err);
      if (c !== "EBUSY" && c !== "EPERM" && c !== "EACCES") throw err;
      await sleep(RENAME_BACKOFF_MS * (attempt + 1));
    }
  }
  throw new AxiomError("ERR_EBUSY", "target busy; rename failed after retries", {
    ...(relPath === undefined ? {} : { path: relPath }),
    cause: lastErr,
    details: { from, to },
  });
}

/** `unlink` with the same EBUSY/EPERM/EACCES retry policy as {@link renameRetry}. */
export async function unlinkRetry(target: string, relPath?: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await fs.unlink(nsPath(target));
      return;
    } catch (err) {
      lastErr = err;
      const c = errnoCode(err);
      if (c !== "EBUSY" && c !== "EPERM" && c !== "EACCES") throw err;
      await sleep(RENAME_BACKOFF_MS * (attempt + 1));
    }
  }
  throw new AxiomError("ERR_EBUSY", "target busy; unlink failed after retries", {
    ...(relPath === undefined ? {} : { path: relPath }),
    cause: lastErr,
    details: { target },
  });
}

/**
 * tmp (same dir, `.axiom-tmp-<rand>`, O_EXCL) → write → fsync → rename onto
 * target → re-read and re-hash. Lifted from v1 `writeAndVerify`, silent.
 * Returns the sha256 hex of what is on disk.
 */
export async function writeAtomic(
  absTarget: string,
  bytes: Uint8Array,
  mode: ArtifactMode = "0644",
): Promise<string> {
  const dir = path.dirname(absTarget);
  await fs.mkdir(nsPath(dir), { recursive: true });
  const tmp = path.join(dir, `.axiom-tmp-${randomBytes(8).toString("hex")}`);
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(nsPath(tmp), "wx", mode === "0755" ? 0o755 : 0o644);
    if (!IS_WIN32) {
      // No O_NOFOLLOW guarantee on every platform: re-check the handle is a plain file.
      const st = await fh.stat();
      if (!st.isFile()) throw new AxiomError("ERR_TARGET_TYPE", "temp file is not a regular file");
    }
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = undefined;
    if (!IS_WIN32 && mode === "0755") await fs.chmod(tmp, 0o755);
    await renameRetry(tmp, absTarget);
  } catch (err) {
    await fh?.close().catch(() => undefined);
    await fs.rm(nsPath(tmp), { force: true }).catch(() => undefined);
    throw err;
  }
  await fsyncDir(dir);
  const onDisk = sha256Of(await fs.readFile(nsPath(absTarget)));
  const expected = sha256Of(bytes);
  if (onDisk !== expected) {
    throw new AxiomError("ERR_DIGEST_MISMATCH", "post-write re-hash differs", {
      details: { target: absTarget, expected, actual: onDisk },
    });
  }
  return onDisk;
}
