import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDecision,
  DECISIONS_FILE,
  type DecisionRecord,
  hashArgs,
  principalSubject,
  readDecisions,
} from "./decisions.js";
import { tmpRepo } from "./test-helpers.js";

const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  v: 1,
  decided_at: "2026-10-14T10:00:00.000Z",
  agent_id: "claude:s1",
  principal: { subject: "dev" },
  tool: "Write",
  ...hashArgs({ file_path: "a.ts" }),
  decision: "allow",
  paths: ["a.ts"],
  profile: "builtin",
  ...over,
});

describe("decisions journal", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-decisions-");
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("hashArgs = sha256 of the JCS form; non-canonicalizable → unavailable + hash of ''", () => {
    expect(hashArgs({ b: 1, a: "x" })).toStrictEqual({
      args_hash: `sha256:${sha256Hex('{"a":"x","b":1}')}`,
      args_state: "recorded",
    });
    expect(hashArgs({ n: 1e21 }).args_hash).toBe(`sha256:${sha256Hex(canonicalize({ n: 1e21 }))}`);
    expect(hashArgs({ n: Number.NaN })).toStrictEqual({
      args_hash: `sha256:${sha256Hex("")}`,
      args_state: "unavailable",
    });
  });

  it("appendDecision creates .axiom/ and writes one JSON line per record; readDecisions round-trips", async () => {
    await appendDecision(repo.root, rec());
    await appendDecision(repo.root, rec({ decision: "deny", code: "path.deny", reason: "r" }));
    const text = await readFile(join(repo.root, DECISIONS_FILE), "utf8");
    expect(text.split("\n")).toHaveLength(3);
    const all = await readDecisions(repo.root);
    expect(all).toStrictEqual([rec(), rec({ decision: "deny", code: "path.deny", reason: "r" })]);
  });

  it("readDecisions skips malformed lines and filters by since", async () => {
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await appendDecision(repo.root, rec({ decided_at: "2026-10-13T00:00:00.000Z" }));
    await appendFile(join(repo.root, DECISIONS_FILE), '{oops\n{"v":2}\n\n');
    await appendDecision(repo.root, rec({ decided_at: "2026-10-15T00:00:00.000Z" }));
    expect(await readDecisions(repo.root)).toHaveLength(2);
    const since = await readDecisions(repo.root, { since: "2026-10-14T00:00:00Z" });
    expect(since.map((r) => r.decided_at)).toStrictEqual(["2026-10-15T00:00:00.000Z"]);
  });

  it("missing journal → []; principalSubject is a non-empty string", async () => {
    expect(await readDecisions(repo.root)).toStrictEqual([]);
    expect(principalSubject().length).toBeGreaterThan(0);
  });
});
