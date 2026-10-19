import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDecision, type DecisionRecord, hashArgs } from "./decisions.js";
import { buildReport, esc, renderReportHtml, reportMain } from "./report.js";
import { tmpRepo } from "./test-helpers.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const H = 3_600_000;

const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
  v: 1,
  decided_at: new Date(NOW - H).toISOString(),
  agent_id: "claude:s1",
  principal: { subject: "dev" },
  tool: "Write",
  ...hashArgs({}),
  decision: "allow",
  paths: ["a.ts"],
  profile: "builtin",
  ...over,
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), now: () => NOW },
  };
}

describe("axiom report", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-report-");
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("buildReport aggregates totals, days, codes, relaxed and top paths inside the window", () => {
    const records = [
      rec({ ms: 10 }),
      rec({ decision: "deny", code: "path.deny", paths: [".env"], ms: 30 }),
      rec({ decision: "deny", code: "path.deny", paths: [".env"], agent_id: "copilot:x" }),
      rec({
        decision: "ask",
        code: "sessions.budget",
        decided_at: new Date(NOW - 30 * H).toISOString(),
      }),
      rec({ relaxed: "override", code: "command.deny", override_reason: "scratch dir" }),
      rec({ decided_at: new Date(NOW - 9 * 24 * H).toISOString() }), // outside 7 days
    ];
    const d = buildReport(records, { root: "/r", days: 7, now: NOW });
    expect(d.totals).toMatchObject({ total: 5, allow: 2, deny: 2, ask: 1, relaxed: 1, p50: 10 });
    expect(d.byDay).toHaveLength(8);
    expect(d.byDay.at(-1)).toEqual({ day: "2026-10-19", allow: 2, deny: 2, ask: 0 });
    expect(d.byDay.at(-2)).toEqual({ day: "2026-10-18", allow: 0, deny: 0, ask: 1 });
    expect(d.byCode[0]).toEqual({ code: "path.deny", count: 2 });
    expect(d.byHarness).toEqual([
      { harness: "claude", count: 4 },
      { harness: "copilot", count: 1 },
    ]);
    expect(d.relaxed).toEqual([
      expect.objectContaining({ kind: "override", code: "command.deny", reason: "scratch dir" }),
    ]);
    expect(d.topPaths[0]).toEqual({ path: "a.ts", count: 3, deny: 0 });
    expect(d.topPaths[1]).toEqual({ path: ".env", count: 2, deny: 2 });
  });

  it("renders one self-contained HTML document: no external refs, escaped, dark mode, redacted reasons", () => {
    const gh = `ghp_${"b".repeat(36)}`;
    const d = buildReport(
      [
        rec({ relaxed: "warn", code: "x", reason: `leaked ${gh}`, paths: ["<script>.ts"] }),
        rec({ decision: "deny", code: "path.deny" }),
      ],
      { root: "/r", days: 7, now: NOW },
    );
    const html = renderReportHtml(d);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('<svg role="img"');
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;.ts");
    expect(html).not.toContain(gh);
    expect(html).toContain("[REDACTED:githubToken]");
    expect([...html].every((ch) => ch === "\n" || (ch >= " " && ch <= "~"))).toBe(true);
    expect(esc(`a"b'<&>`)).toBe("a&quot;b&#39;&lt;&amp;&gt;");
  });

  it("reportMain writes --out, --json prints data; usage errors exit 2", async () => {
    await appendDecision(repo.root, rec({}));
    const a = io();
    const out = join(repo.root, "out", "report.html");
    expect(await reportMain(["--root", repo.root, "--out", out], a.io)).toBe(0);
    expect(a.out[0]).toContain("1 decision(s) in 7 day(s)");
    expect(await readFile(out, "utf8")).toContain("AXIOM gate report");
    const b = io();
    expect(await reportMain(["--root", repo.root, "--json", "--days", "2"], b.io)).toBe(0);
    expect(JSON.parse(b.out.join("\n")).days).toBe(2);
    for (const bad of [["--root", repo.root], ["--days", "0", "--json"], ["--nope"]]) {
      const c = io();
      expect(await reportMain(bad, c.io)).toBe(2);
      expect(c.err.length).toBe(1);
    }
    const missing = io();
    expect(await reportMain(["--root", join(repo.root, "nope"), "--json"], missing.io)).toBe(1);
  });
});
