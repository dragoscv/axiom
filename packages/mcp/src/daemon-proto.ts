/**
 * Resident gate daemon wire protocol (D-36, S-901). Zero-dependency (node builtins only): this
 * module is imported by the thin `cli.ts` entry, the daemon (`serve.ts`) and `doctor`, and its
 * constants are mirrored by the native client in `crates/axiom-hook` — change both together.
 *
 * Transport: HTTP/1.1 on loopback (default 127.0.0.1:47861). Requests carrying an `Origin`
 * header or a non-loopback `Host` are refused (a browser page must not reach the gate). A token
 * is optional: when the daemon was started with `--token-env NAME` every request must send
 * `authorization: Bearer <token>`; the token is also written to the state file.
 *
 * `POST /v1/gate?a=<arg>&a=<arg>…` — the `axiom gate` argv after the verb, in order.
 *   request headers: `x-axiom-protocol: 1` (required), `x-axiom-version: <semver>` (node client;
 *   a mismatch → 409 so the client falls back to its own in-process gate), `x-axiom-cwd:
 *   <percent-encoded cwd of the hook process>`, `x-axiom-stdin: ok|timeout|toolarge`.
 *   body: the harness payload bytes exactly as read from stdin.
 *   200 → headers `x-axiom-exit: <exit code>`, `x-axiom-stderr: <percent-encoded stderr lines,
 *   "\n"-joined>`; body = the stdout document (possibly empty).
 *   Any other status (400 bad request, 401 token, 403 origin/host, 409 version/protocol, 421 cwd
 *   outside the daemon's roots) means "no verdict": the client must decide another way — the
 *   node client runs the in-process gate, the native client spawns `axiom gate`, and if that is
 *   impossible it denies (fail-closed).
 *
 * `POST /v1/hook/claude` — Claude Code `type: "http"` hook: body = the PreToolUse payload, 200
 *   with the Claude JSON document (deny / hint) or an empty body (allow). Claude's
 *   `onFailure: "block"` makes a missing daemon fail closed.
 *
 * `GET /v1/health` — `{ protocol, version, pid, roots, startedAt, requests }`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export const DAEMON_PROTOCOL = 1;
export const DAEMON_DEFAULT_HOST = "127.0.0.1";
/** Hosts a daemon state file may name; anything else is treated as tampering (no request sent). */
export const DAEMON_LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
]);
export const isLoopbackHost = (host: string): boolean =>
  DAEMON_LOOPBACK_HOSTS.has(host.toLowerCase());
export const DAEMON_DEFAULT_PORT = 47861;
export const DAEMON_STATE_DIR = ".axiom";
export const DAEMON_STATE_FILE = "daemon.json";
export const GATE_PATH = "/v1/gate";
export const CLAUDE_HOOK_PATH = "/v1/hook/claude";
export const HEALTH_PATH = "/v1/health";
/** The thin client gives up on the daemon after this long and decides in-process. */
export const DAEMON_CLIENT_TIMEOUT_MS = 1_500;

export const H_PROTOCOL = "x-axiom-protocol";
export const H_VERSION = "x-axiom-version";
export const H_CWD = "x-axiom-cwd";
export const H_STDIN = "x-axiom-stdin";
export const H_EXIT = "x-axiom-exit";
export const H_STDERR = "x-axiom-stderr";

/** Written by `axiom serve --hook` to `~/.axiom/daemon.json`; removed on clean shutdown. */
export interface DaemonState {
  protocol: number;
  pid: number;
  host: string;
  port: number;
  version: string;
  roots: string[];
  startedAt: string;
  /** Present only when the daemon was started with `--token-env`. */
  token?: string;
}

export function daemonStatePath(home: string = homedir()): string {
  return path.join(home, DAEMON_STATE_DIR, DAEMON_STATE_FILE);
}

function isState(v: unknown): v is DaemonState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.protocol === "number" &&
    typeof s.pid === "number" &&
    typeof s.host === "string" &&
    typeof s.port === "number" &&
    Number.isInteger(s.port) &&
    s.port > 0 &&
    s.port < 65_536 &&
    typeof s.version === "string" &&
    Array.isArray(s.roots) &&
    (s.token === undefined || typeof s.token === "string")
  );
}

/** `undefined` when absent or malformed (a malformed file is ignored, never trusted). */
export async function readDaemonState(home?: string): Promise<DaemonState | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(daemonStatePath(home), "utf8"));
    return isState(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Percent-encoding for header values (UTF-8, everything outside unreserved + `/` escaped). */
export function encodeHeader(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, "/");
}

export function decodeHeader(s: string | undefined): string {
  if (s === undefined || s === "") return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}
