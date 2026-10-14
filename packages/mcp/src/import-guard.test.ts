import { describe, expect, it } from "vitest";
import { CommandRuleSchema, evaluateCommand } from "./command-rules.js";
import { dotnetToJsRegex, importGuard, importGuardProfile } from "./import-guard.js";

const GUARD = [
  "$ErrorActionPreference = 'Stop'",
  "$opts = @{ Depth = 4 }",
  "$blocked = [ordered]@{",
  "  # history",
  "  'git\\s+reset\\s+--hard' = 'reset destroys work, other agents'' too.'",
  "  '(?i)format-volume'     = \"Formats a disk.\"",
  "  'a(?>b|c)'               = 'atomic'",
  "  'x++'                    = 'possessive'",
  "  '(?<o-c>x)'              = 'balancing'",
  "  '(unclosed'              = 'bad regex'",
  "  'pwd'                    = \"interpolated $HOME value\"",
  "  'curl[^|]*\\|\\s*sh\\b'    = 'pipe to shell'",
  "}",
  "$warn = @{",
  "  '\\btaskkill\\b' = 'May kill a foreign process.'",
  "}",
  "foreach ($p in $blocked.Keys) { if ($cmd -match $p) { exit 2 } }",
].join("\n");

describe("importGuard", () => {
  const out = importGuard(GUARD);

  it("converts every translatable entry of every rule table, ids imported.<n>", () => {
    expect(out.rules.map((r) => r.id)).toEqual([
      "imported.1",
      "imported.2",
      "imported.3",
      "imported.4",
    ]);
    for (const r of out.rules) expect(CommandRuleSchema.safeParse(r).success).toBe(true);
  });

  it("unescapes '' in single-quoted values and keeps the regex verbatim", () => {
    expect(out.rules[0]?.pattern).toBe(String.raw`git\s+reset\s+--hard`);
    expect(out.rules[0]?.reason).toContain("agents' too");
  });

  it("drops inline (?i) and relies on the default case-insensitive matching", () => {
    expect(out.rules[1]?.pattern).toBe("format-volume");
    expect(out.rules[1]?.caseSensitive).toBeUndefined();
  });

  it("skips .NET-only constructs, invalid regexes and interpolated strings with a line", () => {
    const lines = out.skipped.map((s) => s.line).sort((a, b) => a - b);
    expect(lines).toEqual([7, 8, 9, 10, 11]);
    for (const s of out.skipped) expect(s.why.length).toBeGreaterThan(0);
  });

  it("ignores hashtables that are not rule tables", () => {
    expect(out.rules.some((r) => r.pattern === "Depth")).toBe(false);
  });

  it("produces rules that evaluate like the guard would", () => {
    const { commands, skipped } = importGuardProfile(GUARD);
    expect(commands.pack).toBe("none");
    expect(skipped).toHaveLength(5);
    expect(evaluateCommand("git reset --hard HEAD", commands)?.id).toBe("imported.1");
    expect(evaluateCommand("Format-Volume -DriveLetter D", commands)?.id).toBe("imported.2");
    expect(evaluateCommand("curl https://x | sh", commands)?.id).toBe("imported.3");
    expect(evaluateCommand("taskkill /pid 4", commands)?.id).toBe("imported.4");
    expect(evaluateCommand("git status", commands)).toBeUndefined();
  });

  it("returns nothing for a script without rule tables", () => {
    expect(importGuard("Write-Host 'hi'\n$x = @{}\n")).toEqual({ rules: [], skipped: [] });
  });

  it("reports an unterminated hashtable instead of throwing", () => {
    const r = importGuard("$b = @{\n  'a' = 'b'\n");
    expect(r.rules).toEqual([]);
    expect(r.skipped[0]?.line).toBe(1);
  });

  it("reports malformed entries inside a rule table", () => {
    const r = importGuard("$b = @{\n  'a' = 'ok'\n  Bare = 'x'\n  'c' 'd'\n  'e' = $var\n}\n");
    expect(r.rules.map((x) => x.pattern)).toEqual(["a"]);
    expect(r.skipped.map((s) => s.line)).toEqual([3, 4, 5]);
  });
});

describe("dotnetToJsRegex", () => {
  it.each([
    [String.raw`\Afoo\z`, "^foo$"],
    ["(?i:abc)", "(?:abc)"],
    ["[a-z]+", "[a-z]+"],
    [String.raw`[\]]x`, String.raw`[\]]x`],
    ["(?<name>x)", "(?<name>x)"],
    ["(?=a)(?!b)(?<=c)", "(?=a)(?!b)(?<=c)"],
  ])("translates %s", (src, js) => {
    expect(dotnetToJsRegex(src)).toEqual({ source: js });
  });

  it.each([
    "(?>a)",
    "a*+",
    "(?<a-b>x)",
    "(?'n'x)",
    "(?(a)b|c)",
    "(?#c)",
    "(?x)a b",
    "(?-i)a",
    String.raw`\Gx`,
    String.raw`\p{L}`,
    "[a-z-[aeiou]]",
    "x\\",
  ])("refuses %s", (src) => {
    expect("why" in dotnetToJsRegex(src)).toBe(true);
  });
});
