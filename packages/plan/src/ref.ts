import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDigestRef } from "@codai/axiom-canon";
import { AxiomError } from "@codai/axiom-schema";
import { casGet, casHas, casPath } from "./cas.js";

/** Hard cap for a fetched `ref` (design §2.5 says 64 MiB; the CAS reader caps at 32 MiB). */
export const REF_BYTES_MAX: number = 32 * 1024 * 1024;
export const REF_TIMEOUT_MS: number = 30_000;

export interface RefNetOptions {
  /** `false` (default) → a `ref` not already in the CAS is `ERR_NET_DISABLED`. */
  allowNet: boolean;
  /** Host patterns (`example.com` exact, `*.example.com` any subdomain). Absent → every https host. */
  allowlist?: string[];
  /** Permit `file:` URIs (local vendored assets). Default false. */
  allowFile?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ResolveRefOptions extends RefNetOptions {
  /** Repository root — the CAS lives at `<root>/.axiom/cas`. */
  root: string;
  /** Artifact path, for error reporting. */
  path?: string;
}

export interface RefSource {
  uri: string;
  digest: string;
}

/** `origin + pathname` — never the query string or fragment (may carry tokens). */
export function redactUri(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === "file:" ? `file://${u.pathname}` : `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid uri>";
  }
}

/** `*.example.com` matches any proper subdomain; a bare host matches exactly. Case-insensitive. */
export function hostAllowed(host: string, allowlist: readonly string[] | undefined): boolean {
  if (allowlist === undefined) return true;
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const p = raw.trim().toLowerCase();
    if (p === "") continue;
    if (p.startsWith("*.")) {
      if (h.endsWith(p.slice(1)) && h.length > p.length - 1) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

function netError(
  code: "ERR_NET_DISABLED" | "ERR_NET_DENIED" | "ERR_NET_FAILED",
  message: string,
  src: RefSource,
  opts: ResolveRefOptions,
  extra: Record<string, unknown> = {},
): AxiomError {
  let host: string | undefined;
  try {
    host = new URL(src.uri).host;
  } catch {
    host = undefined;
  }
  const details: Record<string, unknown> = {
    uri: redactUri(src.uri),
    digest: src.digest,
    ...extra,
  };
  if (host !== undefined) details.host = host;
  const o: { path?: string; details: Record<string, unknown> } = { details };
  if (opts.path !== undefined) o.path = opts.path;
  return new AxiomError(code, message, o);
}

interface Sink {
  tmp: string;
  fh: FileHandle;
  hash: ReturnType<typeof createHash>;
  bytes: number;
}

async function openSink(root: string, hex: string): Promise<Sink> {
  const target = casPath(root, hex);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx");
  return { tmp, fh, hash: createHash("sha256"), bytes: 0 };
}

async function readFileStream(
  uri: URL,
  sink: Sink,
  maxBytes: number,
  src: RefSource,
  opts: ResolveRefOptions,
): Promise<void> {
  const p = fileURLToPath(uri);
  const st = await stat(p).catch(() => undefined);
  if (st === undefined || !st.isFile()) {
    throw netError("ERR_NET_FAILED", "file ref does not exist or is not a file", src, opts);
  }
  if (st.size > maxBytes) {
    throw new AxiomError("ERR_BLOB_TOO_LARGE", `ref is ${st.size} bytes`, {
      details: { bytes: st.size, max: maxBytes, uri: redactUri(src.uri) },
    });
  }
  for await (const chunk of createReadStream(p)) {
    const c = chunk as Buffer;
    sink.bytes += c.length;
    if (sink.bytes > maxBytes) {
      throw new AxiomError("ERR_BLOB_TOO_LARGE", "ref exceeds maxBytes", {
        details: { max: maxBytes, uri: redactUri(src.uri) },
      });
    }
    sink.hash.update(c);
    await sink.fh.write(c);
  }
}

async function readHttpsStream(
  uri: URL,
  sink: Sink,
  maxBytes: number,
  timeoutMs: number,
  src: RefSource,
  opts: ResolveRefOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(uri, {
        method: "GET",
        redirect: "error",
        signal: ac.signal,
        headers: { accept: "*/*" },
      });
    } catch (err) {
      const timedOut = ac.signal.aborted;
      throw netError(
        "ERR_NET_FAILED",
        timedOut ? `ref fetch timed out after ${timeoutMs} ms` : "ref fetch failed",
        src,
        opts,
        {
          reason: timedOut ? "timeout" : (err as Error).message,
        },
      );
    }
    if (!res.ok) {
      throw netError("ERR_NET_FAILED", `ref fetch returned HTTP ${res.status}`, src, opts, {
        status: res.status,
      });
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new AxiomError("ERR_BLOB_TOO_LARGE", `ref declares ${declared} bytes`, {
        details: { bytes: declared, max: maxBytes, uri: redactUri(src.uri) },
      });
    }
    if (res.body === null) return;
    const reader = res.body.getReader();
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (err) {
        throw netError(
          "ERR_NET_FAILED",
          ac.signal.aborted ? `ref fetch timed out after ${timeoutMs} ms` : "ref body read failed",
          src,
          opts,
          { reason: ac.signal.aborted ? "timeout" : (err as Error).message },
        );
      }
      if (step.done) break;
      sink.bytes += step.value.length;
      if (sink.bytes > maxBytes) {
        ac.abort(new Error("maxBytes"));
        await reader.cancel().catch(() => undefined);
        throw new AxiomError("ERR_BLOB_TOO_LARGE", "ref exceeds maxBytes", {
          details: { max: maxBytes, uri: redactUri(src.uri) },
        });
      }
      sink.hash.update(step.value);
      await sink.fh.write(step.value);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a pinned `{ uri, digest }` source. Order: CAS hit (no network, even when
 * `allowNet` is false) → `ERR_NET_DISABLED` unless `allowNet` → `https:` only
 * (`file:` with `allowFile`), host allowlist, `redirect: "error"`, timeout, byte cap →
 * digest check → atomic store in the CAS. A digest mismatch is never stored.
 */
export async function resolveRef(src: RefSource, opts: ResolveRefOptions): Promise<Uint8Array> {
  const hex = parseDigestRef(src.digest as `sha256:${string}`);
  const cached = await casGet(opts.root, hex);
  if (cached !== undefined) return cached;

  if (!opts.allowNet) {
    throw netError(
      "ERR_NET_DISABLED",
      "ref is not in the CAS and network access is disabled (pass --allow-net)",
      src,
      opts,
    );
  }
  let uri: URL;
  try {
    uri = new URL(src.uri);
  } catch {
    throw netError("ERR_NET_DENIED", "ref uri is not a valid URL", src, opts);
  }
  if (uri.protocol === "file:") {
    if (opts.allowFile !== true) {
      throw netError("ERR_NET_DENIED", "file: refs need allowFile", src, opts, {
        protocol: "file:",
      });
    }
  } else if (uri.protocol !== "https:") {
    throw netError("ERR_NET_DENIED", "only https: refs are fetched", src, opts, {
      protocol: uri.protocol,
    });
  } else if (uri.username !== "" || uri.password !== "") {
    throw netError("ERR_NET_DENIED", "credentials in a ref uri are not allowed", src, opts);
  } else if (!hostAllowed(uri.hostname, opts.allowlist)) {
    throw netError("ERR_NET_DENIED", "ref host is not in the allowlist", src, opts, {
      allowlist: opts.allowlist ?? [],
    });
  }

  const maxBytes = opts.maxBytes ?? REF_BYTES_MAX;
  const timeoutMs = opts.timeoutMs ?? REF_TIMEOUT_MS;
  const sink = await openSink(opts.root, hex);
  let ok = false;
  try {
    if (uri.protocol === "file:") await readFileStream(uri, sink, maxBytes, src, opts);
    else await readHttpsStream(uri, sink, maxBytes, timeoutMs, src, opts);
    const actual = sink.hash.digest("hex");
    if (actual !== hex) {
      throw new AxiomError("ERR_DIGEST_MISMATCH", "fetched ref does not match its pinned digest", {
        details: {
          expected: src.digest,
          actual: `sha256:${actual}`,
          bytes: sink.bytes,
          uri: redactUri(src.uri),
        },
      });
    }
    await sink.fh.sync();
    await sink.fh.close();
    ok = true;
    try {
      await rename(sink.tmp, casPath(opts.root, hex));
    } catch (err) {
      await rm(sink.tmp, { force: true });
      if (!(await casHas(opts.root, hex))) throw err;
    }
  } finally {
    if (!ok) {
      await sink.fh.close().catch(() => undefined);
      await rm(sink.tmp, { force: true });
    }
  }
  const bytes = await casGet(opts.root, hex);
  if (bytes === undefined) {
    throw new AxiomError("ERR_BLOB_MISSING", "ref was stored but cannot be read back", {
      details: { digest: src.digest },
    });
  }
  return bytes;
}
