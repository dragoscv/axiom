/**
 * Resident gate daemon wire protocol (D-36, S-901). Zero-dependency (node builtins only): this
 * module is imported by the thin `cli.ts` entry, the daemon (`serve.ts`) and `doctor`, and its
 * constants are mirrored by the native client in `crates/axiom-hook` — change both together.
 *
 * Transport: HTTP/1.1 on loopback (default 127.0.0.1:47861). Requests carrying an `Origin`
 * header or a non-loopback `Host` are refused (a browser page must not reach the gate).
 *
 * Protocol 2 (2.7, squatting fix): the daemon mints a random 32-byte `key` at every start and
 * writes it to `~/.axiom/daemon.json` (owner-only: mode 0600, and on Windows an icacls grant to
 * the current user only). Every gate request carries a fresh `x-axiom-nonce`; every verdict
 * carries `x-axiom-mac: hex(HMAC-SHA256(key, nonce "\n" exit "\n" sha256hex(body)))`. A client
 * that cannot verify the MAC treats the answer as "no verdict" (or, with
 * `AXIOM_GATE_DAEMON_STRICT=1`, as a fail-closed deny `ERR_DAEMON_AUTH`): a local process
 * squatting the port or rewriting daemon.json cannot forge an allow. No bearer token is sent any
 * more; `--token-env` is still accepted (a request that does send a wrong bearer gets 401).
 *
 * `POST /v1/gate?a=<arg>&a=<arg>…` — the `axiom gate` argv after the verb, in order. Only
 *   `--stdin --format <f> --deny-exit 0|2 --log-level <l> --fail-open --post --track-reads
 *   --no-shell-scan` are accepted (400 otherwise): root and profile come from the daemon side.
 *   request headers: `x-axiom-protocol: 2` (required; `1` → 426), `x-axiom-nonce` (required,
 *   16..128 chars of [0-9A-Za-z_-]), `x-axiom-version: <semver>` (node client; a mismatch → 409
 *   so the client falls back to its own in-process gate), `x-axiom-cwd: <percent-encoded cwd of
 *   the hook process>`, `x-axiom-stdin: ok|timeout|toolarge`.
 *   body: the harness payload bytes exactly as read from stdin.
 *   200 → headers `x-axiom-exit: 0|1|2`, `x-axiom-stderr: <percent-encoded stderr lines,
 *   "\n"-joined>`, `x-axiom-mac`; body = the stdout document (possibly empty), Content-Length
 *   framed.
 *   Any other status (400 bad request/argv, 401 wrong token, 403 origin/host, 409
 *   version/protocol, 413 body over 4 MiB, 421 cwd/payload root outside the daemon's roots, 426
 *   protocol 1) means "no verdict": the client must decide another way — the node client runs
 *   the in-process gate, the native client spawns `axiom gate`, and if that is impossible it
 *   denies (fail-closed).
 *
 * `POST /v1/hook/claude` — Claude Code `type: "http"` hook: body = the PreToolUse payload, 200
 *   with the Claude JSON document (deny / hint) or an empty body (allow). Claude's
 *   `onFailure: "block"` makes a missing daemon fail closed.
 *
 * `GET /v1/health` — `{ protocol, version, pid, roots, startedAt, requests }`.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export const DAEMON_PROTOCOL = 2;
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
export const H_NONCE = "x-axiom-nonce";
export const H_MAC = "x-axiom-mac";
/** `x-axiom-nonce` shape accepted by the daemon. */
export const NONCE_RE = /^[0-9A-Za-z_-]{16,128}$/;
/** `AXIOM_GATE_DAEMON_STRICT=1`: an unauthenticated daemon answer is a deny, not a fallback. */
export const ENV_DAEMON_STRICT = "AXIOM_GATE_DAEMON_STRICT";

/** Written by `axiom serve --hook` to `~/.axiom/daemon.json`; removed on clean shutdown. */
export interface DaemonState {
  protocol: number;
  pid: number;
  host: string;
  port: number;
  version: string;
  roots: string[];
  startedAt: string;
  /**
   * Protocol 2: 64 hex chars, minted per daemon start; the MAC key of every verdict. Always
   * present when `protocol >= 2` (a protocol-1 file parses so `doctor` can report it, but no
   * client talks to it).
   */
  key?: string;
  /**
   * Protocol 1 only (never written by a protocol-2 daemon, never sent by a protocol-2 client).
   * @deprecated
   */
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
    (s.protocol < 2 || (typeof s.key === "string" && /^[0-9a-f]{64}$/.test(s.key))) &&
    (s.token === undefined || typeof s.token === "string")
  );
}

/**
 * `undefined` when absent, malformed, or (POSIX) readable by group/other — a key anyone can read
 * authenticates nothing. A malformed file is ignored, never trusted.
 */
export async function readDaemonState(home?: string): Promise<DaemonState | undefined> {
  const file = daemonStatePath(home);
  try {
    if (process.platform !== "win32" && ((await stat(file)).mode & 0o077) !== 0) return undefined;
    const v: unknown = JSON.parse(await readFile(file, "utf8"));
    return isState(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `true` when a process with this pid exists (EPERM = exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove a stale daemon.json — only when the pid it names is (still) dead. */
export async function removeStaleDaemonState(home?: string): Promise<boolean> {
  const file = daemonStatePath(home);
  try {
    const v: unknown = JSON.parse(await readFile(file, "utf8"));
    const pid = typeof v === "object" && v !== null ? (v as { pid?: unknown }).pid : undefined;
    if (typeof pid === "number" && pidAlive(pid)) return false;
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** `hex(HMAC-SHA256(key, nonce "\n" exit "\n" sha256hex(body)))` — the verdict MAC. */
export function daemonMac(keyHex: string, nonce: string, exit: number, body: Buffer): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(`${nonce}\n${exit}\n${digest}`)
    .digest("hex");
}

export function verifyDaemonMac(
  keyHex: string,
  nonce: string,
  exit: number,
  body: Buffer,
  mac: string | undefined,
): boolean {
  if (mac === undefined || !/^[0-9a-f]{64}$/i.test(mac) || !/^[0-9a-f]{64}$/.test(keyHex)) {
    return false;
  }
  const want = Buffer.from(daemonMac(keyHex, nonce, exit, body), "hex");
  return timingSafeEqual(want, Buffer.from(mac.toLowerCase(), "hex"));
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
