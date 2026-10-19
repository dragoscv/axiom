import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AcpDecision,
  type AcpPermissionRequest,
  acpPermissionDecision,
  acpToGatePayloads,
  runAcpProxy,
} from "./acp.js";
import type { GateOptions, GateResult } from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(async () => {
  repo = await tmpRepo("axiom-acp-");
  home = await tmpRepo("axiom-acp-home-");
  process.env.HOME = home.root;
  process.env.USERPROFILE = home.root;
  await mkdir(join(repo.root, ".git")); // root discovery stops here
});
afterEach(async () => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all([repo.cleanup(), home.cleanup()]);
});

const OPTIONS = [
  { optionId: "yes", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

const req = (toolCall: AcpPermissionRequest["toolCall"], options = OPTIONS) => ({
  sessionId: "sess_1",
  toolCall,
  options,
});

describe("acpToGatePayloads", () => {
  it("edit → one Write per diff/location/rawInput path (deduplicated), with diff newText as content", () => {
    const p = acpToGatePayloads(
      {
        toolCallId: "c1",
        kind: "edit",
        content: [{ type: "diff", path: "/r/a.ts", oldText: "x", newText: "y" }],
        locations: [{ path: "/r/a.ts" }, { path: "/r/b.ts", line: 3 }],
      },
      "/r",
      "s",
    );
    expect(p).toEqual([
      {
        hook_event_name: "PreToolUse",
        cwd: "/r",
        session_id: "s",
        tool_name: "Write",
        tool_input: { file_path: "/r/a.ts", content: "y" },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: "/r",
        session_id: "s",
        tool_name: "Write",
        tool_input: { file_path: "/r/b.ts" },
      },
    ]);
  });

  it("delete → delete_file; execute → Bash with the command (argv joined); write kind without target → pathless Write", () => {
    expect(
      acpToGatePayloads({ kind: "delete", locations: [{ path: "/r/x" }] }, "/r")[0],
    ).toMatchObject({
      tool_name: "delete_file",
      tool_input: { file_path: "/r/x" },
    });
    expect(
      acpToGatePayloads(
        { kind: "execute", rawInput: { command: "rm", args: ["-rf", ".git"] } },
        "/r",
      )[0],
    ).toMatchObject({ tool_name: "Bash", tool_input: { command: "rm -rf .git" } });
    expect(acpToGatePayloads({ kind: "edit" }, "/r")).toEqual([
      { hook_event_name: "PreToolUse", cwd: "/r", tool_name: "Write", tool_input: {} },
    ]);
    expect(acpToGatePayloads({ kind: "read", locations: [{ path: "/r/x" }] }, "/r")).toEqual([]);
  });
});

describe("acpPermissionDecision (real in-process gate)", () => {
  it("allowed edit → allow_once (never allow_always)", async () => {
    const d = await acpPermissionDecision(
      req({
        toolCallId: "c1",
        kind: "edit",
        locations: [{ path: join(repo.root, "src", "a.ts") }],
      }),
      { cwd: repo.root, gate: { home: home.root } },
    );
    expect(d).toEqual({ outcome: { outcome: "selected", optionId: "yes" }, decision: "allow" });
  });

  it("edit of .env → reject_once with the gate code and reason", async () => {
    const d = await acpPermissionDecision(
      req({
        kind: "edit",
        content: [{ type: "diff", path: join(repo.root, ".env"), newText: "X=1" }],
      }),
      { cwd: repo.root, gate: { home: home.root } },
    );
    expect(d.decision).toBe("deny");
    expect(d.outcome).toEqual({ outcome: "selected", optionId: "no" });
    expect(d.code).toBe("path.deny");
    expect(d.reason).toMatch(/^AXIOM GATE DENY path\.deny: .*\.env/);
  });

  it("an edit with no target is denied (ERR_UNSUPPORTED_OP); execute rm .git is denied", async () => {
    const none = await acpPermissionDecision(req({ kind: "edit" }), {
      cwd: repo.root,
      gate: { home: home.root },
    });
    expect(none.decision).toBe("deny");
    expect(none.code).toBe("ERR_UNSUPPORTED_OP");
    const rm = await acpPermissionDecision(
      req({ kind: "execute", rawInput: { command: "rm -rf .git/hooks" } }),
      { cwd: repo.root, gate: { home: home.root } },
    );
    expect(rm.decision).toBe("deny");
  });

  it("only reject_always offered → it; no reject option → cancelled; a throwing gate → deny", async () => {
    const deny = async (_t: string, _o: GateOptions): Promise<GateResult> => ({
      decision: "deny",
      verdict: "deny",
      exitCode: 0,
      code: "path.deny",
      stderr: ["AXIOM GATE DENY path.deny: x"],
      durationMs: 0,
    });
    const call = { kind: "edit", locations: [{ path: "/r/a" }] };
    const always = [
      { optionId: "never", kind: "reject_always" },
      { optionId: "ok", kind: "allow_once" },
    ];
    expect(
      (await acpPermissionDecision(req(call, always), { cwd: "/r", runGate: deny })).outcome,
    ).toEqual({ outcome: "selected", optionId: "never" });
    expect(
      (
        await acpPermissionDecision(req(call, [{ optionId: "ok", kind: "allow_once" }]), {
          cwd: "/r",
          runGate: deny,
        })
      ).outcome,
    ).toEqual({ outcome: "cancelled" });
    const boom = await acpPermissionDecision(req(call), {
      cwd: "/r",
      runGate: async () => {
        throw new Error("boom");
      },
    });
    expect(boom.decision).toBe("deny");
    expect(boom.reason).toContain("ERR_INTERNAL: boom");
  });
});

/** Line collector for a PassThrough. */
function lines(s: PassThrough): string[] {
  const out: string[] = [];
  let buf = "";
  s.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      out.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  return out;
}

describe("runAcpProxy", () => {
  it("forwards everything, answers a denied request_permission itself, forwards an allowed one", async () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const toClient = lines(clientOut);
    const toAgent = lines(agentOut);
    const asked: [AcpPermissionRequest, string][] = [];
    const denied: AcpDecision[] = [];
    const proxy = runAcpProxy({
      clientIn,
      clientOut,
      agentIn,
      agentOut,
      root: "/fallback",
      decide: async (r, cwd) => {
        asked.push([r, cwd]);
        return r.toolCall.toolCallId === "bad"
          ? {
              outcome: { outcome: "selected", optionId: "no" },
              decision: "deny",
              reason: "AXIOM GATE DENY x",
            }
          : { outcome: { outcome: "selected", optionId: "yes" }, decision: "allow" };
      },
      onDeny: (d) => denied.push(d),
    });
    const newReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/work", mcpServers: [] },
    };
    clientIn.write(`${JSON.stringify(newReq)}\n`);
    agentIn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "S" } })}\n`);
    const upd = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "S", update: { sessionUpdate: "tool_call" } },
    };
    agentIn.write(`${JSON.stringify(upd)}\n`);
    const bad = {
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { sessionId: "S", toolCall: { toolCallId: "bad", kind: "edit" }, options: OPTIONS },
    };
    const good = {
      ...bad,
      id: 8,
      params: { ...bad.params, toolCall: { toolCallId: "good", kind: "edit" } },
    };
    agentIn.write(`${JSON.stringify(bad)}\n`);
    agentIn.write(`${JSON.stringify(good)}\n`);
    agentIn.write("not json\n");
    const answer = {
      jsonrpc: "2.0",
      id: 8,
      result: { outcome: { outcome: "selected", optionId: "yes" } },
    };
    clientIn.write(`${JSON.stringify(answer)}\n`);
    clientIn.end();
    agentIn.end();
    await proxy;

    // Client → agent and the proxy's own answers are independent streams: order only within each.
    const agentGot = toAgent.map((l) => JSON.parse(l) as { id: number });
    expect(agentGot[0]).toEqual(newReq);
    expect(agentGot.slice(1).sort((a, b) => a.id - b.id)).toEqual([
      { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "no" } } },
      answer,
    ]);
    expect(toClient).toEqual([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "S" } }),
      JSON.stringify(upd),
      JSON.stringify(good),
      "not json",
    ]);
    // The session cwd learned from session/new is what the gate judged against.
    expect(asked.map(([r, cwd]) => [r.toolCall.toolCallId, cwd])).toEqual([
      ["bad", "/work"],
      ["good", "/work"],
    ]);
    expect(denied).toHaveLength(1);
  });

  it("unknown session → --root fallback; a decide() that throws answers cancelled (fail closed)", async () => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const toAgent = lines(agentOut);
    const toClient = lines(clientOut);
    const cwds: string[] = [];
    const proxy = runAcpProxy({
      clientIn,
      clientOut,
      agentIn,
      agentOut,
      root: "/fallback",
      decide: async (_r, cwd) => {
        cwds.push(cwd);
        throw new Error("boom");
      },
    });
    agentIn.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "p", method: "session/request_permission", params: { sessionId: "?", toolCall: { kind: "edit" }, options: OPTIONS } })}\n`,
    );
    agentIn.end();
    clientIn.end();
    await proxy;
    expect(cwds).toEqual(["/fallback"]);
    expect(toClient).toEqual([]);
    expect(toAgent.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: "p", result: { outcome: { outcome: "cancelled" } } },
    ]);
  });
});
