
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256(content: string | Buffer): string {
  const h = crypto.createHash("sha256");
  h.update(content);
  return h.digest("hex");
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function writeFile(root: string, relPath: string, content: string) {
  const full = path.join(root, relPath);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content, "utf-8");
  return { full };
}
