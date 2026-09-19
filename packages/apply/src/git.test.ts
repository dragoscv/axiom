import cp, { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import * as path from "node:path";
import type { ManifestBundle } from "@codai/axiom-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "./apply.js";
import {
  buildCompareUrl,
  defaultBranchName,
  parseRemote,
  scrubEnv,
  validateBranchNameSyntax,
} from "./git.js";
import { exists, makeBundle, mkRoot, readText, writeTree } from "./test-helpers.js";

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
} catch {
  gitAvailable = false;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function mkRepo(): Promise<string> {
  const root = await mkRoot();
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "axiom@test.invalid"]);
  git(root, ["config", "user.name", "axiom test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  await writeTree(root, { "keep.txt": "keep\n", "old.txt": "bye\n", "over.txt": "v1\n" });
  git(root, ["add", "--", "keep.txt", "old.txt", "over.txt"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function bundleOf(): ManifestBundle {
  return makeBundle(
    [
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { path: "over.txt", content: "v2\n", op: "overwrite" },
      { path: "old.txt", op: "delete" },
    ],
    { name: "demo" },
  );
}

function prApply(
  bundle: ManifestBundle,
  root: string,
  extra: Partial<Parameters<typeof apply>[0]> = {},
) {
  return apply({ bundle, root, mode: "pr", confirmDigest: bundle.manifestDigest, ...extra });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("branch name syntax (pure)", () => {
  const corpus = [
    ";rm -rf /",
    "--upload-pack=x",
    "a..b",
    "-x",
    "a/",
    "/a",
    "a.lock",
    "x@{1}",
    "`id`",
    "$(id)",
    "with space",
    "ünïcode",
    "a//b",
    "",
    "a".repeat(121),
    "a/.hidden",
    "a.",
  ];
  for (const name of corpus) {
    it(`rejects ${JSON.stringify(name)} without spawning`, () => {
      const spy = vi.spyOn(cp, "spawn");
      expect(() => validateBranchNameSyntax(name)).toThrowError(
        expect.objectContaining({ code: "ERR_GIT_BRANCH_INVALID" }),
      );
      expect(spy).not.toHaveBeenCalled();
    });
  }
  it("accepts the deterministic default", () => {
    const b = defaultBranchName("demo", `sha256:${"ab".repeat(32)}`);
    expect(b).toBe("axiom/demo/abababababab");
    expect(() => validateBranchNameSyntax(b)).not.toThrow();
  });
});

describe("env scrub", () => {
  it("drops GIT_DIR/GIT_WORK_TREE and unrelated vars, forces prompts off", () => {
    const env = scrubEnv({
      PATH: "/bin",
      HOME: "/h",
      GIT_DIR: "/garbage",
      GIT_WORK_TREE: "/garbage",
      GIT_AUTHOR_NAME: "x",
      SECRET_TOKEN: "s",
      LC_ALL: "ro_RO",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GIT_AUTHOR_NAME: "x",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
      LC_ALL: "C",
    });
  });
});

describe("compare url", () => {
  it("parses GitHub https/ssh and GitLab; ignores others", () => {
    expect(parseRemote("https://github.com/o/r.git")).toEqual({
      kind: "github",
      base: "https://github.com",
      owner: "o",
      repo: "r",
    });
    expect(parseRemote("git@github.com:o/r.git")?.kind).toBe("github");
    expect(parseRemote("https://gitlab.com/g/sub/r.git")).toEqual({
      kind: "gitlab",
      base: "https://gitlab.com",
      owner: "g/sub",
      repo: "r",
    });
    expect(parseRemote("https://example.com/o/r.git")).toBeUndefined();
    expect(parseRemote("/local/path")).toBeUndefined();
    expect(buildCompareUrl(parseRemote("git@github.com:o/r.git"), "main", "axiom/x/abc")).toBe(
      "https://github.com/o/r/compare/main...axiom/x/abc?expand=1",
    );
    expect(buildCompareUrl(parseRemote("git@gitlab.com:g/r.git"), "main", "axiom/x/abc")).toBe(
      "https://gitlab.com/g/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=axiom%2Fx%2Fabc",
    );
  });
});

describe.skipIf(!gitAvailable)("PR mode (real git)", () => {
  it("happy path: deterministic branch, commits exactly the touched paths, clean tree after", async () => {
    const root = await mkRepo();
    const bundle = bundleOf();
    const spy = vi.spyOn(cp, "spawn");
    const r = await prApply(bundle, root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("applied");
    expect(r.mode).toBe("pr");
    const expectedBranch = `axiom/demo/${bundle.manifestDigest.slice(7, 19)}`;
    expect(r.git?.branch).toBe(expectedBranch);
    expect(r.git?.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(r.git?.compareUrl).toBeUndefined(); // no origin
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(expectedBranch);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(r.git?.commit);
    const status = git(root, ["show", "--name-status", "--format=", "HEAD"])
      .trim()
      .split("\n")
      .map((l) => l.replace(/\s+/g, " "))
      .sort();
    expect(status).toEqual(["A src/a.ts", "D old.txt", "M over.txt"]);
    expect(
      git(root, ["status", "--porcelain", "--", "src", "old.txt", "over.txt", "keep.txt"]),
    ).toBe("");
    expect(await readText(root, "over.txt")).toBe("v2\n");
    expect(await exists(root, "old.txt")).toBe(false);
    // spawn-arg snapshot: shell false, no interpolation, message via stdin
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      const [cmd, args, opts] = call as unknown as [string, string[], cp.SpawnOptions];
      expect(cmd).toBe("git");
      expect(opts.shell).toBe(false);
      for (const a of args) expect(a).not.toMatch(/[;&|`$<>]/);
      if (args[0] === "commit") expect(args).toEqual(["commit", "--quiet", "-F", "-"]);
    }
    const msg = git(root, ["log", "-1", "--format=%B"]);
    expect(msg).toContain(`axiom: apply demo (${bundle.manifestDigest.slice(7, 19)})`);
    expect(msg).toContain(`Manifest: ${bundle.manifestDigest}`);
  });

  it("commit message with dash-prefix, --amend, newlines and backticks lands verbatim", async () => {
    const root = await mkRepo();
    const bundle = bundleOf();
    const commitMessage = "-x --amend\n\n`id` $(id)\nline3";
    const r = await prApply(bundle, root, { commitMessage, branch: "feature/msg" });
    expect(r.status).toBe("applied");
    expect(git(root, ["log", "-1", "--format=%B"]).trimEnd()).toBe(commitMessage);
    expect(git(root, ["log", "--oneline"]).trim().split("\n")).toHaveLength(2);
  });

  it("dirty touched path → ERR_GIT_DIRTY, no branch created, tree untouched", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "over.txt"), "dirty\n");
    const bundle = bundleOf();
    const r = await prApply(bundle, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_GIT_DIRTY");
    expect(git(root, ["branch", "--list"]).trim()).toBe("* main");
    expect(await readText(root, "over.txt")).toBe("dirty\n");
    expect(await exists(root, "src/a.ts")).toBe(false);
  });

  it("dirty UNRELATED path → still succeeds and is not committed", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "keep.txt"), "someone else's edit\n");
    await writeTree(root, { "scratch/untracked.txt": "x" });
    const bundle = bundleOf();
    const r = await prApply(bundle, root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("applied");
    const committed = git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
    expect(committed).not.toContain("keep.txt");
    expect(committed).not.toContain("scratch/untracked.txt");
    expect(await readText(root, "keep.txt")).toBe("someone else's edit\n");
  });

  it("branch exists → ERR_GIT_BRANCH_EXISTS", async () => {
    const root = await mkRepo();
    const bundle = bundleOf();
    git(root, ["branch", `axiom/demo/${bundle.manifestDigest.slice(7, 19)}`]);
    const r = await prApply(bundle, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_GIT_BRANCH_EXISTS");
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(await exists(root, "src/a.ts")).toBe(false);
  });

  it("not a repo → ERR_GIT_NOT_REPO", async () => {
    const root = await mkRoot();
    const r = await prApply(makeBundle([{ path: "a.txt", content: "a" }]), root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_GIT_NOT_REPO");
    expect(await exists(root, "a.txt")).toBe(false);
  });

  it("subdirectory of a repo (not toplevel) → ERR_GIT_NOT_REPO", async () => {
    const repo = await mkRepo();
    const sub = path.join(repo, "sub");
    await fs.mkdir(sub);
    const r = await prApply(makeBundle([{ path: "a.txt", content: "a" }]), sub);
    expect(r.error?.code).toBe("ERR_GIT_NOT_REPO");
  });

  it("injection corpus via apply → ERR_GIT_BRANCH_INVALID and git never spawned", async () => {
    const root = await mkRepo();
    const bundle = bundleOf();
    for (const branch of [";rm -rf /", "--upload-pack=x", "a..b", "-x", "a/", "x@{1}", "$(id)"]) {
      const spy = vi.spyOn(cp, "spawn");
      const r = await prApply(bundle, root, { branch });
      expect(r.error?.code).toBe("ERR_GIT_BRANCH_INVALID");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(git(root, ["branch", "--list"]).trim()).toBe("* main");
  });

  it("GIT_DIR garbage in process.env is scrubbed", async () => {
    const root = await mkRepo();
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(root, "definitely-not-a-repo");
    try {
      const r = await prApply(bundleOf(), root);
      expect(r.error).toBeUndefined();
      expect(r.status).toBe("applied");
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });

  it("compareUrl derived from a GitHub origin, default branch from origin/HEAD", async () => {
    const root = await mkRepo();
    git(root, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    git(root, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    const bundle = bundleOf();
    const r = await prApply(bundle, root);
    expect(r.status).toBe("applied");
    expect(r.git?.compareUrl).toBe(
      `https://github.com/acme/widgets/compare/develop...axiom/demo/${bundle.manifestDigest.slice(7, 19)}?expand=1`,
    );
  });

  it("re-applying the same digest is a noop and does not create a second branch", async () => {
    const root = await mkRepo();
    const bundle = bundleOf();
    const r1 = await prApply(bundle, root);
    expect(r1.status).toBe("applied");
    git(root, ["switch", "-q", "main"]);
    git(root, ["merge", "-q", "--ff-only", r1.git?.branch ?? ""]);
    const r2 = await prApply(bundle, root, { branch: "second" });
    expect(r2.error).toBeUndefined();
    expect(r2.status).toBe("noop");
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(git(root, ["branch", "--list", "second"]).trim()).toBe("");
  });

  it("fs apply failure in PR mode returns to the original branch and drops the axiom branch", async () => {
    const root = await mkRepo();
    const bundle = makeBundle([{ path: "keep.txt", content: "x", op: "create" }]); // exists → ERR_EXISTS
    const r = await prApply(bundle, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_EXISTS");
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(git(root, ["branch", "--list"]).trim()).toBe("* main");
  });

  it("ERR_GIT_NOT_FOUND when the git executable is missing (spawn ENOENT) — apply fails before any write", async () => {
    const root = await mkRepo();
    const bundle = bundleOf();
    const spy = vi.spyOn(cp, "spawn").mockImplementation(() => {
      const child = new EventEmitter() as unknown as cp.ChildProcess;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
        kill: () => true,
      });
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })),
      );
      return child;
    });
    let r: Awaited<ReturnType<typeof prApply>>;
    try {
      r = await prApply(bundle, root);
    } finally {
      spy.mockRestore();
    }
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_GIT_NOT_FOUND");
    expect(await exists(root, "src/a.ts")).toBe(false);
    expect(await readText(root, "over.txt")).toBe("v1\n");
  });

  it("ERR_GIT_FAILED when git exits non-zero (root is not a repository); stderr head in message, no write", async () => {
    const root = await mkRoot(); // no `git init`
    await writeTree(root, { "over.txt": "v1\n", "old.txt": "bye\n" });
    const r = await prApply(bundleOf(), root);
    expect(r.status).toBe("failed");
    // `rev-parse --show-toplevel` outside a repo exits 128 → mapped to ERR_GIT_NOT_REPO by the
    // preflight; the raw runGit surface is what carries ERR_GIT_FAILED, so probe that too.
    expect(["ERR_GIT_NOT_REPO", "ERR_GIT_FAILED"]).toContain(r.error?.code);
    const { runGit } = await import("./git.js");
    await expect(
      runGit(root, ["rev-parse", "--verify", "definitely-not-a-ref"]),
    ).rejects.toMatchObject({
      code: "ERR_GIT_FAILED",
      details: expect.objectContaining({ code: expect.any(Number) }),
    });
    expect(await exists(root, "src/a.ts")).toBe(false);
  });

  it("ERR_GIT_FAILED on timeout: the hung child is killed and details carry timeoutMs", async () => {
    const root = await mkRepo();
    const { runGit } = await import("./git.js");
    let killed = 0;
    const spy = vi.spyOn(cp, "spawn").mockImplementation(() => {
      const child = new EventEmitter() as unknown as cp.ChildProcess;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
        kill: () => {
          killed++;
          queueMicrotask(() => child.emit("close", null));
          return true;
        },
      });
      return child; // never emits close on its own → the timer must fire
    });
    try {
      await expect(runGit(root, ["status"], { timeoutMs: 50 })).rejects.toMatchObject({
        code: "ERR_GIT_FAILED",
        details: expect.objectContaining({ timeoutMs: 50 }),
      });
    } finally {
      spy.mockRestore();
    }
    expect(killed).toBe(1);
  });
});
