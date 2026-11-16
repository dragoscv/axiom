/**
 * DX-18: `axiom setup doctor` probes the gate 5 times per run, and every one of those decisions
 * landed in `.axiom/decisions.jsonl` (10 of 13 lines in a fresh repo), which then skewed
 * `stats`, `report`, `explain last` and `suggest-profile`. The probe now asks for a dry run
 * (contract §6: the caller passes `GateOptions.dryRun`), and an INSTALLED gate older than 4.0
 * that rejects the flag still works — the probe retries without it.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import { spawnGateProbe } from "./doctor.js";
import { gateMain } from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

/** A stub that answers like the gate and records the argv it received. */
const STUB = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const OLD = __OLD__;
const args = process.argv.slice(2);
appendFileSync(join(import.meta.dirname, "args.log"), JSON.stringify(args) + "\\n");
if (OLD && args.includes("--dry-run")) {
  process.stderr.write("ERR_USAGE Unknown option '--dry-run'\\n");
  process.exit(2);
}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write('{"permissionDecision":"deny"}');
  process.exit(0);
});
`;

async function stub(kind: "new" | "old"): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `axiom-stub-${kind}-`));
  const file = join(dir, "gate.mjs");
  await writeFile(file, STUB.replace("__OLD__", kind === "old" ? "true" : "false"));
  return { file, dir };
}
const callsOf = async (file: string): Promise<string[][]> => {
  const text = await readFile(join(dirname(file), "args.log"), "utf8");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[]);
};

const payload = JSON.stringify({
  tool_name: "Write",
  tool_input: { file_path: "a.txt", content: "x" },
});

describe("gate probe (DX-18)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("asks the gate for a dry run", async () => {
    const { file, dir } = await stub("new");
    dirs.push(dir);
    const r = await spawnGateProbe([process.execPath, file])(tmpdir(), payload);
    expect(r.exit).toBe(0);
    expect(r.denied).toBe(true);
    const calls = await callsOf(file);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--dry-run");
  });

  it("retries without the flag when the installed gate does not know it", async () => {
    const { file, dir } = await stub("old");
    dirs.push(dir);
    const r = await spawnGateProbe([process.execPath, file])(tmpdir(), payload);
    expect(r.exit).toBe(0);
    const calls = await callsOf(file);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--dry-run");
    expect(calls[1]).not.toContain("--dry-run");
  });
});

describe("axiom gate --dry-run (DX-18)", () => {
  it("judges without writing a decision line, while the same call without it does write one", async () => {
    const repo = await tmpRepo("axiom-dryprobe-");
    const home = await tmpRepo("axiom-dryprobe-home-");
    try {
      await mkdir(join(repo.root, ".axiom"), { recursive: true });
      await mkdir(join(repo.root, ".git"), { recursive: true });
      await writeFile(
        join(repo.root, ".axiom", "gate-profile.json"),
        JSON.stringify({ mode: "enforce", record: true, deny: [".env"], outside: "deny" }),
      );
      const body = JSON.stringify({
        cwd: repo.root,
        tool_name: "Write",
        tool_input: { file_path: "a.txt", content: "x" },
      });
      const read = { text: body, bytes: body.length };
      const io = { read, cwdFallback: () => repo.root, home: home.root };
      const judged = await gateMain(["--stdin", "--dry-run"], io);
      expect(judged.decision).toBe("allow");
      expect(await readDecisions(repo.root)).toHaveLength(0);
      // control: the very same payload DOES journal when the flag is absent
      const recorded = await gateMain(["--stdin"], io);
      expect(recorded.decision).toBe("allow");
      expect((await readDecisions(repo.root)).length).toBeGreaterThan(0);
    } finally {
      await Promise.all([repo.cleanup(), home.cleanup()]);
    }
  });
});
