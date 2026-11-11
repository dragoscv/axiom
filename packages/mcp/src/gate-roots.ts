/** Root discovery for the gate: nearest repository root, git common dir, sibling worktrees (moved out of gate.ts in 4.0). */
import { realpath as realpathCb } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
const IS_WIN32 = process.platform === "win32";

export async function canonicalizeExisting(abs: string): Promise<string> {
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpathNative(cur);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

export const samePath = (a: string, b: string): boolean =>
  IS_WIN32 ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function realOrResolved(p: string): Promise<string> {
  try {
    let r = await realpathNative(p);
    if (IS_WIN32 && r.startsWith("\\\\?\\")) r = r.slice(4);
    return r;
  } catch {
    return path.resolve(p);
  }
}

/**
 * The git common dir of the checkout rooted at `dir`, read from disk (no `git` spawn — the
 * hook budget and the no-shell invariant both forbid it). `.git` directory → itself. `.git`
 * file (`gitdir: <common>/worktrees/<name>`) → `<gitdir>/commondir`, and only when the
 * back-link `<gitdir>/gitdir` points at this very `.git` file — a hand-made `.git` file that
 * merely names another repo's worktree does not borrow that repo's identity.
 */
export async function gitCommonDir(dir: string): Promise<string | undefined> {
  const dotGit = path.join(dir, ".git");
  // Open first, verify after: the lstat confirms `.git` itself is a regular file (a symlink is
  // refused, as before) and is the inode we hold, so nothing can be swapped in between.
  let text: string;
  try {
    const fh = await open(dotGit, "r");
    try {
      const held = await fh.stat();
      const st = await lstat(dotGit);
      if (held.ino !== st.ino || held.dev !== st.dev) return undefined;
      if (st.isDirectory()) return realOrResolved(dotGit);
      if (!st.isFile()) return undefined;
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    // Windows refuses to open a directory for reading (EISDIR/EPERM): a plain `.git` directory.
    const st = await lstat(dotGit).catch(() => undefined);
    if (st?.isDirectory() === true && (err as { code?: string }).code !== "ENOENT") {
      return realOrResolved(dotGit);
    }
    return undefined;
  }
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (m?.[1] === undefined) return undefined;
    const gitdir = path.resolve(dir, m[1]);
    const back = (await readFile(path.join(gitdir, "gitdir"), "utf8")).trim();
    const [backReal, selfReal] = await Promise.all([
      realOrResolved(path.resolve(gitdir, back)),
      realOrResolved(dotGit),
    ]);
    if (!samePath(backReal, selfReal)) return undefined;
    const common = (await readFile(path.join(gitdir, "commondir"), "utf8")).trim();
    return realOrResolved(path.resolve(gitdir, common));
  } catch {
    return undefined;
  }
}

/**
 * D-35: agents work in sibling worktrees (`E:\gh\.wt\<repo>\task-N`) while the harness cwd is
 * the main clone. A target outside `rootReal` whose nearest `.git` ancestor is a worktree of
 * the SAME repository (equal common dir) is judged against that worktree's root. Anything
 * else — another repo, no git, a forged `.git` file — returns undefined (stays ERR_CONTAINMENT).
 */
export async function sameRepoWorktreeRoot(
  rootReal: string,
  rawPath: string,
  cwdReal: string,
): Promise<string | undefined> {
  const rootCommon = await gitCommonDir(rootReal);
  if (rootCommon === undefined) return undefined;
  const supplied = rawPath.replace(/\\/g, "/");
  const abs = await canonicalizeExisting(
    path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(cwdReal, supplied),
  );
  let cur = path.dirname(abs);
  for (let depth = 0; depth < 64; depth++) {
    if (samePath(cur, rootReal)) return undefined;
    const common = await gitCommonDir(cur);
    if (common !== undefined) {
      return samePath(common, rootCommon) ? cur : undefined;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

export const AXIOM_REPO_MARKERS = [
  "journal",
  "cas",
  "applied",
  "profiles",
  "trust",
  "lock",
  "backup",
];

/**
 * Walk up from `start` to the nearest directory that is a repository root: it holds `.git`
 * (directory, or the file a worktree/submodule uses) or a *repo* `.axiom/` (one with
 * journal/cas/applied/profiles/trust — not `~/.axiom/`, which only holds a gate profile).
 * Never climbs to or above the home directory, and never above `stopAt` when given. A
 * harness that runs the agent in `apps/web` still has `.git/**` and `.env` at the repo root,
 * and the profile lives there too. Returns `start` when nothing is found.
 */
export async function discoverRoot(start: string, home: string = homedir()): Promise<string> {
  const homeReal = path.resolve(home);
  const isHomeOrAbove = (p: string): boolean => {
    const a = IS_WIN32 ? p.toLowerCase() : p;
    const h = IS_WIN32 ? homeReal.toLowerCase() : homeReal;
    return a === h || h.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
  };
  let cur = start;
  for (let depth = 0; depth < 64; depth++) {
    if (isHomeOrAbove(cur)) break;
    try {
      const st = await lstat(path.join(cur, ".git"));
      if (st.isDirectory() || st.isFile()) return cur;
    } catch {
      /* keep walking */
    }
    try {
      const ax = path.join(cur, ".axiom");
      if ((await lstat(ax)).isDirectory()) {
        for (const m of AXIOM_REPO_MARKERS) {
          try {
            await lstat(path.join(ax, m));
            return cur;
          } catch {
            /* next marker */
          }
        }
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}
