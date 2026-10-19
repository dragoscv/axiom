/**
 * `axiom serve --hook` — resident gate daemon (D-36, S-901). Keeps the gate chunk (zod, checks,
 * apply containment) warm in one process so a hook call costs a loopback HTTP round trip instead
 * of a node start + chunk load. Wire protocol: `daemon-proto.ts`.
 *
 * Security: loopback only (a non-loopback `--host` is refused at startup), requests with an
 * `Origin` header or a non-loopback `Host` are refused (DNS rebinding / browser pages), an
 * explicit root allowlist (`--root`, invariant 8): a hook whose cwd, payload root (any harness
 * key, via `normalizePayload`) or resolved gate root is outside every root gets 421 and decides
 * in-process instead. Protocol 2: a per-start random key in the owner-only state file MACs every
 * verdict (see daemon-proto.ts), so a port squatter cannot forge an allow. The query-string argv
 * is allowlisted (no `--profile`/`--root` from a request). The daemon never writes to the
 * working tree — it only answers `gateMain`.
 *
 * Never writes to stdout itself (`check-no-stdout`): the CLI prints the startup line.
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir, userInfo } from "node:os";
import * as path from "node:path";
import { AxiomError } from "@codai/axiom-schema";
import {
  CLAUDE_HOOK_PATH,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_PROTOCOL,
  type DaemonState,
  daemonMac,
  daemonStatePath,
  decodeHeader,
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
  HEALTH_PATH,
  NONCE_RE,
} from "./daemon-proto.js";
import {
  GATE_LOG_LEVELS,
  GATE_STDIN_MAX_BYTES,
  type GateResult,
  gateMain,
  normalizePayload,
} from "./gate.js";
import { isGateFormat, TOOL_NAME_KEYS } from "./gate-fast.js";
import type { OtelExporter } from "./otel.js";
import { isSameOrInside, realDir } from "./roots.js";

export interface ServeOptions {
  /** realpath'd allowlisted roots (at least one). */
  roots: readonly string[];
  host?: string;
  /** 0 = random free port. */
  port?: number;
  version: string;
  /** Legacy `--token-env`: a request that sends a bearer must send this one (none is required). */
  token?: string;
  /** Directory holding `.axiom/daemon.json` (default: the home directory). */
  home?: string;
  /** Do not write the state file (tests). */
  noStateFile?: boolean;
  /** Called for every judged request (tests, metrics). */
  onRequest?: (r: { path: string; status: number; ms: number }) => void;
  /** S-1217: one `execute_tool` span per judged request (opt-in; flushed on close). */
  otel?: OtelExporter;
}

export interface RunningDaemon {
  host: string;
  port: number;
  url: string;
  state: DaemonState;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** `Host` header → hostname without port (`[::1]:47861` → `::1`). */
function hostOf(header: string | undefined): string | undefined {
  if (header === undefined || header === "") return undefined;
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    return end < 0 ? undefined : header.slice(1, end);
  }
  const i = header.lastIndexOf(":");
  return i < 0 ? header : header.slice(0, i);
}

/** Protocol 2 does not need a bearer; a request that sends one must send the right one. */
function tokenOk(expected: string | undefined, auth: string | undefined): boolean {
  if (expected === undefined || auth === undefined) return true;
  if (!auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice("Bearer ".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stops reading (and stops buffering) the moment the body exceeds `max`. */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | "toolarge"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.off("data", onData);
        req.pause();
        chunks.length = 0;
        resolve("toolarge");
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const BOOL_ARGS: ReadonlySet<string> = new Set([
  "--stdin",
  "--fail-open",
  "--post",
  "--track-reads",
  "--no-shell-scan",
]);
const VALUE_ARGS: Readonly<Record<string, (v: string) => boolean>> = {
  "--format": isGateFormat,
  "--deny-exit": (v) => v === "0" || v === "2",
  "--log-level": (v) => (GATE_LOG_LEVELS as readonly string[]).includes(v),
};

/**
 * The argv a request may carry. Root and profile are the daemon's own business: a request that
 * names a `--profile` file would make the daemon read (and echo the parse error of) any file.
 */
export function argvAllowed(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (BOOL_ARGS.has(a)) continue;
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    const check = Object.hasOwn(VALUE_ARGS, name) ? VALUE_ARGS[name] : undefined;
    if (check === undefined) return false;
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || !check(value)) return false;
  }
  return true;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type":
      status === 200 ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(buf.length),
    ...headers,
  });
  res.end(buf);
}

/** The cwd the hook ran in decides the root fallback; it must lie inside an allowlisted root. */
async function cwdAllowed(roots: readonly string[], cwd: string): Promise<boolean> {
  if (cwd === "" || !path.isAbsolute(cwd)) return false;
  // Roots are realpaths; a harness may hand us /var/... or RUNNER~1 forms.
  let real = cwd;
  try {
    real = await realDir(cwd, "ERR_ROOT_NOT_DIR");
  } catch {
    // nonexistent: compare as given
  }
  return roots.some((r) => isSameOrInside(r, real) || isSameOrInside(r, cwd));
}

/**
 * The directory the gate will resolve a root from, per the gate's own normaliser (every harness
 * key: `cwd`, `workspace_roots`, `workspaceRoots`, Windsurf `tool_info.cwd`, …).
 */
function payloadCwd(text: string): string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined; // not JSON: gateMain decides (fail-closed)
  }
  const cwd = normalizePayload(v)?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/** Owner-only state file: fresh file, mode 0600, and on Windows an ACL for the current user only. */
async function writeStateFile(file: string, state: DaemonState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Never reuse a pre-created file (it could carry someone else's ACL).
  await rm(file, { force: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
    return;
  }
  let user = process.env.USERNAME ?? "";
  if (user === "") {
    try {
      user = userInfo().username;
    } catch {
      user = "";
    }
  }
  if (user === "") {
    console.warn("AXIOM serve WARN: cannot restrict daemon.json ACL (no user name)");
    return;
  }
  await new Promise<void>((resolve) => {
    execFile(
      "icacls",
      [file, "/inheritance:r", "/grant:r", `${user}:F`],
      { windowsHide: true, timeout: 10_000 },
      (err) => {
        if (err !== null) {
          console.warn(`AXIOM serve WARN: icacls on daemon.json failed: ${err.message}`);
        }
        resolve();
      },
    );
  });
}

const TOOL_CALL_ID_KEYS = ["tool_use_id", "toolCallId", "tool_call_id"] as const;

/** Tool name + call id from the payload, for the span only (no content leaves the process). */
function payloadToolInfo(text: string): { tool?: string; toolCallId?: string } {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const o = v as Record<string, unknown>;
    const first = (keys: readonly string[]): string | undefined => {
      for (const k of keys) {
        const s = o[k];
        if (typeof s === "string" && s !== "") return s;
      }
      return undefined;
    };
    const tool = first(TOOL_NAME_KEYS);
    const toolCallId = first(TOOL_CALL_ID_KEYS);
    return {
      ...(tool === undefined ? {} : { tool }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    };
  } catch {
    return {};
  }
}

export async function startDaemon(opts: ServeOptions): Promise<RunningDaemon> {
  const host = opts.host ?? DAEMON_DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new AxiomError("ERR_ROOT_NOT_ALLOWED", `serve --hook binds loopback only, got ${host}`, {
      details: { host },
    });
  }
  if (opts.roots.length === 0) {
    throw new AxiomError("ERR_ROOT_REQUIRED", "serve --hook needs at least one --root");
  }
  const roots = [...opts.roots];
  const startedAt = new Date().toISOString();
  const key = randomBytes(32).toString("hex");
  let requests = 0;
  const otel = opts.otel;

  /** A verdict whose resolved root is outside the allowlist is discarded (the client decides). */
  const rootOk = async (r: GateResult): Promise<boolean> =>
    r.root === undefined || (await cwdAllowed(roots, r.root));

  const trace = (r: GateResult, text: string, format: string, startMs: number): void => {
    if (otel === undefined) return;
    try {
      otel.record({
        ...payloadToolInfo(text),
        decision: r.decision,
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(r.toolClass === undefined ? {} : { toolClass: r.toolClass }),
        ...(r.root === undefined ? {} : { root: r.root }),
        format,
        startMs,
        durationMs: r.durationMs,
      });
    } catch {
      // telemetry never affects the verdict
    }
  };

  const judge = async (
    argv: string[],
    body: Buffer | "toolarge",
    stdinState: string,
    cwd: string,
  ): Promise<GateResult> => {
    const read =
      body === "toolarge" || stdinState === "toolarge"
        ? { text: undefined, timedOut: false, tooLarge: true }
        : stdinState === "timeout"
          ? { text: undefined, timedOut: true, tooLarge: false }
          : { text: body.toString("utf8"), timedOut: false, tooLarge: false };
    return gateMain(argv, { read, cwdFallback: () => cwd });
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const t0 = performance.now();
    const wallStart = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const done = (status: number) =>
      opts.onRequest?.({ path: url.pathname, status, ms: performance.now() - t0 });
    // Browser pages and DNS rebinding: never answer a request that names a foreign host or an origin.
    const h = hostOf(req.headers.host);
    if (req.headers.origin !== undefined || h === undefined || !isLoopbackHost(h)) {
      send(res, 403, "forbidden");
      done(403);
      return;
    }
    if (!tokenOk(opts.token, req.headers.authorization)) {
      send(res, 401, "unauthorized");
      done(401);
      return;
    }
    if (req.method === "GET" && url.pathname === HEALTH_PATH) {
      send(
        res,
        200,
        JSON.stringify({
          protocol: DAEMON_PROTOCOL,
          version: opts.version,
          pid: process.pid,
          roots,
          startedAt,
          requests,
        }),
      );
      done(200);
      return;
    }
    if (
      req.method !== "POST" ||
      (url.pathname !== GATE_PATH && url.pathname !== CLAUDE_HOOK_PATH)
    ) {
      send(res, 404, "not found");
      done(404);
      return;
    }
    const body = await readBody(req, GATE_STDIN_MAX_BYTES);
    if (body === "toolarge") {
      res.on("finish", () => req.destroy());
      send(res, 413, "payload too large", { connection: "close" });
      done(413);
      return;
    }
    requests++;

    if (url.pathname === CLAUDE_HOOK_PATH) {
      // Claude `type: "http"` hook: no headers of ours; the payload carries `cwd`.
      const text = body.toString("utf8");
      const cwd = payloadCwd(text) ?? "";
      if (!(await cwdAllowed(roots, cwd))) {
        // Outside every root: no verdict from this daemon. Claude only blocks on a JSON deny or
        // `onFailure: "block"` (non-2xx counts as a failure) — 421 makes it fail closed.
        send(res, 421, "cwd outside the daemon roots");
        done(421);
        return;
      }
      const r = await judge(["--stdin", "--format", "claude"], body, "ok", cwd);
      if (!(await rootOk(r))) {
        send(res, 421, "gate root outside the daemon roots");
        done(421);
        return;
      }
      send(res, 200, r.stdout ?? "");
      trace(r, text, "claude", wallStart);
      done(200);
      return;
    }

    const proto = req.headers[H_PROTOCOL];
    if (proto !== String(DAEMON_PROTOCOL)) {
      // Protocol 1 clients cannot authenticate the answer: make them fall back (spawn) safely.
      const status = proto === "1" ? 426 : 409;
      send(res, status, status === 426 ? "upgrade required: protocol 2" : "protocol mismatch");
      done(status);
      return;
    }
    const nonce = req.headers[H_NONCE];
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      send(res, 400, "missing or malformed nonce");
      done(400);
      return;
    }
    const clientVersion = req.headers[H_VERSION];
    if (typeof clientVersion === "string" && clientVersion !== opts.version) {
      // A node client of another version decides in-process (its own gate semantics).
      send(res, 409, "version mismatch");
      done(409);
      return;
    }
    const cwd = decodeHeader(
      typeof req.headers[H_CWD] === "string" ? (req.headers[H_CWD] as string) : undefined,
    );
    const argv = url.searchParams.getAll("a");
    if (!argvAllowed(argv)) {
      send(res, 400, "argument not allowed over the daemon protocol");
      done(400);
      return;
    }
    const text = body.toString("utf8");
    const pcwd = payloadCwd(text);
    // Every directory the gate may resolve a root from must be inside an allowlisted root.
    const dirs = [cwd, pcwd].filter((d): d is string => d !== undefined && d !== "");
    const allowed = await Promise.all(dirs.map((d) => cwdAllowed(roots, d)));
    if (dirs.length === 0 || !allowed.every(Boolean)) {
      send(res, 421, "cwd outside the daemon roots");
      done(421);
      return;
    }
    const stdinHeader = req.headers[H_STDIN];
    const r = await judge(argv, body, typeof stdinHeader === "string" ? stdinHeader : "ok", cwd);
    if (!(await rootOk(r))) {
      send(res, 421, "gate root outside the daemon roots");
      done(421);
      return;
    }
    const out = r.stdout ?? "";
    send(res, 200, out, {
      [H_EXIT]: String(r.exitCode),
      [H_STDERR]: encodeHeader(r.stderr.join("\n")),
      [H_MAC]: daemonMac(key, nonce, r.exitCode, Buffer.from(out, "utf8")),
    });
    if (otel !== undefined) {
      const fi = argv.indexOf("--format");
      trace(r, text, (fi >= 0 ? argv[fi + 1] : undefined) ?? "auto", wallStart);
    }
    done(200);
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // No verdict: the client decides in-process / fail-closed.
      if (!res.headersSent) send(res, 500, err instanceof Error ? err.message : String(err));
      else res.end();
    });
  });
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DAEMON_DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 0);
  const state: DaemonState = {
    protocol: DAEMON_PROTOCOL,
    pid: process.pid,
    host,
    port,
    version: opts.version,
    roots,
    startedAt,
    key,
  };
  const statePath = daemonStatePath(opts.home ?? homedir());
  if (opts.noStateFile !== true) await writeStateFile(statePath, state);
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    host,
    port,
    url: `http://${urlHost}:${port}`,
    state,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await otel?.close();
      if (opts.noStateFile !== true) await rm(statePath, { force: true });
    },
  };
}
