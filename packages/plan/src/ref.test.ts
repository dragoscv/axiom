import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "@codai/axiom-canon";
import { type AxiomError, isAxiomError } from "@codai/axiom-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { casHas, casPath, casPut } from "./cas.js";
import { compilePlan } from "./compile.js";
import { hostAllowed, redactUri, resolveRef } from "./ref.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "axiom-ref-"));
  tmpDirs.push(d);
  return d;
}

async function expectAxiom(p: Promise<unknown>, code: string): Promise<AxiomError> {
  try {
    await p;
  } catch (err) {
    expect(isAxiomError(err)).toBe(true);
    expect((err as AxiomError).code).toBe(code);
    return err as AxiomError;
  }
  throw new Error(`expected ${code}`);
}

const BODY = new TextEncoder().encode("vendored asset bytes\n");
const DIGEST = `sha256:${sha256Hex(BODY)}` as const;
const URI = "https://cdn.example.com/assets/v.bin?token=SECRET";

function okFetch(body: Uint8Array = BODY, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;
}

async function casFiles(root: string, hex: string): Promise<string[]> {
  try {
    return await readdir(join(root, ".axiom", "cas", "sha256", hex.slice(0, 2)));
  } catch {
    return [];
  }
}

describe("resolveRef", () => {
  it("CAS hit returns bytes without touching the network or needing allowNet", async () => {
    const root = await tmp();
    await casPut(root, BODY);
    const fetchImpl = okFetch();
    const bytes = await resolveRef(
      { uri: URI, digest: DIGEST },
      { root, allowNet: false, fetchImpl },
    );
    expect(bytes).toEqual(BODY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("net disabled → ERR_NET_DISABLED with host, uri redacted", async () => {
    const root = await tmp();
    const fetchImpl = okFetch();
    const err = await expectAxiom(
      resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: false, fetchImpl, path: "v.bin" }),
      "ERR_NET_DISABLED",
    );
    expect(err.details?.host).toBe("cdn.example.com");
    expect(err.details?.uri).toBe("https://cdn.example.com/assets/v.bin");
    expect(JSON.stringify(err.toJSON())).not.toContain("SECRET");
    expect(err.path).toBe("v.bin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("http:// is rejected (ERR_NET_DENIED) even with allowNet", async () => {
    const root = await tmp();
    const fetchImpl = okFetch();
    const err = await expectAxiom(
      resolveRef(
        { uri: "http://cdn.example.com/v.bin", digest: DIGEST },
        { root, allowNet: true, fetchImpl },
      ),
      "ERR_NET_DENIED",
    );
    expect(err.details?.protocol).toBe("http:");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("file: is rejected unless allowFile, then read from disk", async () => {
    const root = await tmp();
    const src = join(root, "asset.bin");
    await writeFile(src, BODY);
    const uri = pathToFileURL(src).href;
    await expectAxiom(
      resolveRef({ uri, digest: DIGEST }, { root, allowNet: true }),
      "ERR_NET_DENIED",
    );
    const bytes = await resolveRef(
      { uri, digest: DIGEST },
      { root, allowNet: true, allowFile: true },
    );
    expect(bytes).toEqual(BODY);
    expect(await casHas(root, sha256Hex(BODY))).toBe(true);
  });

  it("host not in allowlist → ERR_NET_DENIED; wildcard and exact matches work", async () => {
    const root = await tmp();
    const fetchImpl = okFetch();
    const err = await expectAxiom(
      resolveRef(
        { uri: URI, digest: DIGEST },
        { root, allowNet: true, allowlist: ["example.org", "*.other.net"], fetchImpl },
      ),
      "ERR_NET_DENIED",
    );
    expect(err.details?.allowlist).toEqual(["example.org", "*.other.net"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hostAllowed("cdn.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("CDN.Example.com", ["cdn.example.com"])).toBe(true);
    expect(hostAllowed("evilexample.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("any.host", undefined)).toBe(true);
    expect(hostAllowed("any.host", [])).toBe(false);
  });

  it("credentials in the uri are rejected", async () => {
    const root = await tmp();
    await expectAxiom(
      resolveRef(
        { uri: "https://user:pw@cdn.example.com/v.bin", digest: DIGEST },
        { root, allowNet: true, fetchImpl: okFetch() },
      ),
      "ERR_NET_DENIED",
    );
  });

  it("digest mismatch → ERR_DIGEST_MISMATCH and nothing is stored (no tmp left)", async () => {
    const root = await tmp();
    const wrong = new TextEncoder().encode("tampered\n");
    const err = await expectAxiom(
      resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: true, fetchImpl: okFetch(wrong) }),
      "ERR_DIGEST_MISMATCH",
    );
    expect(err.details?.actual).toBe(`sha256:${sha256Hex(wrong)}`);
    expect(await casHas(root, sha256Hex(BODY))).toBe(false);
    expect(await casHas(root, sha256Hex(wrong))).toBe(false);
    expect(await casFiles(root, sha256Hex(BODY))).toEqual([]);
  });

  it("byte cap aborts the stream → ERR_BLOB_TOO_LARGE, nothing stored", async () => {
    const root = await tmp();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream)) as unknown as typeof fetch;
    await expectAxiom(
      resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: true, fetchImpl, maxBytes: 4096 }),
      "ERR_BLOB_TOO_LARGE",
    );
    expect(cancelled).toBe(true);
    expect(await casFiles(root, sha256Hex(BODY))).toEqual([]);
  });

  it("content-length above the cap is refused before reading", async () => {
    const root = await tmp();
    await expectAxiom(
      resolveRef(
        { uri: URI, digest: DIGEST },
        {
          root,
          allowNet: true,
          maxBytes: 10,
          fetchImpl: okFetch(BODY, { headers: { "content-length": "999999" } }),
        },
      ),
      "ERR_BLOB_TOO_LARGE",
    );
  });

  it("timeout aborts → ERR_NET_FAILED reason timeout", async () => {
    const root = await tmp();
    const fetchImpl = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const err = await expectAxiom(
      resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: true, fetchImpl, timeoutMs: 20 }),
      "ERR_NET_FAILED",
    );
    expect(err.details?.reason).toBe("timeout");
    expect(await casFiles(root, sha256Hex(BODY))).toEqual([]);
  });

  it("redirects are requested with redirect:error and a thrown redirect is ERR_NET_FAILED", async () => {
    const root = await tmp();
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("fetch failed: unexpected redirect");
    }) as unknown as typeof fetch;
    await expectAxiom(
      resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: true, fetchImpl }),
      "ERR_NET_FAILED",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("non-2xx → ERR_NET_FAILED with status", async () => {
    const root = await tmp();
    const err = await expectAxiom(
      resolveRef(
        { uri: URI, digest: DIGEST },
        { root, allowNet: true, fetchImpl: okFetch(BODY, { status: 404 }) },
      ),
      "ERR_NET_FAILED",
    );
    expect(err.details?.status).toBe(404);
  });

  it("success stores in the CAS; the second call is a CAS hit (fetch called once)", async () => {
    const root = await tmp();
    const fetchImpl = okFetch();
    const a = await resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: true, fetchImpl });
    expect(a).toEqual(BODY);
    expect(await casHas(root, sha256Hex(BODY))).toBe(true);
    expect(await casFiles(root, sha256Hex(BODY))).toEqual([sha256Hex(BODY)]);
    const b = await resolveRef({ uri: URI, digest: DIGEST }, { root, allowNet: false, fetchImpl });
    expect(b).toEqual(BODY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL];
    expect(String(calledUrl)).toBe(URI);
  });

  it("redactUri strips query and fragment", () => {
    expect(redactUri("https://h.example/a/b?x=1#f")).toBe("https://h.example/a/b");
    expect(redactUri("file:///C:/a/b.bin?x")).toBe("file:///C:/a/b.bin");
    expect(redactUri("not a url")).toBe("<invalid uri>");
  });
});

describe("compilePlan with ref sources", () => {
  const planWithRef = () => ({
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: "refs",
    intent: "t",
    artifacts: [
      { path: "vendor/v.bin", source: { type: "ref", uri: URI, digest: DIGEST } },
      { path: "a.txt", source: { type: "inline", content: "hi" } },
    ],
  });

  it("without a root → ERR_REF_OFFLINE; with root and no net → ERR_NET_DISABLED", async () => {
    await expectAxiom(compilePlan(planWithRef()), "ERR_REF_OFFLINE");
    const root = await tmp();
    await expectAxiom(compilePlan(planWithRef(), { root }), "ERR_NET_DISABLED");
  });

  it("fetches with net.allowNet, keeps origin ref, never inlines the ref bytes", async () => {
    const root = await tmp();
    const fetchImpl = okFetch();
    const { bundle } = await compilePlan(planWithRef(), {
      root,
      net: { allowNet: true, allowlist: ["cdn.example.com"], fetchImpl },
    });
    const ref = bundle.manifest.artifacts.find((a) => a.path === "vendor/v.bin");
    expect(ref?.origin).toBe("ref");
    expect(ref?.digest?.sha256).toBe(sha256Hex(BODY));
    expect(ref?.bytes).toBe(BODY.length);
    expect(Object.keys(bundle.blobs)).toEqual([`sha256:${sha256Hex("hi")}`]);
    expect(await casHas(root, sha256Hex(BODY))).toBe(true);
    // second compile is offline (CAS hit) and yields the same manifestDigest
    const again = await compilePlan(planWithRef(), { root });
    expect(again.bundle.manifestDigest).toBe(bundle.manifestDigest);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(casPath(root, sha256Hex(BODY))).toContain(join(".axiom", "cas", "sha256"));
  });
});
