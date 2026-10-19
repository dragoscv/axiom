import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callDaemon } from "./daemon-client.js";
import { DAEMON_PROTOCOL, daemonStatePath } from "./daemon-proto.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

const VERSION = "9.9.9-test";
const T = 30_000;
const KEY = "ab".repeat(32);

let repo: TmpRepo;
let home: TmpRepo;
let root: string;
const realEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AXIOM_GATE_DAEMON_STRICT: process.env.AXIOM_GATE_DAEMON_STRICT,
};
const servers: http.Server[] = [];

beforeEach(async () => {
  repo = await tmpRepo("axiom-dc-");
  home = await tmpRepo("axiom-dc-home-");
  root = await realpath(repo.root);
  await mkdir(join(root, ".git"));
  // The owner's real ~/.axiom must never leak into these tests.
  process.env.HOME = home.root;
  process.env.USERPROFILE = home.root;
  delete process.env.AXIOM_GATE_DAEMON_STRICT;
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const [k, v] of Object.entries(realEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await repo.cleanup();
  await home.cleanup();
});

interface Hit {
  headers: http.IncomingHttpHeaders;
}

/** A local process squatting the daemon port: always "allow", no MAC (it does not know the key). */
async function squatter(): Promise<{ port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push({ headers: req.headers });
      res.writeHead(200, { "x-axiom-exit": "0", "content-type": "application/json" });
      res.end("");
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { port, hits };
}

async function writeState(fields: Record<string, unknown>): Promise<string> {
  const file = daemonStatePath(home.root);
  await mkdir(join(home.root, ".axiom"), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      protocol: DAEMON_PROTOCOL,
      pid: process.pid,
      host: "127.0.0.1",
      version: VERSION,
      roots: [root],
      startedAt: new Date().toISOString(),
      key: KEY,
      token: "leak-me-if-you-can-0123456789",
      ...fields,
    }),
    { mode: 0o600 },
  );
  return file;
}

const envWrite = () =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s",
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: ".env", content: "A=1\n" },
  });

function call(argv: string[] = ["--stdin", "--deny-exit", "2"]) {
  return callDaemon({
    argv,
    text: envWrite(),
    stdin: "ok",
    cwd: root,
    version: VERSION,
    home: home.root,
    timeoutMs: T,
  });
}

describe("daemon client — protocol 2 (squatting, stale state)", () => {
  it("never takes an allow from a squatter that cannot MAC the answer, and never sends it a token", async () => {
    const sq = await squatter();
    await writeState({ port: sq.port });
    const v = await call();
    expect(sq.hits.length).toBe(1);
    expect(sq.hits[0]?.headers.authorization).toBeUndefined();
    // undefined = no verdict → the caller runs the in-process gate (which denies `.env`).
    expect(v).toBeUndefined();
  });

  it("AXIOM_GATE_DAEMON_STRICT=1 turns an unauthenticated answer into a fail-closed deny", async () => {
    process.env.AXIOM_GATE_DAEMON_STRICT = "1";
    const sq = await squatter();
    await writeState({ port: sq.port });
    const v = await call(["--stdin", "--format", "cline", "--deny-exit", "2"]);
    expect(v?.exitCode).toBe(2);
    expect(v?.stderr.join("\n")).toContain("ERR_DAEMON_AUTH");
    expect(JSON.parse(v?.stdout ?? "{}")).toMatchObject({ cancel: true });
  });

  it("a state file whose pid is dead is deleted and yields no verdict without connecting", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid ?? 0;
    await new Promise<void>((r) => child.on("exit", () => r()));
    const sq = await squatter();
    const file = await writeState({ port: sq.port, pid: deadPid });
    expect(await call()).toBeUndefined();
    expect(sq.hits.length).toBe(0);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a group/other-readable state file (POSIX)",
    async () => {
      const sq = await squatter();
      const file = await writeState({ port: sq.port });
      const { chmod } = await import("node:fs/promises");
      await chmod(file, 0o644);
      expect(await call()).toBeUndefined();
      expect(sq.hits.length).toBe(0);
    },
  );
});
