/**
 * S-1412: the native hook client must be FINDABLE and must actually answer before init wires it
 * (A3-3: `init --daemon` wrote a bare `axiom-hook` that npm never puts on PATH, so every tool call
 * was denied or failed open while doctor stayed green), and one daemon state file must not be
 * stolen from a live daemon (A2-28).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiomError } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonStatePath, readDaemonState } from "./daemon-proto.js";
import {
  ENV_HOOK_BIN,
  hookPackageName,
  isVerdictDocument,
  nodeHookBin,
  resolveHookBin,
  resolveHookProgram,
  selfTestHook,
} from "./hook-bin.js";
import { startDaemon } from "./serve.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "axiom-hookbin-"));
});
afterEach(async () => {
  // Best effort: a child process killed by the self-test timeout may still hold the directory.
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** A `node` programme that runs `body`, for the self-test cases (no native binary needed). */
async function fakeCli(name: string, body: string): Promise<string> {
  const file = join(dir, `${name}.js`);
  await writeFile(file, body, "utf8");
  return file;
}

const honest = "process.exit(0);";
const crash = "process.exit(3);";
const garbage =
  "process.stdout.write('not json at all');process.exitCode=0;setTimeout(()=>process.exit(0),0);";
const hang = "setTimeout(() => process.exit(0), 60000);";

describe("hook-bin resolution (A3-3)", () => {
  it("prefers AXIOM_HOOK_BIN when it names a real file", async () => {
    const exe = await fakeCli("override", honest);
    expect(await resolveHookBin({ [ENV_HOOK_BIN]: exe })).toEqual({ path: exe, kind: "native" });
    // A path that does not exist must not be trusted: the install would call nothing.
    const missing = await resolveHookBin({ [ENV_HOOK_BIN]: join(dir, "nope.exe"), PATH: "" });
    expect(missing).toBeUndefined();
  });

  it("resolves a bare name against PATH, with PATHEXT on Windows", async () => {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const exe = join(bin, "axiom-hook.cmd");
    await writeFile(exe, "@echo off", "utf8");
    expect(await resolveHookProgram("axiom-hook", { PATH: bin, OS: "Windows_NT" })).toBe(exe);
    // POSIX looks for the exact name, so the Windows shim is not it.
    expect(await resolveHookProgram("axiom-hook", { PATH: bin, OS: "Linux" })).toBeUndefined();
  });

  it("does not invent a client when the platform package is not installed", async () => {
    // The workspace links @codai/axiom-hook-win32-x64 but ships no bin/ in the repo, and an empty
    // PATH hides anything else: the honest answer is "none".
    expect(await resolveHookBin({ PATH: "" })).toBeUndefined();
  });

  it("names the platform package the way npm does", () => {
    expect(hookPackageName("win32", "x64")).toBe("@codai/axiom-hook-win32-x64");
    expect(hookPackageName("linux", "arm64")).toBe("@codai/axiom-hook-linux-arm64");
  });

  it("keeps the node client available as the fallback", () => {
    const bin = nodeHookBin("C:/node/node.exe", "C:/axiom/cli.js");
    expect(bin).toEqual({ path: "C:/node/node.exe", kind: "node", version: "C:/axiom/cli.js" });
  });
});

describe("hook self-test (D-51)", () => {
  const run = (cli: string, timeoutMs = 5_000) => {
    const bin = nodeHookBin(process.execPath, cli);
    return selfTestHook(bin, { cwd: dir, timeoutMs });
  };

  it("passes when the client answers a deny/allow verdict", async () => {
    const r = await run(await fakeCli("allow", honest));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.ms).toBeGreaterThan(0);
  });

  it("fails when the client crashes instead of deciding", async () => {
    expect(await run(await fakeCli("crash", crash))).toMatchObject({
      ok: false,
      reason: "bad-verdict",
    });
  });

  it("fails when the client prints something that is not a verdict document", async () => {
    expect(await run(await fakeCli("garbage", garbage))).toMatchObject({
      ok: false,
      reason: "bad-verdict",
    });
  });

  it("fails when the client never returns", async () => {
    expect(await run(await fakeCli("hang", hang), 700)).toMatchObject({
      ok: false,
      reason: "spawn-failed",
    });
  });

  it("fails when the programme does not exist", async () => {
    const r = await selfTestHook(nodeHookBin(process.execPath, join(dir, "missing.js")), {
      cwd: dir,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts an empty stdout as an allow and a deny document as a verdict", () => {
    expect(isVerdictDocument("")).toBe(true);
    expect(isVerdictDocument("\n")).toBe(true);
    expect(isVerdictDocument('{"permissionDecision":"deny"}')).toBe(true);
    expect(isVerdictDocument('{"decision":"ask"}')).toBe(true);
    expect(isVerdictDocument('{"cancel":true}')).toBe(true);
    expect(isVerdictDocument("AXIOM GATE DENY nope")).toBe(false);
    expect(isVerdictDocument("{}")).toBe(false);
  });
});

describe("one daemon state (A2-28)", () => {
  /** A live process that is not this one, standing in for a running daemon. */
  const liveChild = (): { pid: number; stop: () => void } => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], {
      stdio: "ignore",
    });
    return { pid: child.pid ?? 0, stop: () => child.kill() };
  };

  const writeState = async (pid: number): Promise<void> => {
    await mkdir(join(dir, ".axiom"), { recursive: true });
    await writeFile(
      daemonStatePath(dir),
      JSON.stringify({
        protocol: 2,
        pid,
        host: "127.0.0.1",
        port: 47861,
        version: "4.0.0-test",
        roots: [dir],
        startedAt: "2026-11-17T00:00:00.000Z",
        key: "a".repeat(64),
      }),
    );
  };

  it("refuses to start over a live daemon, and --force replaces it", async () => {
    const other = liveChild();
    try {
      await writeState(other.pid);
      // A second daemon would rewrite the file and orphan the first (which keeps its port and key).
      const err = await startDaemon({
        roots: [dir],
        port: 0,
        version: "4.0.0-test",
        home: dir,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AxiomError);
      expect((err as AxiomError).code).toBe("ERR_LOCKED");
      expect((err as AxiomError).details).toMatchObject({ pid: other.pid });
      // The live daemon's own state file was NOT touched.
      expect((await readDaemonState(dir))?.pid).toBe(other.pid);

      const forced = await startDaemon({
        roots: [dir],
        port: 0,
        version: "4.0.0-test",
        home: dir,
        force: true,
      });
      try {
        expect((await readDaemonState(dir))?.pid).toBe(process.pid);
      } finally {
        await forced.close();
      }
    } finally {
      other.stop();
    }
  });

  it("starts normally when the recorded daemon is gone", async () => {
    await writeState(0x7ffffff0);
    const d = await startDaemon({ roots: [dir], port: 0, version: "4.0.0-test", home: dir });
    try {
      expect((await readDaemonState(dir))?.pid).toBe(process.pid);
      expect(d.port).toBeGreaterThan(0);
    } finally {
      await d.close();
    }
  });
});
