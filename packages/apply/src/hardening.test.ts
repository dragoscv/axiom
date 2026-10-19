import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "@codai/axiom-canon";
import { AxiomError, type CheckReport, type ManifestBundle } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { apply, rollback } from "./apply.js";
import { exists, makeBundle, mkRoot, readText, writeTree } from "./test-helpers.js";

const execFileP = promisify(execFile);
const CASE_INSENSITIVE_OS = process.platform === "win32" || process.platform === "darwin";

function fsApply(
  bundle: ManifestBundle,
  root: string,
  extra: Partial<Parameters<typeof apply>[0]> = {},
) {
  return apply({ bundle, root, mode: "fs", confirmDigest: bundle.manifestDigest, ...extra });
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AxiomError ? err.code : `non-axiom:${String(err)}`;
  }
}

function passReport(bundle: ManifestBundle): CheckReport {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "CheckReport",
    manifestDigest: bundle.manifestDigest,
    profile: "default",
    verdict: "pass",
    findings: [],
    factsDigest: `sha256:${sha256Hex("f")}`,
    durationMs: 0,
    providers: [],
  };
}

/** A root that already has AXIOM state (`.axiom/trust/keys.json`), as after `axiom init`. */
async function rootWithTrust(): Promise<string> {
  const root = await mkRoot();
  await writeTree(root, { ".axiom/trust/keys.json": '{"keys":["real"]}' });
  return root;
}

describe("reserved .axiom/ directory (rc3 P0)", () => {
  it.each([".AXIOM/trust/keys.json", ".Axiom/trust/keys.json", ".axiom/trust/keys.json", ".AXIOM"])(
    "%s → ERR_PATH_RESERVED_DIR, trust keys untouched",
    async (p) => {
      const root = await rootWithTrust();
      const r = await fsApply(makeBundle([{ path: p, content: '{"keys":[]}' }]), root);
      expect(r.status).toBe("failed");
      expect(r.error?.code).toBe("ERR_PATH_RESERVED_DIR");
      expect(await readText(root, ".axiom/trust/keys.json")).toBe('{"keys":["real"]}');
    },
  );

  it("dry-run refuses it too (nothing staged)", async () => {
    const root = await rootWithTrust();
    const r = await apply({
      bundle: makeBundle([{ path: ".AXIOM/journal/x.json", content: "{}" }]),
      root,
      mode: "dry-run",
    });
    expect(r.error?.code).toBe("ERR_PATH_RESERVED_DIR");
  });

  it("a fullwidth/other-script look-alike is NOT reserved (only NFC+lowercase equality)", async () => {
    const root = await rootWithTrust();
    const r = await fsApply(makeBundle([{ path: "axiom/x.txt", content: "ok" }]), root);
    expect(r.status).toBe("applied");
    expect(await readText(root, "axiom/x.txt")).toBe("ok");
  });

  it("junction alias of .axiom is refused, trust keys untouched", async () => {
    const root = await rootWithTrust();
    try {
      await fs.symlink(path.join(root, ".axiom"), path.join(root, "alias"), "junction");
    } catch (err) {
      const c = (err as { code?: string }).code;
      // skip reason: no symlink privilege on this machine (POSIX junction = dir symlink, allowed)
      if (c === "EPERM" || c === "EACCES") return;
      throw err;
    }
    const r = await fsApply(makeBundle([{ path: "alias/trust/keys.json", content: "{}" }]), root);
    expect(r.status).toBe("failed");
    expect(["ERR_SYMLINK_IN_PATH", "ERR_PATH_RESERVED_DIR"]).toContain(r.error?.code);
    expect(await readText(root, ".axiom/trust/keys.json")).toBe('{"keys":["real"]}');
  });

  // skip reason: 8.3 short names exist only on Windows volumes
  it.runIf(process.platform === "win32")(
    "8.3 short alias (AXIOM~1) of .axiom → ERR_PATH_RESERVED_DIR",
    async () => {
      const root = await rootWithTrust();
      const { stdout } = await execFileP("cmd.exe", ["/d", "/c", "dir", "/x", "/a:d", root], {
        windowsHide: true,
      });
      const line = stdout.split(/\r?\n/).find((l) => / \.axiom$/i.test(l));
      const short = line?.trim().split(/\s+/).slice(-2, -1)[0] ?? "";
      if (!short.includes("~")) {
        // skip reason: 8.3 name generation is disabled on this volume (fsutil 8dot3name)
        expect(short.includes("~")).toBe(false);
        return;
      }
      const r = await fsApply(
        makeBundle([{ path: `${short}/trust/keys.json`, content: "{}" }]),
        root,
      );
      expect(r.status).toBe("failed");
      expect(r.error?.code).toBe("ERR_PATH_RESERVED_DIR");
      expect(await readText(root, ".axiom/trust/keys.json")).toBe('{"keys":["real"]}');
    },
  );
});

describe("planted journal (rc3 P0)", () => {
  async function plant(root: string, backup: string, hex = "ab".repeat(32)): Promise<string> {
    const j = {
      manifestDigest: `sha256:${hex}`,
      phase: "committing",
      steps: [{ path: "stolen.txt", op: "delete", backup, done: true }],
      startedAt: new Date().toISOString(),
      pid: 1,
    };
    await fs.mkdir(path.join(root, ".axiom", "journal"), { recursive: true });
    await fs.writeFile(path.join(root, ".axiom", "journal", `${hex}.json`), JSON.stringify(j));
    return `sha256:${hex}`;
  }

  it("a ../ backup is ERR_JOURNAL_CORRUPT; recovery never moves the outside victim in", async () => {
    const outside = await mkRoot();
    const root = await mkRoot();
    await writeTree(outside, { "victim.txt": "VICTIM" });
    const rel = path.relative(root, path.join(outside, "victim.txt")).split(path.sep).join("/");
    const digest = await plant(root, rel);
    await expect(rollback(root, digest as `sha256:${string}`)).rejects.toMatchObject({
      code: "ERR_JOURNAL_CORRUPT",
    });
    const r = await fsApply(makeBundle([{ path: "z.txt", content: "z" }]), root);
    expect(r.status).toBe("applied");
    expect(await exists(outside, "victim.txt")).toBe(true);
    expect(await exists(root, "stolen.txt")).toBe(false);
  });

  it("a backup inside .axiom/backup but of ANOTHER digest is ERR_JOURNAL_CORRUPT, nothing moved", async () => {
    const root = await mkRoot();
    const other = "cd".repeat(32);
    await writeTree(root, { [`.axiom/backup/${other}/stolen.txt`]: "LOOT" });
    const digest = await plant(root, `.axiom/backup/${other}/stolen.txt`);
    await expect(rollback(root, digest as `sha256:${string}`)).rejects.toMatchObject({
      code: "ERR_JOURNAL_CORRUPT",
    });
    const r = await fsApply(makeBundle([{ path: "z.txt", content: "z" }]), root);
    expect(r.status).toBe("applied");
    expect(await exists(root, "stolen.txt")).toBe(false);
    expect(await readText(root, `.axiom/backup/${other}/stolen.txt`)).toBe("LOOT");
  });

  it("a step whose path is under .AXIOM/ is ERR_JOURNAL_CORRUPT", async () => {
    const root = await mkRoot();
    const hex = "ef".repeat(32);
    const j = {
      manifestDigest: `sha256:${hex}`,
      phase: "committing",
      steps: [{ path: ".AXIOM/lock", op: "create", done: true }],
      startedAt: new Date().toISOString(),
      pid: 1,
    };
    await writeTree(root, { [`.axiom/journal/${hex}.json`]: JSON.stringify(j) });
    expect(await codeOf(rollback(root, `sha256:${hex}`))).toBe("ERR_JOURNAL_CORRUPT");
    // recovery skips it too: a benign apply succeeds and nothing under .axiom/ was deleted
    const r = await fsApply(makeBundle([{ path: "ok.txt", content: "ok" }]), root);
    expect(r.status).toBe("applied");
    expect(await exists(root, `.axiom/journal/${hex}.json`)).toBe(true);
  });
});

describe("rollback semantics (rc3 P1)", () => {
  it("double rollback is a no-op and never deletes a later apply's file", async () => {
    const root = await mkRoot();
    const c = makeBundle([{ path: "x.txt", content: "A" }], { name: "ca" });
    expect((await fsApply(c, root)).status).toBe("applied");
    expect((await rollback(root, c.manifestDigest)).phase).toBe("rolled-back");
    const d = makeBundle([{ path: "x.txt", content: "B" }], { name: "cb" });
    expect((await fsApply(d, root)).status).toBe("applied");
    const again = await rollback(root, c.manifestDigest);
    expect(again.phase).toBe("rolled-back");
    expect(await readText(root, "x.txt")).toBe("B");
  });

  it("a target edited after apply → ERR_PREIMAGE_CHANGED (edit kept); force restores", async () => {
    const root = await mkRoot();
    await writeTree(root, { "y.txt": "Y0" });
    const e = makeBundle([{ path: "y.txt", op: "overwrite", content: "Y1" }]);
    expect((await fsApply(e, root)).status).toBe("applied");
    await writeTree(root, { "y.txt": "Y-human-edit" });
    expect(await codeOf(rollback(root, e.manifestDigest))).toBe("ERR_PREIMAGE_CHANGED");
    expect(await readText(root, "y.txt")).toBe("Y-human-edit");
    const j = await rollback(root, e.manifestDigest, { force: true });
    expect(j.phase).toBe("rolled-back");
    expect(await readText(root, "y.txt")).toBe("Y0");
  });

  it("a created file deleted after apply counts as drift too", async () => {
    const root = await mkRoot();
    const b = makeBundle([{ path: "n.txt", content: "n" }]);
    expect((await fsApply(b, root)).status).toBe("applied");
    await fs.rm(path.join(root, "n.txt"));
    expect(await codeOf(rollback(root, b.manifestDigest))).toBe("ERR_PREIMAGE_CHANGED");
  });

  it("a pruned backup → ERR_ROLLBACK, nothing moved (never a silent no-op)", async () => {
    const root = await mkRoot();
    for (let i = 0; i <= 4; i++) await writeTree(root, { [`f${i}.txt`]: `orig${i}` });
    const first = makeBundle([{ path: "f0.txt", op: "overwrite", content: "v1" }], { name: "m0" });
    expect((await fsApply(first, root)).status).toBe("applied");
    for (let i = 1; i <= 4; i++) {
      const b = makeBundle([{ path: `f${i}.txt`, op: "overwrite", content: `x${i}` }], {
        name: `m${i}`,
      });
      expect((await fsApply(b, root)).status).toBe("applied");
    }
    expect(await exists(root, `.axiom/backup/${first.manifestDigest.slice(7)}`)).toBe(false);
    expect(await codeOf(rollback(root, first.manifestDigest))).toBe("ERR_ROLLBACK");
    expect(await readText(root, "f0.txt")).toBe("v1");
  });

  it("rollback of an overwrite whose target was absent deletes it (like create)", async () => {
    const root = await mkRoot();
    const b = makeBundle([{ path: "a.txt", op: "overwrite", content: "A1" }]);
    expect((await fsApply(b, root)).status).toBe("applied");
    expect((await rollback(root, b.manifestDigest)).phase).toBe("rolled-back");
    expect(await exists(root, "a.txt")).toBe(false);
  });

  it("in-process rollback (TOCTOU) of an overwrite-of-absent leaves no new file", async () => {
    const root = await mkRoot();
    await writeTree(root, { "b.txt": "B0" });
    const b = makeBundle([
      { path: "a.txt", op: "overwrite", content: "A1" },
      { path: "b.txt", op: "overwrite", content: "B1" },
    ]);
    const r = await fsApply(b, root, {
      preChecks: async () => {
        await writeTree(root, { "b.txt": "B-foreign" });
        return passReport(b);
      },
    });
    expect(r.status).toBe("rolled-back");
    expect(r.error?.code).toBe("ERR_PREIMAGE_CHANGED");
    expect(await exists(root, "a.txt")).toBe(false);
    expect(await readText(root, "b.txt")).toBe("B-foreign");
  });

  it("rollback of a digest that never got a journal → ERR_NOT_FOUND", async () => {
    const root = await mkRoot();
    const b = makeBundle([{ path: "q.txt", content: "q" }]);
    expect(await codeOf(rollback(root, b.manifestDigest))).toBe("ERR_NOT_FOUND");
  });
});

describe("dry-run is read-only (rc3 P2)", () => {
  it("on a root without .axiom/ it creates no .axiom/ at all", async () => {
    const root = await mkRoot();
    await writeTree(root, { "over.txt": "v1\n" });
    const r = await apply({
      bundle: makeBundle([
        { path: "q.txt", content: "q" },
        { path: "over.txt", op: "overwrite", content: "v2\n" },
      ]),
      root,
      mode: "dry-run",
    });
    expect(r.status).toBe("applied");
    expect(r.diff).toContain("+v2");
    expect(await exists(root, ".axiom")).toBe(false);
  });
});

describe("on-disk case / normalisation collision for every op (rc3 P2)", () => {
  // skip reason: on a case-sensitive FS `Foo.ts` and `foo.ts` are distinct files by design
  it.runIf(CASE_INSENSITIVE_OS)(
    "overwrite of Foo.ts when disk has foo.ts → ERR_PATH_CASE_COLLISION kind case",
    async () => {
      const root = await mkRoot();
      await writeTree(root, { "foo.ts": "lower" });
      const r = await fsApply(
        makeBundle([{ path: "Foo.ts", op: "overwrite", content: "x" }]),
        root,
      );
      expect(r.status).toBe("failed");
      expect(r.error?.code).toBe("ERR_PATH_CASE_COLLISION");
      expect(r.error?.details?.kind).toBe("case");
      expect(await readText(root, "foo.ts")).toBe("lower");
    },
  );

  it("overwrite of an NFC name when disk has its NFD twin → kind normalization", async () => {
    const root = await mkRoot();
    const nfd = "cafe\u0301.txt";
    await fs.writeFile(path.join(root, nfd), "old");
    const r = await fsApply(
      makeBundle([{ path: "caf\u00e9.txt", op: "overwrite", content: "new" }]),
      root,
    );
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_PATH_CASE_COLLISION");
    expect(r.error?.details?.kind).toBe("normalization");
    expect(await fs.readFile(path.join(root, nfd), "utf8")).toBe("old");
  });

  it("delete of an NFC name when disk has its NFD twin is refused too", async () => {
    const root = await mkRoot();
    const nfd = "cafe\u0301.txt";
    await fs.writeFile(path.join(root, nfd), "old");
    const r = await fsApply(makeBundle([{ path: "caf\u00e9.txt", op: "delete" }]), root);
    expect(r.error?.code).toBe("ERR_PATH_CASE_COLLISION");
    expect(await fs.readFile(path.join(root, nfd), "utf8")).toBe("old");
  });
});
