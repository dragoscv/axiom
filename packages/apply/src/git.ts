/**
 * Git PR mode (§4.3) — **no shell**. Every git invocation is
 * `spawn("git", args, { shell: false })` with a scrubbed env; the commit
 * message travels on stdin (`-F -`), never as an argv token.
 */
import childProcess from "node:child_process";
import { AxiomError, type DigestRef } from "@codai/axiom-schema";
import { IS_WIN32 } from "./fsx.js";
import { realpathNative } from "./realpath.js";

export interface GitRunOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export const GIT_TIMEOUT_MS = 60_000;
const STDERR_TAIL_BYTES = 4096;

/** Env whitelist: PATH, HOME, USERPROFILE, SYSTEMROOT, TEMP/TMP, GIT_* minus GIT_DIR/GIT_WORK_TREE. */
export function scrubEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const keep = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP"]);
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (keep.has(upper)) {
      out[k] = v;
    } else if (
      upper.startsWith("GIT_") &&
      upper !== "GIT_DIR" &&
      upper !== "GIT_WORK_TREE" &&
      upper !== "GIT_INDEX_FILE"
    ) {
      out[k] = v;
    }
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_ASKPASS = "echo";
  out.LC_ALL = "C";
  return out;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/** Run git in `rootReal`. Rejects with AxiomError ERR_GIT_NOT_FOUND / ERR_GIT_FAILED. */
export function runGit(
  rootReal: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = childProcess.spawn("git", [...args], {
      shell: false,
      windowsHide: true,
      cwd: rootReal,
      env: scrubEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish(() => {
        if (e.code === "ENOENT") {
          reject(
            new AxiomError("ERR_GIT_NOT_FOUND", "git executable not found on PATH", { cause: e }),
          );
        } else {
          reject(
            new AxiomError("ERR_GIT_FAILED", `git could not be started: ${e.message}`, {
              cause: e,
              details: { args: [...args] },
            }),
          );
        }
      });
    });
    child.on("close", (code) => {
      finish(() => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderrFull = Buffer.concat(err).toString("utf8");
        const stderr = stderrFull.slice(-STDERR_TAIL_BYTES);
        if (timedOut) {
          reject(
            new AxiomError(
              "ERR_GIT_FAILED",
              `git ${args[0] ?? ""} timed out after ${timeoutMs} ms`,
              {
                details: { args: [...args], stderr, timeoutMs },
              },
            ),
          );
          return;
        }
        const exit = code ?? -1;
        if (exit !== 0) {
          const head = firstLine(stderr);
          reject(
            new AxiomError(
              "ERR_GIT_FAILED",
              `git ${args[0] ?? ""} exited ${exit}${head === "" ? "" : `: ${head}`}`,
              { details: { args: [...args], code: exit, stderr } },
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: exit });
      });
    });
    if (opts.stdin !== undefined) {
      child.stdin.on("error", () => {
        /* EPIPE when git exits early; the close handler reports the real error */
      });
      child.stdin.end(opts.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;

/** Pure part of branch validation — no process is spawned. Throws ERR_GIT_BRANCH_INVALID. */
export function validateBranchNameSyntax(name: string): void {
  const bad =
    !BRANCH_RE.test(name) ||
    name.includes("..") ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("@{") ||
    name.includes("//") ||
    name.split("/").some((seg) => seg === "" || seg.startsWith(".") || seg.endsWith(".lock"));
  if (bad) {
    throw new AxiomError("ERR_GIT_BRANCH_INVALID", "branch name is not acceptable", {
      details: { branch: name },
    });
  }
}

/** Regex + `git check-ref-format --branch <name>` (name is an argv element, never interpolated). */
export async function validateBranchName(rootReal: string, name: string): Promise<void> {
  validateBranchNameSyntax(name);
  try {
    await runGit(rootReal, ["check-ref-format", "--branch", name]);
  } catch (err) {
    if (err instanceof AxiomError && err.code === "ERR_GIT_FAILED") {
      throw new AxiomError("ERR_GIT_BRANCH_INVALID", "git rejected the branch name", {
        cause: err,
        details: { branch: name },
      });
    }
    throw err;
  }
}

export function digest12(d: DigestRef): string {
  return d.slice("sha256:".length, "sha256:".length + 12);
}

/** Deterministic default: `axiom/<name>/<digest hex 0..12>`. */
export function defaultBranchName(planName: string, manifestDigest: DigestRef): string {
  return `axiom/${planName}/${digest12(manifestDigest)}`;
}

export function defaultCommitMessage(
  planName: string,
  manifestDigest: DigestRef,
  planDigest: DigestRef,
): string {
  return `axiom: apply ${planName} (${digest12(manifestDigest)})\n\nManifest: ${manifestDigest}\nPlan: ${planDigest}\n`;
}

function normalizeForCompare(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (IS_WIN32) s = s.toLowerCase();
  return s.replace(/\/+$/, "");
}

/** `git rev-parse --show-toplevel` must be `rootReal` itself (not a parent). */
export async function assertRepoToplevel(rootReal: string): Promise<void> {
  let top: string;
  try {
    top = (await runGit(rootReal, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (err) {
    if (err instanceof AxiomError && err.code === "ERR_GIT_FAILED") {
      throw new AxiomError("ERR_GIT_NOT_REPO", "root is not inside a git work tree", {
        cause: err,
        details: { root: rootReal },
      });
    }
    throw err;
  }
  let topReal = top;
  try {
    topReal = await realpathNative(top);
  } catch {
    /* compare as reported */
  }
  if (IS_WIN32 && topReal.startsWith("\\\\?\\")) topReal = topReal.slice(4);
  if (normalizeForCompare(topReal) !== normalizeForCompare(rootReal)) {
    throw new AxiomError("ERR_GIT_NOT_REPO", "root is not the top level of its git work tree", {
      details: { root: rootReal, toplevel: topReal },
    });
  }
}

/** `git status --porcelain -- <paths>` must be empty for the touched paths only. */
export async function assertPathsClean(rootReal: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const { stdout } = await runGit(rootReal, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...paths,
  ]);
  const dirty = stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  if (dirty.length > 0) {
    throw new AxiomError("ERR_GIT_DIRTY", "touched paths have uncommitted changes", {
      details: { dirty },
    });
  }
}

export async function branchExists(rootReal: string, branch: string): Promise<boolean> {
  try {
    await runGit(rootReal, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (err) {
    if (err instanceof AxiomError && err.code === "ERR_GIT_FAILED") return false;
    throw err;
  }
}

/** Parse a GitHub / GitLab remote into `{host, owner, repo}`; undefined otherwise. */
export function parseRemote(
  url: string,
): { kind: "github" | "gitlab"; base: string; owner: string; repo: string } | undefined {
  const u = url.trim();
  let host: string | undefined;
  let pathPart: string | undefined;
  let m = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u);
  if (m) {
    host = m[1];
    pathPart = m[2];
  } else {
    m = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(u);
    if (m) {
      host = m[1];
      pathPart = m[2];
    }
  }
  if (host === undefined || pathPart === undefined) return undefined;
  const p = pathPart.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const segs = p.split("/");
  if (segs.length < 2 || segs.some((s) => s === "")) return undefined;
  const h = host.toLowerCase();
  if (h === "github.com" && segs.length === 2) {
    return {
      kind: "github",
      base: "https://github.com",
      owner: segs[0] ?? "",
      repo: segs[1] ?? "",
    };
  }
  if (h === "gitlab.com" || h.startsWith("gitlab.")) {
    const owner = segs.slice(0, -1).join("/");
    return { kind: "gitlab", base: `https://${h}`, owner, repo: segs[segs.length - 1] ?? "" };
  }
  return undefined;
}

export function buildCompareUrl(
  remote: ReturnType<typeof parseRemote>,
  defaultBranch: string,
  branch: string,
): string | undefined {
  if (remote === undefined) return undefined;
  const enc = (s: string): string => s.split("/").map(encodeURIComponent).join("/");
  if (remote.kind === "github") {
    return `${remote.base}/${enc(remote.owner)}/${enc(remote.repo)}/compare/${enc(defaultBranch)}...${enc(branch)}?expand=1`;
  }
  return `${remote.base}/${enc(remote.owner)}/${enc(remote.repo)}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}

/** compareUrl from `origin`, or undefined. Never throws (no network). */
export async function compareUrlFor(rootReal: string, branch: string): Promise<string | undefined> {
  let url: string;
  try {
    url = (await runGit(rootReal, ["remote", "get-url", "origin"])).stdout.trim();
  } catch {
    return undefined;
  }
  const remote = parseRemote(url);
  if (remote === undefined) return undefined;
  let def = "main";
  try {
    const ref = (
      await runGit(rootReal, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    ).stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix) && ref.length > prefix.length) def = ref.slice(prefix.length);
  } catch {
    /* fallback "main" */
  }
  return buildCompareUrl(remote, def, branch);
}

export async function currentBranch(rootReal: string): Promise<string | undefined> {
  try {
    const b = (
      await runGit(rootReal, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    ).stdout.trim();
    return b === "" ? undefined : b;
  } catch {
    return undefined;
  }
}

export async function headCommit(rootReal: string): Promise<string> {
  const sha = (await runGit(rootReal, ["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new AxiomError("ERR_GIT_FAILED", "git rev-parse HEAD did not return a 40-hex sha", {
      details: { stdout: sha },
    });
  }
  return sha;
}
