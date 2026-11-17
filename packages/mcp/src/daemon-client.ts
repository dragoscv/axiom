/**
 * Thin node client for the resident gate daemon (D-36, S-901). Zero-dependency (node builtins
 * only) — imported by `cli.ts` before the gate chunk is loaded. Returns `undefined` for "no
 * verdict" (no daemon, unreachable, version/protocol mismatch, cwd outside its roots, timeout);
 * the caller then runs the in-process gate, so a missing daemon is never a fail-open.
 * `AXIOM_GATE_DAEMON=0` disables the lookup.
 *
 * Protocol 2: the verdict is accepted only with a valid `x-axiom-mac` over our fresh nonce
 * (key from the owner-only daemon.json). A missing/invalid MAC means someone else answered on
 * the daemon port: warn on stderr and return no verdict — or, with
 * `AXIOM_GATE_DAEMON_STRICT=1`, a fail-closed deny `ERR_DAEMON_AUTH`. A state file whose pid is
 * dead is deleted without connecting (no 1.1 s connect/timeout cost on a stale file).
 */
import { randomBytes } from "node:crypto";
import {
  DAEMON_CLIENT_TIMEOUT_MS,
  DAEMON_PROTOCOL,
  type DaemonState,
  decodeHeader,
  ENV_DAEMON_STRICT,
  encodeHeader,
  GATE_PATH,
  H_CWD,
  H_EXIT,
  H_MAC,
  H_NONCE,
  H_PROTOCOL,
  H_STDERR,
  H_STDIN,
  H_VERSION,
  isLoopbackHost,
  pidAlive,
  readDaemonState,
  removeStaleDaemonState,
  verifyDaemonMac,
} from "./daemon-proto.js";
import { formatFromArgv } from "./gate-fast.js";
import { GateDeny, renderDeny } from "./gate-format.js";

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

const AUTH_REASON =
  "gate daemon answer failed authentication (x-axiom-mac) — another process may be squatting the daemon port";

/** Code of the fail-closed deny when a daemon answer cannot be authenticated. */
export const DAEMON_AUTH_CODE = "ERR_DAEMON_AUTH";

/**
 * Fail-closed deny in the harness format for an unauthenticated daemon answer. The document comes
 * from the ONE per-format table (`gate-format.ts`, via `renderDeny`) — the 3.x version kept a
 * private copy of the switch, which had no `kiro` case and no `auto` `axiom` block (A2-19), and
 * `gate-format.test.ts` pins the two against each other.
 */
export function daemonAuthDeny(argv: readonly string[]): DaemonVerdict {
  const reason = AUTH_REASON;
  const format = formatFromArgv(argv);
  const di = argv.indexOf("--deny-exit");
  const denyExit =
    (di >= 0 && argv[di + 1] === "2") || argv.includes("--deny-exit=2") ? (2 as const) : undefined;
  const out = renderDeny(format, new GateDeny(DAEMON_AUTH_CODE, reason), reason, {
    ...(denyExit === undefined ? {} : { denyExit }),
  });
  return {
    exitCode: out.exitCode,
    stdout: out.stdout ?? "",
    stderr: [`AXIOM GATE DENY ${DAEMON_AUTH_CODE}: ${reason}`],
  };
}

function untrusted(argv: readonly string[]): DaemonVerdict | undefined {
  if (process.env[ENV_DAEMON_STRICT] === "1") return daemonAuthDeny(argv);
  process.stderr.write(`AXIOM GATE WARN ERR_DAEMON_AUTH: ${AUTH_REASON}; deciding in-process\n`);
  return undefined;
}

export async function callDaemon(input: DaemonCallInput): Promise<DaemonVerdict | undefined> {
  if (process.env.AXIOM_GATE_DAEMON === "0") return undefined;
  const state = input.state ?? (await readDaemonState(input.home));
  if (state === undefined || state.protocol !== DAEMON_PROTOCOL) return undefined;
  const key = state.key;
  if (key === undefined) return undefined;
  // A tampered state file must not send the payload off the machine.
  if (!isLoopbackHost(state.host)) return undefined;
  if (!pidAlive(state.pid)) {
    if (input.state === undefined) await removeStaleDaemonState(input.home);
    return undefined;
  }
  // `node:http` costs ~10 ms to load; only pay it when a daemon is actually configured.
  const { default: http } = await import("node:http");
  const qs = input.argv.map((a) => `a=${encodeURIComponent(a)}`).join("&");
  const body = Buffer.from(input.text ?? "", "utf8");
  const nonce = randomBytes(18).toString("base64url");
  const headers: Record<string, string> = {
    [H_PROTOCOL]: String(DAEMON_PROTOCOL),
    [H_VERSION]: input.version,
    [H_CWD]: encodeHeader(input.cwd),
    [H_STDIN]: input.stdin,
    [H_NONCE]: nonce,
    "content-type": "application/json",
    "content-length": String(body.length),
  };
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
          const exit =
            typeof exitRaw === "string" && /^[012]$/.test(exitRaw) ? Number(exitRaw) : -1;
          if (res.statusCode !== 200) {
            finish(undefined);
            return;
          }
          const out = Buffer.concat(chunks);
          const macRaw = res.headers[H_MAC];
          const mac = typeof macRaw === "string" ? macRaw : undefined;
          if (exit < 0 || !verifyDaemonMac(key, nonce, exit, out, mac)) {
            finish(untrusted(input.argv));
            return;
          }
          const errRaw = res.headers[H_STDERR];
          const stderr = decodeHeader(typeof errRaw === "string" ? errRaw : undefined);
          finish({
            exitCode: exit,
            stdout: out.toString("utf8"),
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
