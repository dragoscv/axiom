import { rm } from "node:fs/promises";
import type { DigestRef } from "@codai/axiom-schema";
import { afterEach, describe, expect, it } from "vitest";
import { recoverIfNeeded } from "./apply.js";
import { newJournal, readJournal, writeJournal } from "./journal.js";
import { exists, mkRoot, writeTree } from "./test-helpers.js";

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
