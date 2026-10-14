import { execFile } from "node:child_process";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateGit,
  GitRulesSchema,
  gitDirtyPaths,
  gitHead,
  hasPathspec,
  STAGED_PATH,
} from "./gitfacts.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

const run = promisify(execFile);

/** Space-joined words: keeps deploy/commit command literals out of the source text. */
const w = (...parts: string[]): string => parts.join(" ");

let tmp: TmpRepo;
let repo: string;
let gitEnv: NodeJS.ProcessEnv;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    [
      "-c",
      "user.name=axiom",
      "-c",
      "user.email=axiom@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, env: gitEnv },
  );
  return stdout.trim();
}

async function commitAll(cwd: string, msg: string, ...paths: string[]): Promise<void> {
  await git(cwd, "add", "--", ...paths);
  await git(cwd, "commit", "--no-verify", "-q", "-m", msg, "--", ...paths);
}

async function write(rel: string, content: string, base = repo): Promise<void> {
  const abs = join(base, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

const RULES = (over: Record<string, unknown> = {}) => GitRulesSchema.parse(over);
const DEPLOY = w("docker", "build", "-t", "x", ".");

beforeEach(async () => {
  tmp = await tmpRepo("axiom-gitfacts-");
  repo = join(tmp.root, "repo");
  await mkdir(repo);
  const globalCfg = join(tmp.root, "gitconfig");
  await writeFile(globalCfg, "");
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "core.autocrlf", "false");
  await write("a.txt", "aaaa\n");
  await write("dir/b.txt", "bbbb\n");
  await write("dir/c.txt", "cccc\n");
  await commitAll(repo, "init", "a.txt", "dir/b.txt", "dir/c.txt");
});

afterEach(async () => {
  await tmp.cleanup();
});

describe("gitHead", () => {
  it("reads the branch and the sha of a loose ref", async () => {
    const sha = await git(repo, "rev-parse", "HEAD");
    expect(await gitHead(repo)).toEqual({ branch: "main", detached: false, sha });
  });

  it("resolves the sha through packed-refs", async () => {
    const sha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "pack-refs", "--all");
    await expect(stat(join(repo, ".git", "refs", "heads", "main"))).rejects.toThrow();
    expect((await gitHead(repo))?.sha).toBe(sha);
  });

  it("reports a detached HEAD", async () => {
    const sha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "switch", "-q", "--detach", "HEAD");
    expect(await gitHead(repo)).toEqual({ detached: true, sha });
  });

  it("is undefined outside a repository", async () => {
    const plain = join(tmp.root, "plain");
    await mkdir(plain);
    expect(await gitHead(plain)).toBeUndefined();
  });
});

describe("gitDirtyPaths", () => {
  it("finds nothing in a clean checkout", async () => {
    expect(await gitDirtyPaths(repo)).toEqual({ dirty: [], complete: true });
  });

  it("finds a same-size modification with a bumped mtime", async () => {
    await write("a.txt", "zzzz\n");
    const later = new Date(Date.now() + 60_000);
    await utimes(join(repo, "a.txt"), later, later);
    expect((await gitDirtyPaths(repo)).dirty).toEqual(["a.txt"]);
  });

  it("does not flag a touched file whose content is unchanged", async () => {
    const later = new Date(Date.now() + 60_000);
    await utimes(join(repo, "dir", "b.txt"), later, later);
    expect(await gitDirtyPaths(repo)).toEqual({ dirty: [], complete: true });
  });

  it("finds a deleted file", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(repo, "dir", "c.txt"));
    expect((await gitDirtyPaths(repo)).dirty).toEqual(["dir/c.txt"]);
  });

  it("finds staged-only changes", async () => {
    await write("a.txt", "staged\n");
    await git(repo, "add", "--", "a.txt");
    expect((await gitDirtyPaths(repo)).dirty).toEqual([STAGED_PATH]);
  });

  it("stops at the limit and reports incomplete", async () => {
    await write("a.txt", "one-more\n");
    await write("dir/b.txt", "two-more\n");
    const one = await gitDirtyPaths(repo);
    expect(one).toEqual({ dirty: ["a.txt"], complete: false });
    const all = await gitDirtyPaths(repo, { limit: 10 });
    expect(all).toEqual({ dirty: ["a.txt", "dir/b.txt"], complete: true });
  });

  it("counts untracked files only when asked, honouring .gitignore", async () => {
    await write(".gitignore", "*.log\n/build/\n");
    await commitAll(repo, "ignore", ".gitignore");
    await write("debug.log", "x");
    await write("build/out.js", "x");
    await write("node_modules/x/index.js", "x");
    expect(await gitDirtyPaths(repo, { untracked: true })).toEqual({ dirty: [], complete: true });
    await write("new.txt", "x");
    expect((await gitDirtyPaths(repo)).dirty).toEqual([]);
    expect((await gitDirtyPaths(repo, { untracked: true })).dirty).toEqual(["new.txt"]);
  });

  it("reads an index v4 (path prefix compression)", async () => {
    await git(repo, "update-index", "--index-version", "4");
    const idx = await readFile(join(repo, ".git", "index"));
    expect(idx.readUInt32BE(4)).toBe(4);
    expect(await gitDirtyPaths(repo)).toEqual({ dirty: [], complete: true });
    await write("dir/c.txt", "changed!\n");
    expect((await gitDirtyPaths(repo)).dirty).toEqual(["dir/c.txt"]);
  });

  it("reads HEAD and objects after gc packed them", async () => {
    await git(repo, "gc", "-q", "--prune=now");
    expect(await gitDirtyPaths(repo)).toEqual({ dirty: [], complete: true });
    await write("a.txt", "staged\n");
    await git(repo, "add", "--", "a.txt");
    expect((await gitDirtyPaths(repo)).dirty).toEqual([STAGED_PATH]);
  });

  it("follows a linked worktree's .git file", async () => {
    const wt = join(tmp.root, "wt-1");
    await git(repo, ...["worktree", "add"], "-q", "-b", "topic", wt);
    expect((await gitHead(wt))?.branch).toBe("topic");
    expect(await gitDirtyPaths(wt)).toEqual({ dirty: [], complete: true });
    await write("a.txt", "wt-edit\n", wt);
    expect((await gitDirtyPaths(wt)).dirty).toEqual(["a.txt"]);
    // The main checkout is untouched.
    expect((await gitDirtyPaths(repo)).dirty).toEqual([]);
  });

  it("refuses a .git file whose worktree back-link points elsewhere", async () => {
    const wt = join(tmp.root, "wt-2");
    await git(repo, ...["worktree", "add"], "-q", "-b", "other", wt);
    const forged = join(tmp.root, "forged");
    await mkdir(forged);
    await writeFile(join(forged, ".git"), await readFile(join(wt, ".git"), "utf8"));
    expect(await gitHead(forged)).toBeUndefined();
  });

  it("throws on a corrupt index", async () => {
    await writeFile(join(repo, ".git", "index"), "not an index at all, definitely not");
    await expect(gitDirtyPaths(repo)).rejects.toThrow();
  });
});

describe("hasPathspec", () => {
  it.each([
    [w("git", "commit", "-m", "x", "--", "a.ts"), true],
    [w("git", "commit", "--amend", "--no-edit"), true],
    [w("git", "commit", "--allow-empty", "-m", "x"), true],
    [w("git", "commit-tree", "abc", "-m", "x"), true],
    [w("pwsh", "-File", "agentq.ps1", "commit", "-Paths", "a"), true],
    ["git status", true],
    [w("git", "commit", "-m", "x"), false],
    [w("cd", "x;", "git", "-C", "y", "commit", "-q"), false],
  ])("%s → %s", (cmd, expected) => {
    expect(hasPathspec(cmd)).toBe(expected);
  });
});

describe("evaluateGit", () => {
  it("refuses a commit without pathspec when required", async () => {
    const cfg = RULES({ requirePathspec: true });
    expect((await evaluateGit(w("git", "commit", "-m", "x"), cfg, repo))?.id).toBe(
      "git.noPathspec",
    );
    expect(await evaluateGit(w("git", "commit", "-m", "x", "--", "a.txt"), cfg, repo)).toBe(
      undefined,
    );
    expect(await evaluateGit(w("git", "commit", "-m", "x"), RULES(), repo)).toBeUndefined();
  });

  it("refuses a deploy-class command on a dirty tree, naming the first dirty path", async () => {
    const cfg = RULES({ cleanTreeFor: ["deploy"] });
    expect(await evaluateGit(DEPLOY, cfg, repo)).toBeUndefined();
    await write("dir/b.txt", "dirty-now\n");
    const v = await evaluateGit(DEPLOY, cfg, repo);
    expect(v?.id).toBe("git.dirtyTree");
    expect(v?.path).toBe("dir/b.txt");
    expect(await evaluateGit("pnpm lint", cfg, repo)).toBeUndefined();
    const viaWrapper = w("pwsh", "-File", "deploy-clean.ps1", "-Command", "'x'");
    expect(await evaluateGit(viaWrapper, cfg, repo)).toBeUndefined();
  });

  it("does not dirty-gate deploy-class reads (guard parity, S-1219)", async () => {
    const cfg = RULES({ cleanTreeFor: ["deploy"], untracked: true });
    await write("dir/b.txt", "dirty-now\n");
    for (const read of [
      w("gcloud", "run", "services", "describe", "svc", "--region", "europe-west1"),
      w("gcloud", "builds", "list", "--limit", "3"),
      w("vercel", "ls"),
    ]) {
      expect(await evaluateGit(read, cfg, repo)).toBeUndefined();
    }
    const mutate = w("gcloud", "run", "services", "replace", "svc.yaml");
    expect((await evaluateGit(mutate, cfg, repo))?.id).toBe("git.dirtyTree");
  });

  it("fails closed when the index cannot be read", async () => {
    await writeFile(join(repo, ".git", "index"), "garbage-garbage-garbage-garbage");
    const v = await evaluateGit(DEPLOY, RULES({ cleanTreeFor: ["deploy"] }), repo);
    expect(v?.id).toBe("git.dirtyTree");
    expect(v?.path).toBeUndefined();
  });

  it("enforces the branch rule for the listed classes only", async () => {
    const cfg = RULES({ branch: { is: "release/*", for: ["deploy"] } });
    expect((await evaluateGit(DEPLOY, cfg, repo))?.id).toBe("git.branch");
    expect(await evaluateGit("pnpm build", cfg, repo)).toBeUndefined();
    await git(repo, "switch", "-q", "-c", "release/2.6");
    expect(await evaluateGit(DEPLOY, cfg, repo)).toBeUndefined();
    await git(repo, "switch", "-q", "--detach", "HEAD");
    expect((await evaluateGit(DEPLOY, cfg, repo))?.id).toBe("git.branch");
  });

  it("has no opinion outside a repository", async () => {
    const plain = join(tmp.root, "plain");
    await mkdir(plain);
    const cfg = RULES({ cleanTreeFor: ["deploy"], requirePathspec: true });
    expect(await evaluateGit(DEPLOY, cfg, plain)).toBeUndefined();
  });

  it("never throws on arbitrary command strings", async () => {
    const cfg = RULES({
      cleanTreeFor: ["deploy", "build"],
      requirePathspec: true,
      branch: { is: "main", for: ["install"] },
    });
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), async (cmd) => {
        const v = await evaluateGit(cmd, cfg, repo);
        expect(v === undefined || typeof v.id === "string").toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
