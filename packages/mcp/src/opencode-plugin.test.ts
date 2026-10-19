import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPENCODE_PLUGIN_JS } from "./opencode-plugin.js";
import { tmpRepo } from "./test-helpers.js";

/** A stand-in `axiom gate`: records stdin, then behaves per FAKE_MODE. */
const FAKE_GATE = `
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), input }));
  const mode = process.env.FAKE_MODE;
  if (mode === "deny") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "AXIOM GATE DENY path.deny: no (.env)" } }));
    process.exit(0);
  }
  if (mode === "ask") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "AXIOM GATE ASK path.ask: confirm" } }));
    process.exit(0);
  }
  if (mode === "crash") {
    process.stderr.write("AXIOM GATE DENY ERR_INTERNAL: boom\\n");
    process.exit(1);
  }
  if (mode === "hang") {
    setTimeout(() => process.exit(0), 60000);
    return;
  }
  process.exit(0);
});
`;

type Hook = (input: unknown, output: unknown) => Promise<void>;

let dir: Awaited<ReturnType<typeof tmpRepo>>;
let hook: Hook;
const saved = { ...process.env };

beforeEach(async () => {
  dir = await tmpRepo("axiom-opencode-");
  process.env.HOME = dir.root;
  process.env.USERPROFILE = dir.root;
  const gate = join(dir.root, "fake-gate.mjs");
  await writeFile(gate, FAKE_GATE);
  await writeFile(join(dir.root, "axiom-gate.mjs"), OPENCODE_PLUGIN_JS);
  process.env.AXIOM_GATE_CMD = JSON.stringify([process.execPath, gate]);
  process.env.FAKE_OUT = join(dir.root, "seen.json");
  const mod = (await import(pathToFileURL(join(dir.root, "axiom-gate.mjs")).href)) as {
    AxiomGate: (ctx: { directory: string }) => Promise<Record<string, Hook>>;
  };
  const hooks = await mod.AxiomGate({ directory: dir.root });
  hook = hooks["tool.execute.before"] as Hook;
});

afterEach(async () => {
  for (const k of [
    "AXIOM_GATE_CMD",
    "AXIOM_GATE_TIMEOUT_MS",
    "FAKE_OUT",
    "FAKE_MODE",
    "HOME",
    "USERPROFILE",
  ]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await dir.cleanup();
});

const seen = async () =>
  JSON.parse(await readFile(join(dir.root, "seen.json"), "utf8")) as {
    argv: string[];
    input: string;
  };

describe("OpenCode plugin (.opencode/plugins/axiom-gate.js)", () => {
  it("allow: sends the Claude-shaped payload to `gate --stdin --format claude` and lets the tool run", async () => {
    process.env.FAKE_MODE = "allow";
    await expect(
      hook(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: "a.txt", content: "x" } },
      ),
    ).resolves.toBeUndefined();
    const s = await seen();
    expect(s.argv).toEqual(["gate", "--stdin", "--format", "claude"]);
    expect(JSON.parse(s.input)).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "write",
      tool_input: { filePath: "a.txt", content: "x" },
      cwd: dir.root,
      session_id: "s1",
    });
  });

  it("deny and ask documents throw with the gate's reason", async () => {
    process.env.FAKE_MODE = "deny";
    await expect(hook({ tool: "edit" }, { args: { filePath: ".env" } })).rejects.toThrow(
      "AXIOM GATE DENY path.deny: no (.env)",
    );
    process.env.FAKE_MODE = "ask";
    await expect(hook({ tool: "edit" }, { args: { filePath: ".github/x" } })).rejects.toThrow(
      "AXIOM GATE ASK path.ask",
    );
  });

  it("fails closed: non-zero exit, a missing bin and a timeout all throw", async () => {
    process.env.FAKE_MODE = "crash";
    await expect(hook({ tool: "bash" }, { args: { command: "ls" } })).rejects.toThrow(
      "ERR_INTERNAL: boom",
    );
    process.env.AXIOM_GATE_CMD = JSON.stringify([join(dir.root, "no-such-axiom")]);
    await expect(hook({ tool: "bash" }, { args: { command: "ls" } })).rejects.toThrow(
      /could not run/,
    );
    process.env.AXIOM_GATE_CMD = JSON.stringify([
      process.execPath,
      join(dir.root, "fake-gate.mjs"),
    ]);
    process.env.FAKE_MODE = "hang";
    process.env.AXIOM_GATE_TIMEOUT_MS = "300";
    await expect(hook({ tool: "bash" }, { args: { command: "ls" } })).rejects.toThrow(
      /timed out after 300 ms/,
    );
  }, 20_000);

  it("patch tool → apply_patch with the V4A text in tool_input.input", async () => {
    process.env.FAKE_MODE = "allow";
    const patchText = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch";
    await hook({ tool: "patch" }, { args: { patchText } });
    const p = JSON.parse((await seen()).input) as { tool_name: string; tool_input: unknown };
    expect(p.tool_name).toBe("apply_patch");
    expect(p.tool_input).toEqual({ input: patchText });
  });
});
