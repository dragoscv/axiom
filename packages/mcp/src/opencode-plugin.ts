/**
 * The OpenCode plugin `axiom init --harness opencode` writes to `.opencode/plugins/axiom-gate.js`
 * (opencode.ai/docs/plugins: local plugins in that directory load at startup; a
 * `tool.execute.before` hook that throws blocks the tool). Kept as a string so the bundled CLI
 * carries it with no asset lookup; `opencode-plugin.test.ts` imports a written copy and runs it.
 *
 * Contract: one plain ESM file, no dependencies, no shell. It spawns
 * `axiom gate --stdin --format claude` with `{tool_name, tool_input, cwd, session_id}` on stdin and
 * throws on a deny/ask document, on exit 2, on any other non-zero exit, on a spawn error and on a
 * 15 s timeout (fail closed). `AXIOM_GATE_CMD` (JSON argv prefix) overrides the bin;
 * `AXIOM_GATE_TIMEOUT_MS` the timeout.
 */
export const OPENCODE_PLUGIN_JS = `// AXIOM write gate for OpenCode (written by \`axiom init --harness opencode\`; re-run with --force to update).
// Every tool call is judged by \`axiom gate --stdin --format claude\` before it runs; a deny,
// a crash, a missing \`axiom\` bin or a 15 s timeout throws, which blocks the tool (fail closed).
import { spawn } from "node:child_process";

const GATE_ARGS = ["gate", "--stdin", "--format", "claude"];

function gateArgv() {
  const custom = process.env.AXIOM_GATE_CMD;
  if (custom) {
    const argv = JSON.parse(custom);
    if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string")) {
      return [...argv, ...GATE_ARGS];
    }
    throw new Error("AXIOM gate: AXIOM_GATE_CMD must be a JSON array of strings");
  }
  // Node and Bun refuse to spawn a .cmd shim directly; cmd.exe gets constant arguments only
  // (the payload travels on stdin, never on the command line).
  if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", "axiom.cmd", ...GATE_ARGS];
  return ["axiom", ...GATE_ARGS];
}

/** OpenCode tool + args -> the Claude-shaped payload the gate reads. */
export function toGatePayload(input, output, cwd) {
  const args = output && typeof output.args === "object" && output.args !== null ? output.args : {};
  let toolName = String(input.tool);
  let toolInput = args;
  if (toolName === "patch" || toolName === "apply_patch") {
    toolName = "apply_patch";
    toolInput = { input: args.patchText ?? args.patch ?? args.input ?? "" };
  }
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
    ...(input.sessionID ? { session_id: String(input.sessionID) } : {}),
  };
}

function runGate(payload, cwd) {
  const timeoutMs = Number(process.env.AXIOM_GATE_TIMEOUT_MS) || 15000;
  return new Promise((resolve) => {
    let argv;
    try {
      argv = gateArgv();
    } catch (err) {
      resolve({ deny: true, reason: String(err.message ?? err) });
      return;
    }
    const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ deny: true, reason: "AXIOM gate timed out after " + timeoutMs + " ms (fail-closed)" });
    }, timeoutMs);
    child.stdout.on("data", (c) => { if (out.length < 1048576) out += c; });
    child.stderr.on("data", (c) => { if (err.length < 65536) err += c; });
    child.on("error", (e) => finish({ deny: true, reason: "AXIOM gate could not run: " + e.message + " (fail-closed)" }));
    child.on("close", (code) => {
      const reason = err.trim().split(/\\r?\\n/).filter((l) => l.includes("AXIOM")).pop();
      let doc;
      try {
        doc = out.trim() === "" ? undefined : JSON.parse(out);
      } catch {
        doc = undefined;
      }
      const hso = doc && typeof doc === "object" ? doc.hookSpecificOutput : undefined;
      const decision = (hso && hso.permissionDecision) || (doc && doc.permissionDecision) || (doc && doc.decision);
      if (decision === "deny" || decision === "ask" || decision === "block") {
        const why = (hso && hso.permissionDecisionReason) || (doc && (doc.permissionDecisionReason || doc.reason));
        finish({ deny: true, reason: why || reason || "AXIOM gate denied the call" });
      } else if (code === 0) {
        finish({ deny: false });
      } else {
        finish({ deny: true, reason: reason || "AXIOM gate exited " + code + " (fail-closed)" });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export const AxiomGate = async ({ directory, worktree }) => {
  const cwd = directory || worktree || process.cwd();
  return {
    "tool.execute.before": async (input, output) => {
      const r = await runGate(toGatePayload(input, output, cwd), cwd);
      if (r.deny) throw new Error(r.reason);
    },
  };
};
`;
