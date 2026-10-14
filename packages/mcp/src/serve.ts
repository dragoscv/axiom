/**
 * `axiom serve --hook` — resident gate daemon (D-36, S-901). Keeps the gate chunk (zod, checks,
 * apply containment) warm in one process so a hook call costs a loopback HTTP round trip instead
 * of a node start + chunk load. Wire protocol: `daemon-proto.ts`.
 *
 * Security: loopback only (a non-loopback `--host` is refused at startup), requests with an
 * `Origin` header or a non-loopback `Host` are refused (DNS rebinding / browser pages), an
 * optional bearer token (`--token-env`), and an explicit root allowlist (`--root`, invariant 8):
 * a hook whose cwd is outside every root gets 421 and decides in-process instead. The daemon
 * never writes to the working tree — it only answers `gateMain`.
 *
 * Never writes to stdout itself (`check-no-stdout`): the CLI prints the startup line.
 */
import { timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import * as path from "node:path";
import { AxiomError } from "@codai/axiom-schema";
import {
  CLAUDE_HOOK_PATH,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_PROTOCOL,
  type DaemonState,
  daemonStatePath,
  decodeHeader,
  encodeHeader,
  GATE_PATH,
  H_CWD,
  H_EXIT,
  H_PROTOCOL,
  H_STDERR,
  H_STDIN,
  H_VERSION,
  HEALTH_PATH,
} from "./daemon-proto.js";
import { GATE_STDIN_MAX_BYTES, type GateResult, gateMain } from "./gate.js";
import { TOOL_NAME_KEYS } from "./gate-fast.js";
import type { OtelExporter } from "./otel.js";
import { isSameOrInside, realDir } from "./roots.js";

export interface ServeOptions {
  /** realpath'd allowlisted roots (at least one). */
  roots: readonly string[];
  host?: string;
  /** 0 = random free port. */
  port?: number;
  version: string;
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

function tokenOk(expected: string | undefined, auth: string | undefined): boolean {
  if (expected === undefined) return true;
  if (auth === undefined || !auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice("Bearer ".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | "toolarge"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? "toolarge" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type":
      status === 200 ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
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

/** Payload `cwd` (any harness key) when present — also must be inside a root. */
function payloadCwd(text: string): string | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return undefined;
    const o = v as Record<string, unknown>;
    for (const k of ["cwd", "workingDirectory", "working_directory"]) {
      const s = o[k];
      if (typeof s === "string" && s !== "") return s;
    }
  } catch {
    // not JSON: gateMain decides (fail-closed)
  }
  return undefined;
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
  let requests = 0;
  const otel = opts.otel;

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
    requests++;

    if (url.pathname === CLAUDE_HOOK_PATH) {
      // Claude `type: "http"` hook: no headers of ours; the payload carries `cwd`.
      const text = body === "toolarge" ? "" : body.toString("utf8");
      const cwd = payloadCwd(text) ?? "";
      if (body !== "toolarge" && !(await cwdAllowed(roots, cwd))) {
        // Outside every root: no verdict from this daemon. Claude only blocks on a JSON deny or
        // `onFailure: "block"` (non-2xx counts as a failure) — 421 makes it fail closed.
        send(res, 421, "cwd outside the daemon roots");
        done(421);
        return;
      }
      const r = await judge(["--stdin", "--format", "claude"], body, "ok", cwd);
      send(res, 200, r.stdout ?? "");
      trace(r, text, "claude", wallStart);
      done(200);
      return;
    }

    if (req.headers[H_PROTOCOL] !== String(DAEMON_PROTOCOL)) {
      send(res, 409, "protocol mismatch");
      done(409);
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
    const text = body === "toolarge" ? "" : body.toString("utf8");
    const pcwd = payloadCwd(text);
    const argv = url.searchParams.getAll("a");
    const rootArg = argv.indexOf("--root");
    const explicitRoot = rootArg >= 0 ? argv[rootArg + 1] : undefined;
    // Every directory the gate may resolve a root from must be inside an allowlisted root.
    const dirs = [cwd, pcwd, explicitRoot].filter((d): d is string => d !== undefined);
    const allowed = await Promise.all(dirs.map((d) => cwdAllowed(roots, d)));
    if (dirs.length === 0 || !allowed.every(Boolean)) {
      send(res, 421, "cwd outside the daemon roots");
      done(421);
      return;
    }
    const stdinHeader = req.headers[H_STDIN];
    const r = await judge(argv, body, typeof stdinHeader === "string" ? stdinHeader : "ok", cwd);
    send(res, 200, r.stdout ?? "", {
      [H_EXIT]: String(r.exitCode),
      [H_STDERR]: encodeHeader(r.stderr.join("\n")),
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
    ...(opts.token === undefined ? {} : { token: opts.token }),
  };
  const statePath = daemonStatePath(opts.home ?? homedir());
  if (opts.noStateFile !== true) {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
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
