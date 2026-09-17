import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isValidRelPath } from "@codai/axiom-schema";
import picomatch from "picomatch";
import type { RepoFacts } from "../types.js";

export interface RepoFactsOptions {
  /** Directory names never indexed (in addition to .gitignore lines). */
  skipDirs?: readonly string[];
  /** Hard cap on indexed files; the index is truncated beyond this. */
  maxFiles?: number;
}

const DEFAULT_SKIP = [".git", "node_modules", "dist", ".axiom"] as const;
const DEFAULT_MAX_FILES = 200_000;

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

async function readGitignore(root: string): Promise<string[]> {
  try {
    const text = await readFile(join(root, ".gitignore"), "utf8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"))
      .map((l) => {
        // Rough .gitignore → picomatch: anchored patterns keep their path, bare
        // names match at any depth, directory patterns match everything below.
        let pat = l.startsWith("/") ? l.slice(1) : l.includes("/") ? l : `**/${l}`;
        if (pat.endsWith("/")) pat = `${pat}**`;
        else pat = `{${pat},${pat}/**}`;
        return pat;
      });
  } catch {
    return [];
  }
}

async function readGitHead(root: string): Promise<string | undefined> {
  try {
    const head = (await readFile(join(root, ".git", "HEAD"), "utf8")).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const m = /^ref:\s*(\S+)$/.exec(head);
    const ref = m?.[1];
    if (ref === undefined) return undefined;
    try {
      const sha = (await readFile(join(root, ".git", ...ref.split("/")), "utf8")).trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
    } catch {
      const packed = await readFile(join(root, ".git", "packed-refs"), "utf8");
      for (const line of packed.split(/\r?\n/)) {
        const [sha, name] = line.split(" ");
        if (name === ref && sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return sha;
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Offline repo facts rooted at `rootReal` (caller has already realpath'd and
 * authorised it). Nothing here spawns a process or touches the network.
 * `gitDirty` is intentionally `undefined` in v2.0.
 */
export async function createRepoFacts(
  rootReal: string,
  opts: RepoFactsOptions = {},
): Promise<RepoFacts> {
  const skip = new Set<string>([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])]);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const [packageJson, gitHead, ignorePatterns] = await Promise.all([
    readPackageJson(rootReal),
    readGitHead(rootReal),
    readGitignore(rootReal),
  ]);
  const isIgnored =
    ignorePatterns.length > 0 ? picomatch(ignorePatterns, { dot: true }) : () => false;

  let index: Promise<string[]> | undefined;
  const buildIndex = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxFiles) return;
        const abs = join(dir, e.name);
        const rel = toPosix(relative(rootReal, abs));
        if (e.isDirectory()) {
          if (skip.has(e.name) || isIgnored(rel)) continue;
          await walk(abs);
        } else if (e.isFile()) {
          if (isIgnored(rel)) continue;
          out.push(rel);
        }
      }
    };
    await walk(rootReal);
    out.sort();
    return out;
  };

  const resolve = (path: string): string | undefined =>
    isValidRelPath(path) ? join(rootReal, ...path.split("/")) : undefined;

  const facts: RepoFacts = {
    packageJson,
    async exists(path) {
      const abs = resolve(path);
      if (abs === undefined) return false;
      try {
        await stat(abs);
        return true;
      } catch {
        return false;
      }
    },
    async read(path, max) {
      const abs = resolve(path);
      if (abs === undefined) return undefined;
      try {
        const st = await stat(abs);
        if (!st.isFile()) return undefined;
        if (max === undefined) return new Uint8Array(await readFile(abs));
        const fh = await open(abs, "r");
        try {
          const buf = new Uint8Array(Math.min(max, st.size));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          return buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      } catch {
        return undefined;
      }
    },
    async glob(pattern) {
      index ??= buildIndex();
      const files = await index;
      const match = picomatch(pattern, { dot: true });
      return files.filter((f) => match(f));
    },
  };
  if (gitHead !== undefined) facts.gitHead = gitHead;
  return facts;
}
