import { spawn } from "node:child_process";
import fs, { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "@codai/axiom-canon";
import type { DigestRef, Journal } from "@codai/axiom-schema";
import { afterEach, describe, expect, it } from "vitest";
import { apply, recoverIfNeeded } from "./apply.js";
import { newJournal, readJournal, writeJournal } from "./journal.js";
import {
  exists,
  makeBundle,
  mkRoot,
  readText,
  type SpecFile,
  snapshot,
  writeTree,
} from "./test-helpers.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const r = await mkRoot();
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const DIGEST: DigestRef = `sha256:${"7a".repeat(32)}`;

describe("recoverIfNeeded (§4.2 crash recovery)", () => {
  it("rolls back a journal a crashed process left in committing (done create step removed)", async () => {
    const r = await root();
    // The process died after renaming `made.txt` into place and fsyncing the journal.
    await writeTree(r, { "made.txt": "half-applied" });
    await writeJournal(r, {
      ...newJournal(DIGEST, [{ path: "made.txt", op: "create", done: true }]),
      phase: "committing",
    });
    const recovered = await recoverIfNeeded(r);
    expect(recovered).toEqual([DIGEST]);
    expect(await exists(r, "made.txt")).toBe(false);
    expect((await readJournal(r, DIGEST))?.phase).toBe("rolled-back");
  });

  it("leaves a committed journal's files alone and reports nothing recovered", async () => {
    const r = await root();
    await writeTree(r, { "kept.txt": "applied" });
    await writeJournal(r, {
      ...newJournal(DIGEST, [{ path: "kept.txt", op: "create", done: true }]),
      phase: "committed",
    });
    expect(await recoverIfNeeded(r)).toEqual([]);
    expect(await exists(r, "kept.txt")).toBe(true);
  });
});

describe("A1-1: the backup path is derived, never read from the journal", () => {
  it("restores a pre-image whose step was never flushed (killed between backup and journal write)", async () => {
    const r = await root();
    const digest: DigestRef = `sha256:${"ab".repeat(32)}`;
    const before = "ORIGINAL\n";
    const after = "NEW\n";
    await writeTree(r, {
      "a-over.txt": after,
      [`.axiom/backup/${digest.slice(7)}/a-over.txt`]: before,
    });
    await writeJournal(r, {
      ...newJournal(digest, [
        {
          path: "a-over.txt",
          op: "overwrite",
          preImage: sha256Hex(before),
          postImage: sha256Hex(after),
          // The crash landed between the backup and the journal flush: nothing was recorded.
          done: false,
        },
      ]),
      phase: "committing",
    });
    expect(await recoverIfNeeded(r)).toEqual([digest]);
    expect(await readText(r, "a-over.txt")).toBe("ORIGINAL\n");
    expect((await readJournal(r, digest))?.phase).toBe("rolled-back");
    expect(await exists(r, `.axiom/backup/${digest.slice(7)}`)).toBe(false);
  });

  it("restores a delete whose step was never flushed too", async () => {
    const r = await root();
    const digest: DigestRef = `sha256:${"cd".repeat(32)}`;
    const rel = "b-del.txt";
    await writeTree(r, { [`.axiom/backup/${digest.slice(7)}/${rel}`]: "GONE SOON\n" });
    await writeJournal(r, {
      ...newJournal(digest, [
        {
          path: rel,
          op: "delete",
          preImage: sha256Hex("GONE SOON\n"),
          done: false,
        },
      ]),
      phase: "committing",
    });
    expect(await recoverIfNeeded(r)).toEqual([digest]);
    expect(await readText(r, rel)).toBe("GONE SOON\n");
  });

  it("a lost backup is ERR_ROLLBACK and the surviving backups are NOT deleted", async () => {
    const r = await root();
    const digest: DigestRef = `sha256:${"ef".repeat(32)}`;
    await writeTree(r, {
      "keep.txt": "NEW",
      "lost.txt": "NEW2",
      [`.axiom/backup/${digest.slice(7)}/keep.txt`]: "ORIG",
    });
    await writeJournal(r, {
      ...newJournal(digest, [
        {
          path: "keep.txt",
          op: "overwrite",
          preImage: sha256Hex("ORIG"),
          postImage: sha256Hex("NEW"),
          done: true,
        },
        {
          path: "lost.txt",
          op: "overwrite",
          preImage: sha256Hex("ORIG2"),
          postImage: sha256Hex("NEW2"),
          done: true,
        },
      ]),
      phase: "committing",
    });
    await expect(recoverIfNeeded(r)).rejects.toMatchObject({
      code: "ERR_ROLLBACK",
      path: "lost.txt",
      details: expect.objectContaining({ reason: "unrestored" }),
    });
    // Nothing moved, and the backup set is still there for a human.
    expect(await readText(r, "keep.txt")).toBe("NEW");
    expect(await readText(r, `.axiom/backup/${digest.slice(7)}/keep.txt`)).toBe("ORIG");
  });
});

describe("A1-19: recovery rebuilds the applied marker of a committed journal", () => {
  it("a committed journal with no marker becomes a noop on re-apply", async () => {
    const r = await root();
    const content = "n\n";
    await writeTree(r, { "n.txt": content });
    const bundle = makeBundle([{ path: "n.txt", content }]);
    const j: Journal = {
      ...newJournal(bundle.manifestDigest, [
        {
          path: "n.txt",
          op: "create",
          preImage: "absent",
          postImage: sha256Hex(content),
          done: true,
        },
      ]),
      phase: "committed",
    };
    await writeJournal(r, j);
    const marker = `.axiom/applied/${bundle.manifestDigest.slice(7)}.json`;
    expect(await exists(r, marker)).toBe(false);
    expect(await recoverIfNeeded(r)).toEqual([]);
    expect(await exists(r, marker)).toBe(true);
    const r2 = await apply({
      bundle,
      root: r,
      mode: "fs",
      confirmDigest: bundle.manifestDigest,
    });
    expect(r2.status).toBe("noop");
  });
});

/**
 * A1-1 / QA-1: the in-process fault injection in `apply.test.ts` survives a crash because the
 * in-memory `steps` array is still there. This one kills a REAL child process mid-commit with
 * SIGKILL and then asks whether anything was lost.
 */
const CRASH_DRIVER = `
const fs = await import("node:fs");
const { apply } = await import(process.env.AXIOM_APPLY_MODULE);
const root = process.env.AXIOM_CRASH_ROOT;
const bundle = JSON.parse(fs.readFileSync(process.env.AXIOM_CRASH_BUNDLE, "utf8"));
const journal = root + "/.axiom/journal/" + bundle.manifestDigest.slice(7) + ".json";
const timer = setInterval(() => {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(journal, "utf8"));
  } catch {
    return;
  }
  const done = j.steps.filter((s) => s.done).length;
  if (j.phase === "committing" && done >= 32) {
    clearInterval(timer);
    process.kill(process.pid, "SIGKILL");
  }
}, 1);
await apply({ bundle, root, mode: "fs", confirmDigest: bundle.manifestDigest });
clearInterval(timer);
process.exit(0);
`;

async function repoRootWithTsx(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.resolve(here, "..", "..", ".."), process.cwd()]) {
    const cli = path.join(c, "node_modules", "tsx", "dist", "cli.mjs");
    if (
      await fs.lstat(cli).then(
        () => true,
        () => false,
      )
    )
      return c;
  }
  throw new Error(`tsx not found for the crash driver (looked from ${here} and ${process.cwd()})`);
}

describe("A1-1 crash matrix (a real child process killed mid-commit)", () => {
  it("SIGKILL between two steps of a 96-file commit loses nothing", async () => {
    const r = await root();
    const n = 96;
    const pre: Record<string, string> = {};
    const files: SpecFile[] = [];
    for (let i = 0; i < n; i++) {
      const name = `f${String(i).padStart(3, "0")}.txt`;
      pre[name] = `OLD ${i}\n`;
      files.push({ path: name, content: `NEW ${i}\n`, op: "overwrite" });
    }
    await writeTree(r, pre);
    const before = await snapshot(r);
    const bundle = makeBundle(files, { name: "crash" });

    const repo = await repoRootWithTsx();
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "axiom-crash-"));
    const bundleFile = path.join(tmp, "bundle.json");
    const driverFile = path.join(tmp, "driver.mjs");
    await fs.writeFile(bundleFile, JSON.stringify(bundle));
    await fs.writeFile(driverFile, CRASH_DRIVER, "utf8");

    const child = spawn(
      process.execPath,
      [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), driverFile],
      {
        cwd: repo,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          AXIOM_CRASH_ROOT: r,
          AXIOM_CRASH_BUNDLE: bundleFile,
          AXIOM_APPLY_MODULE: pathToFileURL(path.join(repo, "packages", "apply", "src", "apply.ts"))
            .href,
        },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += String(b);
    });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await rm(tmp, { recursive: true, force: true });

    const journalFile = path.join(r, ".axiom", "journal", `${bundle.manifestDigest.slice(7)}.json`);
    const midFlight = JSON.parse(await fs.readFile(journalFile, "utf8")) as {
      phase: string;
      steps: { done: boolean }[];
    };
    // Non-vacuity: the kill really landed inside the commit (a child that finished would leave a
    // `committed` journal and recovery would report nothing).
    expect(midFlight.phase, stderr).toBe("committing");

    expect(await recoverIfNeeded(r), stderr).toEqual([bundle.manifestDigest]);
    expect(await snapshot(r), stderr).toEqual(before);
    expect((await readJournal(r, bundle.manifestDigest))?.phase).toBe("rolled-back");
    expect(await exists(r, `.axiom/backup/${bundle.manifestDigest.slice(7)}`)).toBe(false);
    expect(await exists(r, `.axiom/staging/${bundle.manifestDigest.slice(7)}`)).toBe(false);
    // The killed holder's lock is still there (heartbeat fresh): a later apply reclaims it after
    // the stale window, so drop it by hand the way an operator would have to.
    await rm(path.join(r, ".axiom", "lock"), { force: true });
    const again = await apply({
      bundle,
      root: r,
      mode: "fs",
      confirmDigest: bundle.manifestDigest,
    });
    expect(again.status, stderr).toBe("applied");
    expect(await readText(r, "f000.txt")).toBe("NEW 0\n");
  });
});
