/**
 * Thin node client for the resident gate daemon (D-36, S-901). Zero-dependency (node builtins
 * only) — imported by `cli.ts` before the gate chunk is loaded. Returns `undefined` for "no
 * verdict" (no daemon, unreachable, version/protocol mismatch, cwd outside its roots, timeout);
 * the caller then runs the in-process gate, so a missing daemon is never a fail-open.
 * `AXIOM_GATE_DAEMON=0` disables the lookup.
 */
import {
  DAEMON_CLIENT_TIMEOUT_MS,
  DAEMON_PROTOCOL,
  type DaemonState,
  decodeHeader,
  encodeHeader,
  GATE_PATH,
  H_CWD,
  H_EXIT,
  H_PROTOCOL,
  H_STDERR,
  H_STDIN,
  H_VERSION,
  isLoopbackHost,
  readDaemonState,
} from "./daemon-proto.js";

export interface DaemonVerdict {
  exitCode: number;
  stdout: string;
  stderr: string[];
}

export interface DaemonCallInput {
  argv: readonly string[];
  /** Payload bytes as read from stdin; undefined when stdin timed out / was too large. */
  text: string | undefined;
  stdin: "ok" | "timeout" | "toolarge";
  cwd: string;
  version: string;
  home?: string;
  state?: DaemonState;
  timeoutMs?: number;
}

export async function callDaemon(input: DaemonCallInput): Promise<DaemonVerdict | undefined> {
  if (process.env.AXIOM_GATE_DAEMON === "0") return undefined;
  const state = input.state ?? (await readDaemonState(input.home));
  if (state === undefined || state.protocol !== DAEMON_PROTOCOL) return undefined;
  // A tampered state file must not send the payload (or the token) off the machine.
  if (!isLoopbackHost(state.host)) return undefined;
  // `node:http` costs ~10 ms to load; only pay it when a daemon is actually configured.
  const { default: http } = await import("node:http");
  const qs = input.argv.map((a) => `a=${encodeURIComponent(a)}`).join("&");
  const body = Buffer.from(input.text ?? "", "utf8");
  const headers: Record<string, string> = {
    [H_PROTOCOL]: String(DAEMON_PROTOCOL),
    [H_VERSION]: input.version,
    [H_CWD]: encodeHeader(input.cwd),
    [H_STDIN]: input.stdin,
    "content-type": "application/json",
    "content-length": String(body.length),
  };
  if (state.token !== undefined) headers.authorization = `Bearer ${state.token}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: DaemonVerdict | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.request(
      {
        host: state.host,
        port: state.port,
        method: "POST",
        path: `${GATE_PATH}?${qs}`,
        headers,
        timeout: input.timeoutMs ?? DAEMON_CLIENT_TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const exitRaw = res.headers[H_EXIT];
          const exit = typeof exitRaw === "string" ? Number(exitRaw) : Number.NaN;
          if (res.statusCode !== 200 || !Number.isInteger(exit) || exit < 0 || exit > 255) {
            finish(undefined);
            return;
          }
          const errRaw = res.headers[H_STDERR];
          const stderr = decodeHeader(typeof errRaw === "string" ? errRaw : undefined);
          finish({
            exitCode: exit,
            stdout: Buffer.concat(chunks).toString("utf8"),
            stderr: stderr === "" ? [] : stderr.split("\n"),
          });
        });
        res.on("error", () => finish(undefined));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(undefined);
    });
    req.on("error", () => finish(undefined));
    req.end(body);
  });
}
