import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDecision,
  DECISIONS_FILE,
  type DecisionRecord,
  decisionId,
  hashArgs,
  journalSubject,
  principalSubject,
  readDecisions,
  redactDecision,
  redactText,
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
  const saved = { ...process.env };
  beforeEach(async () => {
    repo = await tmpRepo("axiom-decisions-");
    delete process.env.AXIOM_JOURNAL_USERNAME;
    delete process.env.AXIOM_GATE_OBSERVE;
  });
  afterEach(async () => {
    process.env = { ...saved };
    await repo.cleanup();
  });
  /** What appendDecision adds/rewrites, so round-trips compare only the caller's fields. */
  const strip = (r: DecisionRecord) => {
    const { id: _id, enforced: _e, principal: _p, ...rest } = r;
    return rest;
  };

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
    expect(all.map(strip)).toStrictEqual([
      strip(rec()),
      strip(rec({ decision: "deny", code: "path.deny", reason: "r" })),
    ]);
    expect(all.every((r) => r.enforced === true)).toBe(true);
    expect(all.every((r) => r.principal.subject === sha256Hex("dev").slice(0, 16))).toBe(true);
    expect(new Set(all.map((r) => r.id)).size).toBe(2);
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

  it("redacts secrets in command/reason/override_reason before writing", async () => {
    const gh = `ghp_${"a".repeat(36)}`;
    const aws = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const cred = ["set pass", 'word = "s3cr3t-Value-9" in scratch'].join("");
    await appendDecision(
      repo.root,
      rec({
        command: `curl -H "Authorization: token ${gh}" https://x`,
        reason: `found ${aws} in .env`,
        override_reason: cred,
        relaxed: "override",
      }),
    );
    const raw = await readFile(join(repo.root, DECISIONS_FILE), "utf8");
    expect(raw).not.toContain(gh);
    expect(raw).not.toContain(aws);
    expect(raw).not.toContain("s3cr3t-Value-9");
    const [r] = await readDecisions(repo.root);
    expect(r?.command).toBe('curl -H "Authorization: token [REDACTED:githubToken]" https://x');
    expect(r?.reason).toBe("found [REDACTED:awsKey] in .env");
    expect(r?.override_reason).toContain("[REDACTED:credentialAssignment]");
    expect(r?.override_reason?.startsWith("set ")).toBe(true);
    expect(r?.override_reason?.endsWith(" in scratch")).toBe(true);
  });

  it("redactText leaves clean text alone and redacts every span", () => {
    expect(redactText("git add -- a.ts")).toBe("git add -- a.ts");
    const x = "xox";
    expect(redactText(`${x}b-1 and ${x}p-2`)).toBe(
      "[REDACTED:slackToken]1 and [REDACTED:slackToken]2",
    );
    expect(redactText(`-----BEGIN RSA ${"PRIVATE"} KEY-----`)).toBe("[REDACTED:privateKey]");
  });

  it("principal is hashed unless AXIOM_JOURNAL_USERNAME=1", () => {
    expect(journalSubject("alice", {})).toBe(sha256Hex("alice").slice(0, 16));
    expect(journalSubject("alice", { AXIOM_JOURNAL_USERNAME: "1" })).toBe("alice");
    expect(redactDecision(rec(), { env: { AXIOM_JOURNAL_USERNAME: "1" } }).principal.subject).toBe(
      "dev",
    );
  });

  it("enforced defaults to true, false under AXIOM_GATE_OBSERVE=1, caller value wins", async () => {
    expect(redactDecision(rec(), { env: {} }).enforced).toBe(true);
    expect(redactDecision(rec(), { env: { AXIOM_GATE_OBSERVE: "1" } }).enforced).toBe(false);
    expect(
      redactDecision(rec({ enforced: true }), { env: { AXIOM_GATE_OBSERVE: "1" } }).enforced,
    ).toBe(true);
    process.env.AXIOM_GATE_OBSERVE = "1";
    await appendDecision(repo.root, rec());
    expect((await readDecisions(repo.root))[0]?.enforced).toBe(false);
  });

  it("decisionId is 26 Crockford chars and sorts by time", () => {
    const a = decisionId(1_000);
    const b = decisionId(2_000_000_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10)).toBe("00000000Z8");
    expect(a < b).toBe(true);
    expect(decisionId(5)).not.toBe(decisionId(5));
    expect(redactDecision(rec({ id: "keep" }), { env: {} }).id).toBe("keep");
  });
});
