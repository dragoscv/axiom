
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

/**
 * Normalizează un path la format POSIX (doar forward slashes)
 * Toate path-urile în manifest/artifacts TREBUIE să fie POSIX
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Scrie fișier pe disc, dar returnează path POSIX pentru manifest
 */
export function writeFile(root: string, relPath: string, content: string) {
  // Normalizează path-ul la POSIX înainte de orice procesare
  const posixPath = toPosixPath(relPath);

  // Când scriem pe disc, convertim la path OS-specific
  const full = path.join(root, ...posixPath.split('/'));
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content, "utf-8");

  // DEBUG: Verificăm dacă posixPath conține backslash (NU AR TREBUI!)
  if (posixPath.includes("\\")) {
    console.error(`[writeFile] BUG: posixPath contains backslash: "${posixPath}"`);
    console.error(`[writeFile] Original relPath was: "${relPath}"`);
    console.error(`[writeFile] Full OS path is: "${full}"`);
  }

  // Returnăm întotdeauna POSIX path pentru manifest (garantat fără backslash)
  // IMPORTANT: Returnăm o COPIE a posixPath pentru a evita mutații accidentale
  return { full, posixPath: posixPath.replace(/\\/g, '/') };
}
