import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attestDecisions, statementFor } from "./attest.js";
import { callDaemon } from "./daemon-client.js";
import {
  CLAUDE_HOOK_PATH,
  DAEMON_PROTOCOL,
  daemonStatePath,
  GATE_PATH,
  H_PROTOCOL,
  HEALTH_PATH,
  readDaemonState,
} from "./daemon-proto.js";
import { readDecisions } from "./decisions.js";
import { gateMain } from "./gate.js";
import { type RunningDaemon, startDaemon } from "./serve.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

const VERSION = "9.9.9-test";
/** The production client gives up after 1.5 s; on a saturated CI/dev box a test must not. */
const T = 30_000;

let repo: TmpRepo;
let home: TmpRepo;
let root: string;
let d: RunningDaemon | undefined;

beforeEach(async () => {
  repo = await tmpRepo("axiom-serve-");
  home = await tmpRepo("axiom-serve-home-");
  root = await realpath(repo.root);
  await mkdir(join(root, ".git"));
});

afterEach(async () => {
  await d?.close();
  d = undefined;
  await repo.cleanup();
  await home.cleanup();
});

function write(file: string, content = "x\n", cwd = root, session = "s-1") {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: session,
    cwd,
    tool_name: "Write",
    tool_input: { file_path: file, content },
  });
}

async function daemon(extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  d = await startDaemon({ roots: [root], port: 0, version: VERSION, home: home.root, ...extra });
  return d;
}

function raw(
  dm: RunningDaemon,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: dm.host,
        port: dm.port,
        method: opts.method ?? "POST",
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body ?? "");
  });
}

describe("axiom serve --hook (resident gate daemon)", () => {
  it("writes the state file and removes it on close", async () => {
    const dm = await daemon();
    const st = await readDaemonState(home.root);
    expect(st?.port).toBe(dm.port);
    expect(st?.protocol).toBe(DAEMON_PROTOCOL);
    expect(st?.roots).toEqual([root]);
    await dm.close();
    d = undefined;
    await expect(readFile(daemonStatePath(home.root), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a non-loopback bind and an empty root list", async () => {
    await expect(
      startDaemon({ roots: [root], host: "0.0.0.0", port: 0, version: VERSION, noStateFile: true }),
    ).rejects.toMatchObject({ code: "ERR_ROOT_NOT_ALLOWED" });
    await expect(
      startDaemon({ roots: [], port: 0, version: VERSION, noStateFile: true }),
    ).rejects.toMatchObject({ code: "ERR_ROOT_REQUIRED" });
  });

  it("returns exactly what the in-process gate returns (allow and deny, every format)", async () => {
    await daemon();
    let n = 0;
    for (const format of ["auto", "codex", "cursor", "windsurf", "gemini", "cline"]) {
      for (const [file, content] of [
        ["src/ok.ts", "x\n"],
        [".env", "A=1\n"],
      ] as const) {
        n++;
        // The steer hint is once per session: each side gets its own session id.
        const argv = ["--stdin", "--format", format];
        const local = await gateMain(argv, {
          read: { text: write(file, content, root, `L${n}`), timedOut: false, tooLarge: false },
          cwdFallback: () => root,
          home: home.root,
        });
        const remote = await callDaemon({
          argv,
          text: write(file, content, root, `R${n}`),
          stdin: "ok",
          cwd: root,
          version: VERSION,
          home: home.root,
          timeoutMs: T,
        });
        expect(remote).toBeDefined();
        expect(remote?.exitCode).toBe(local.exitCode);
        expect(remote?.stdout ?? "").toBe(local.stdout ?? "");
        expect(local.decision).toBe(file === ".env" ? "deny" : "allow");
      }
    }
  });

  it("no verdict (client must decide) for a cwd outside the roots, another version, or no daemon", async () => {
    const other = await tmpRepo("axiom-serve-other-");
    try {
      const otherReal = await realpath(other.root);
      await daemon();
      const base = { argv: ["--stdin"], stdin: "ok" as const, home: home.root };
      expect(
        await callDaemon({
          ...base,
          text: write("a.ts", "x", otherReal),
          cwd: otherReal,
          version: VERSION,
        }),
      ).toBeUndefined();
      expect(
        await callDaemon({ ...base, text: write("a.ts"), cwd: root, version: "0.0.1" }),
      ).toBeUndefined();
      await d?.close();
      d = undefined;
      expect(
        await callDaemon({ ...base, text: write("a.ts"), cwd: root, version: VERSION }),
      ).toBeUndefined();
    } finally {
      await other.cleanup();
    }
  });

  it("refuses browser origins, foreign Host headers, missing protocol header and bad tokens", async () => {
    const dm = await daemon({ token: "s3cret-token" });
    const ok = { [H_PROTOCOL]: "1", authorization: "Bearer s3cret-token" };
    expect(
      (await raw(dm, { path: GATE_PATH, headers: { ...ok, origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect(
      (await raw(dm, { path: GATE_PATH, headers: { ...ok, host: "evil.example:47861" } })).status,
    ).toBe(403);
    expect((await raw(dm, { path: GATE_PATH, headers: { [H_PROTOCOL]: "1" } })).status).toBe(401);
    expect(
      (await raw(dm, { path: GATE_PATH, headers: { authorization: "Bearer s3cret-token" } }))
        .status,
    ).toBe(409);
    const health = await raw(dm, { method: "GET", path: HEALTH_PATH, headers: ok });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ protocol: DAEMON_PROTOCOL, roots: [root] });
  });

  it("serves the Claude HTTP hook: deny JSON for a protected path, empty body for an allowed one", async () => {
    const dm = await daemon();
    const deny = await raw(dm, { path: CLAUDE_HOOK_PATH, body: write(".env", "A=1\n") });
    expect(deny.status).toBe(200);
    expect(JSON.parse(deny.body).hookSpecificOutput.permissionDecision).toBe("deny");
    const outside = await raw(dm, {
      path: CLAUDE_HOOK_PATH,
      body: write("a.ts", "x", join(root, "..")),
    });
    expect(outside.status).toBe(421);
  });

  it("answers a burst of concurrent hook calls", async () => {
    await daemon();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        callDaemon({
          argv: ["--stdin"],
          text: write(i % 2 === 0 ? `src/f${i}.ts` : ".env"),
          stdin: "ok",
          cwd: root,
          version: VERSION,
          home: home.root,
          timeoutMs: T,
        }),
      ),
    );
    expect(results.every((r) => r !== undefined)).toBe(true);
    const denies = results.filter((r) => r?.stdout.includes('"deny"')).length;
    expect(denies).toBe(20);
  });
});

describe("axiom attest decisions", () => {
  it("turns recorded gate decisions into agent-decision Statements", async () => {
    await mkdir(join(root, ".axiom"), { recursive: true });
    await writeFile(
      join(root, ".axiom", "gate-profile.json"),
      JSON.stringify({ deny: [".env"], record: true }),
    );
    for (const p of [write("src/a.ts"), write(".env", "A=1\n")]) {
      await gateMain(["--stdin"], {
        read: { text: p, timedOut: false, tooLarge: false },
        cwdFallback: () => root,
        home: home.root,
      });
    }
    const recs = await readDecisions(root);
    expect(recs.map((r) => r.decision)).toEqual(["allow", "deny"]);
    const rows = await attestDecisions({ root });
    expect(rows).toHaveLength(2);
    const st = statementFor(recs[1] as (typeof recs)[number]);
    expect(st._type).toBe("https://in-toto.io/Statement/v1");
    expect(st.predicate.policy_evaluations[0]?.decision).toBe("deny");
    expect(st.subject[0]?.digest.sha256).toBe(st.predicate.tool_calls[0]?.args_hash.slice(7));
  });

  it("refuses to sign without a key (ERR_NOT_FOUND)", async () => {
    await expect(attestDecisions({ root, sign: { env: {} } })).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
    });
  });
});
