import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";

/** AWS's own documentation placeholder, assembled so no key-shaped literal is written out. */
const KEY = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");

const profile = profileWith([
  { id: "secrets", predicate: "content.noSecrets", params: {}, severity: "error" },
]);

let cas: string;

beforeAll(async () => {
  cas = await mkdtemp(join(tmpdir(), "axiom-content-cas-"));
});

afterAll(async () => {
  await rm(cas, { recursive: true, force: true });
});

async function putCas(bytes: Uint8Array): Promise<void> {
  const hex = sha256Hex(bytes);
  await mkdir(join(cas, "sha256", hex.slice(0, 2)), { recursive: true });
  await writeFile(join(cas, "sha256", hex.slice(0, 2), hex), bytes);
}

describe("content.noSecrets scans the whole artifact (A1-9)", () => {
  it("finds a secret placed after the first 4 MiB", async () => {
    const bytes = new TextEncoder().encode(`${"x".repeat(4 * 1024 * 1024)}${KEY}`);
    await putCas(bytes);
    const bundle = makeBundle([{ path: "big.txt", content: bytes, noBlob: true }]);
    const r = await runChecks({ bundle, casDir: cas, profile });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.id)).toContain("content.noSecrets.awsKey");
  });

  it("errors when a content predicate cannot read the artifact", async () => {
    const bundle = makeBundle([{ path: "x.txt", content: KEY, noBlob: true }]);
    const r = await runChecks({ bundle, profile });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.id).toBe("content.noSecrets.unreadable");
    expect(r.findings[0]?.facts.code).toBe("ERR_BLOB_MISSING");
  });
});
