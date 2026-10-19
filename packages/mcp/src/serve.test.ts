import { randomBytes } from "node:crypto";
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
  H_CWD,
  H_MAC,
  H_NONCE,
  H_PROTOCOL,
  HEALTH_PATH,
  readDaemonState,
  verifyDaemonMac,
} from "./daemon-proto.js";
import { readDecisions } from "./decisions.js";
import { gateMain } from "./gate.js";
import type { GateSpanInput, OtelExporter } from "./otel.js";
import { type RunningDaemon, startDaemon } from "./serve.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

const VERSION = "9.9.9-test";
/** The production client gives up after 1.5 s; on a saturated CI/dev box a test must not. */
const T = 30_000;

let repo: TmpRepo;
let home: TmpRepo;
let root: string;
let d: RunningDaemon | undefined;
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(async () => {
  repo = await tmpRepo("axiom-serve-");
  home = await tmpRepo("axiom-serve-home-");
  root = await realpath(repo.root);
  await mkdir(join(root, ".git"));
  // The daemon's gate falls back to ~/.axiom/gate-profile.json; keep the real one out.
  process.env.HOME = home.root;
  process.env.USERPROFILE = home.root;
});

afterEach(async () => {
  await d?.close();
  d = undefined;
  for (const [k, v] of Object.entries(realHome)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
    // protocol 2: a fresh 32-byte key per start, never the --token-env value.
    expect(st?.key).toMatch(/^[0-9a-f]{64}$/);
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

  it("refuses browser origins, foreign Host headers, missing protocol header and wrong tokens", async () => {
    const dm = await daemon({ token: "s3cret-token" });
    const ok = { [H_PROTOCOL]: String(DAEMON_PROTOCOL), authorization: "Bearer s3cret-token" };
    expect(
      (await raw(dm, { path: GATE_PATH, headers: { ...ok, origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect(
      (await raw(dm, { path: GATE_PATH, headers: { ...ok, host: "evil.example:47861" } })).status,
    ).toBe(403);
    // A wrong bearer is refused; a missing one is fine (protocol 2 authenticates the daemon by MAC).
    expect(
      (
        await raw(dm, {
          path: GATE_PATH,
          headers: { [H_PROTOCOL]: String(DAEMON_PROTOCOL), authorization: "Bearer nope" },
        })
      ).status,
    ).toBe(401);
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

  it("records one OTel span per judged request and closes the exporter (S-1217)", async () => {
    const spans: GateSpanInput[] = [];
    let closed = 0;
    const otel: OtelExporter = {
      record: (s) => {
        spans.push(s);
      },
      flush: async () => {},
      close: async () => {
        closed++;
      },
    };
    const dm = await daemon({ otel });
    const withId = (file: string) =>
      JSON.stringify({ ...JSON.parse(write(file, "A=1\n")), tool_use_id: "toolu_42" });
    await callDaemon({
      argv: ["--stdin", "--format", "codex"],
      text: withId(".env"),
      stdin: "ok",
      cwd: root,
      version: VERSION,
      home: home.root,
      timeoutMs: T,
    });
    await callDaemon({
      argv: ["--stdin"],
      text: write("src/ok.ts"),
      stdin: "ok",
      cwd: root,
      version: VERSION,
      home: home.root,
      timeoutMs: T,
    });
    await raw(dm, { path: CLAUDE_HOOK_PATH, body: write(".env", "A=1\n") });
    // Refused requests (no verdict) record nothing.
    await raw(dm, { path: GATE_PATH, headers: { origin: "https://evil.example" } });
    expect(spans.map((s) => s.decision)).toEqual(["deny", "allow", "deny"]);
    expect(spans.map((s) => s.format)).toEqual(["codex", "auto", "claude"]);
    expect(spans[0]?.tool).toBe("Write");
    expect(spans[0]?.toolCallId).toBe("toolu_42");
    expect(spans[1]?.toolCallId).toBeUndefined();
    expect(typeof spans[0]?.code).toBe("string");
    expect(spans[0]?.toolClass).toBe("write");
    expect(spans.every((s) => s.durationMs >= 0 && s.startMs > 0)).toBe(true);
    await dm.close();
    d = undefined;
    expect(closed).toBe(1);
  });
});

describe("axiom serve --hook — protocol 2 hardening", () => {
  const gateHeaders = (extra: Record<string, string> = {}) => ({
    [H_PROTOCOL]: String(DAEMON_PROTOCOL),
    [H_CWD]: encodeURIComponent(root),
    [H_NONCE]: randomBytes(16).toString("hex"),
    ...extra,
  });

  it("MACs every verdict with the key from daemon.json (nonce + exit + body digest)", async () => {
    const dm = await daemon();
    const st = await readDaemonState(home.root);
    const nonce = randomBytes(16).toString("hex");
    const r = await raw(dm, {
      path: `${GATE_PATH}?a=--stdin`,
      headers: gateHeaders({ [H_NONCE]: nonce }),
      body: write(".env", "A=1\n"),
    });
    expect(r.status).toBe(200);
    const mac = r.headers[H_MAC];
    expect(typeof mac).toBe("string");
    const exit = Number(r.headers["x-axiom-exit"]);
    expect(
      verifyDaemonMac(st?.key ?? "", nonce, exit, Buffer.from(r.body, "utf8"), String(mac)),
    ).toBe(true);
    expect(
      verifyDaemonMac(st?.key ?? "", "other-nonce", exit, Buffer.from(r.body), String(mac)),
    ).toBe(false);
  });

  it("refuses a gate request without a nonce (400)", async () => {
    const dm = await daemon();
    const h = gateHeaders();
    delete (h as Record<string, string>)[H_NONCE];
    const r = await raw(dm, { path: `${GATE_PATH}?a=--stdin`, headers: h, body: write("a.ts") });
    expect(r.status).toBe(400);
  });

  it("answers protocol-1 clients 426 so they fall back to spawning", async () => {
    const dm = await daemon();
    const r = await raw(dm, {
      path: `${GATE_PATH}?a=--stdin`,
      headers: { ...gateHeaders(), [H_PROTOCOL]: "1" },
      body: write(".env", "A=1\n"),
    });
    expect(r.status).toBe(426);
    expect(r.headers["x-axiom-exit"]).toBeUndefined();
  });

  it("judges no payload whose workspace_roots / workspaceRoots / tool_info.cwd point outside the roots (421)", async () => {
    const other = await tmpRepo("axiom-serve-outside-");
    try {
      const out = await realpath(other.root);
      await mkdir(join(out, ".git"));
      const dm = await daemon();
      const payloads = [
        {
          hook_event_name: "preToolUse",
          workspace_roots: [out],
          tool_name: "Write",
          tool_input: { file_path: ".env", content: "A=1\n" },
        },
        {
          preToolUse: { toolName: "write_to_file", parameters: { path: ".env", content: "x" } },
          workspaceRoots: [out],
        },
        {
          agent_action_name: "pre_write_code",
          tool_info: { cwd: out, file_path: ".env", edits: [] },
        },
      ];
      for (const p of payloads) {
        const r = await raw(dm, {
          path: `${GATE_PATH}?a=--stdin`,
          headers: gateHeaders(),
          body: JSON.stringify(p),
        });
        expect(r.status, JSON.stringify(p)).toBe(421);
      }
    } finally {
      await other.cleanup();
    }
  });

  it("refuses argv outside the allowlist (no --profile/--root from the query string) with 400 and no file bytes", async () => {
    const secret = join(root, "secret.txt");
    await writeFile(secret, "TOPSECRET-BYTES");
    const dm = await daemon();
    for (const argv of [
      ["--stdin", "--profile", secret],
      ["--stdin", `--profile=${secret}`],
      ["--stdin", "--root", root],
      ["--stdin", "--format", "nope"],
      ["--stdin", "--deny-exit", "7"],
      ["--stdin", "--no-root-discovery"],
    ]) {
      const qs = argv.map((a) => `a=${encodeURIComponent(a)}`).join("&");
      const r = await raw(dm, {
        path: `${GATE_PATH}?${qs}`,
        headers: gateHeaders(),
        body: write("a.ts"),
      });
      expect(r.status, argv.join(" ")).toBe(400);
      expect(r.body).not.toContain("TOPSECRET");
    }
    const ok = await raw(dm, {
      path: `${GATE_PATH}?a=--stdin&a=--format&a=codex&a=--deny-exit&a=2&a=--log-level&a=warn`,
      headers: gateHeaders(),
      body: write("a.ts"),
    });
    expect(ok.status).toBe(200);
  });

  it("stops reading an oversized body and answers 413", async () => {
    const dm = await daemon();
    const big = "x".repeat(4 * 1024 * 1024 + 1024);
    const r = await raw(dm, {
      path: `${GATE_PATH}?a=--stdin`,
      headers: gateHeaders(),
      body: big,
    }).catch((err: unknown) => ({ status: -1, err }));
    // The daemon may reset the socket after answering; either way it never judged the payload.
    expect([413, -1]).toContain(r.status);
    if (r.status === -1) return;
    expect(r.status).toBe(413);
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
