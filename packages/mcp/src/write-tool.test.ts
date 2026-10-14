import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness, structured, tmpRepo } from "./test-helpers.js";
import { TOOL_DEFS } from "./tools.js";

interface WriteOut {
  status: string;
  manifestDigest: string;
  mode: string;
  diff?: string;
  journal?: string;
  next?: string;
  checks?: { verdict: string };
  files: { path: string; op: string; status: string }[];
  error?: { code: string };
}

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let h: Harness;

beforeEach(async () => {
  repo = await tmpRepo("axiom-mcp-write-");
  h = await harness([repo.root]);
});
afterEach(async () => {
  await h.close();
  await repo.cleanup();
});

const files = [
  { path: "src/a.ts", content: "export const a = 1;\n" },
  { path: "README.md", content: "# hi\n" },
];
const write = (args: Record<string, unknown>) =>
  h.call("axiom_write", { root: repo.root, ...args });
const code = (r: Awaited<ReturnType<typeof write>>) => structured<{ code: string }>(r).code;

describe("axiom_write registration", () => {
  it("is a SENSITIVE destructive tool listed with an outputSchema", async () => {
    const { tools } = await h.client.listTools();
    const t = tools.find((x) => x.name === "axiom_write");
    expect(t?.annotations?.destructiveHint).toBe(true);
    expect(t?.outputSchema?.type).toBe("object");
    expect(TOOL_DEFS.find((d) => d.name === "axiom_write")?.riskClass).toBe("SENSITIVE");
  });
});

describe("axiom_write", () => {
  it("preview touches nothing, confirm applies, journals and re-confirm is a noop", async () => {
    const p = await write({ files, intent: "add a" });
    expect(p.isError).toBeUndefined();
    const prev = structured<WriteOut>(p);
    expect(prev.status).toBe("preview");
    expect(prev.mode).toBe("dry-run");
    expect(prev.checks?.verdict).toBe("pass");
    expect(prev.diff).toContain("export const a = 1;");
    expect(prev.next).toContain(prev.manifestDigest);
    await expect(stat(join(repo.root, "src", "a.ts"))).rejects.toThrow();

    const a = structured<WriteOut>(
      await write({ files, intent: "add a", confirmDigest: prev.manifestDigest }),
    );
    expect(a.status).toBe("applied");
    expect(a.manifestDigest).toBe(prev.manifestDigest);
    expect(a.journal).toBeDefined();
    expect(await readFile(join(repo.root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await readdir(join(repo.root, ".axiom", "journal"))).toContain(
      `${prev.manifestDigest.slice(7)}.json`,
    );

    const again = await write({ files, intent: "add a", confirmDigest: prev.manifestDigest });
    expect(again.isError).toBeUndefined();
    expect(structured<WriteOut>(again).status).toBe("noop");

    const rb = await h.call("axiom_rollback", {
      root: repo.root,
      manifestDigest: prev.manifestDigest,
    });
    expect(rb.isError).toBeUndefined();
    await expect(stat(join(repo.root, "src", "a.ts"))).rejects.toThrow();
  });

  it("same files + same tree → same digest (deterministic preview)", async () => {
    const d1 = structured<WriteOut>(await write({ files })).manifestDigest;
    const d2 = structured<WriteOut>(await write({ files: [...files].reverse() })).manifestDigest;
    expect(d2).toBe(d1);
  });

  it("apply without preview and a wrong digest → ERR_CONFIRM_DIGEST_MISMATCH, nothing written", async () => {
    const r = await write({ files, confirmDigest: `sha256:${"0".repeat(64)}` });
    expect(r.isError).toBe(true);
    expect(code(r)).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    await expect(stat(join(repo.root, "src", "a.ts"))).rejects.toThrow();
  });

  it("a target modified between preview and confirm → ERR_CONFIRM_DIGEST_MISMATCH", async () => {
    await writeFile(join(repo.root, "README.md"), "# old\n");
    const prev = structured<WriteOut>(await write({ files }));
    await writeFile(join(repo.root, "README.md"), "# changed by someone else\n");
    const r = await write({ files, confirmDigest: prev.manifestDigest });
    expect(r.isError).toBe(true);
    expect(code(r)).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(await readFile(join(repo.root, "README.md"), "utf8")).toBe(
      "# changed by someone else\n",
    );
  });

  it("overwrites an existing file and deletes another", async () => {
    await writeFile(join(repo.root, "keep.txt"), "v1\n");
    await writeFile(join(repo.root, "gone.txt"), "bye\n");
    const set = [
      { path: "keep.txt", content: "v2\n" },
      { path: "gone.txt", op: "delete" },
    ];
    const prev = structured<WriteOut>(await write({ files: set }));
    expect(prev.status).toBe("preview");
    const a = structured<WriteOut>(await write({ files: set, confirmDigest: prev.manifestDigest }));
    expect(a.status).toBe("applied");
    expect(a.files.find((f) => f.path === "gone.txt")?.status).toBe("deleted");
    expect(await readFile(join(repo.root, "keep.txt"), "utf8")).toBe("v2\n");
    await expect(stat(join(repo.root, "gone.txt"))).rejects.toThrow();
  });

  it("base64 content is decoded to exact bytes", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10]);
    const set = [{ path: "bin/blob.dat", content: bytes.toString("base64"), encoding: "base64" }];
    const prev = structured<WriteOut>(await write({ files: set }));
    const a = structured<WriteOut>(await write({ files: set, confirmDigest: prev.manifestDigest }));
    expect(a.status).toBe("applied");
    expect(Buffer.compare(await readFile(join(repo.root, "bin", "blob.dat")), bytes)).toBe(0);
  });

  it("content on a delete → ERR_INVALID_PLAN; missing content on a write → ERR_INVALID_PLAN", async () => {
    const r1 = await write({ files: [{ path: "a.txt", op: "delete", content: "x" }] });
    expect(r1.isError).toBe(true);
    expect(code(r1)).toBe("ERR_INVALID_PLAN");
    const r2 = await write({ files: [{ path: "a.txt" }] });
    expect(r2.isError).toBe(true);
    expect(code(r2)).toBe("ERR_INVALID_PLAN");
  });

  it("secrets are blocked by checks: preview and confirm fail with ERR_CHECKS_FAILED", async () => {
    const set = [
      {
        path: ".env",
        content: "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEabcdefghijklmnopqrstu\n",
      },
    ];
    const prev = structured<WriteOut>(await write({ files: set }));
    expect(prev.status).toBe("failed");
    expect(prev.error?.code).toBe("ERR_CHECKS_FAILED");
    expect(prev.checks?.verdict).not.toBe("pass");
    const a = structured<WriteOut>(await write({ files: set, confirmDigest: prev.manifestDigest }));
    expect(a.status).toBe("failed");
    expect(a.error?.code).toBe("ERR_CHECKS_FAILED");
    await expect(stat(join(repo.root, ".env"))).rejects.toThrow();
  });

  it("root outside the allowlist → ERR_ROOT_NOT_ALLOWED", async () => {
    const other = await tmpRepo("axiom-mcp-write-other-");
    try {
      const r = await h.call("axiom_write", { root: other.root, files });
      expect(r.isError).toBe(true);
      expect(code(r)).toBe("ERR_ROOT_NOT_ALLOWED");
    } finally {
      await other.cleanup();
    }
  });
});
