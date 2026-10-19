import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_DOC_MARKER,
  COMMANDS,
  checkOptions,
  commandName,
  extractNotes,
  findGroup,
  GROUPS,
  levenshtein,
  renderCliMarkdown,
  renderCommandHelp,
  renderGroupHelp,
  renderOverview,
  resolveCommand,
  suggest,
  topLevelCandidates,
} from "./cli-commands.js";

/** Printable ASCII plus tab/newline/CR only. */
const ASCII = /^[\t\n\r -~]*$/;
const here = dirname(fileURLToPath(import.meta.url));

/** Every 2.x verb and the canonical command it must reach (D-43). */
const OLD_TO_NEW: [string[], string][] = [
  [["compile"], "plan compile"],
  [["check"], "plan check"],
  [["apply"], "plan apply"],
  [["diff"], "plan diff"],
  [["verify"], "plan verify"],
  [["emitters"], "plan emitters"],
  [["log"], "journal log"],
  [["status"], "journal status"],
  [["undo"], "journal undo"],
  [["rollback"], "journal rollback"],
  [["attest"], "journal attest"],
  [["keygen"], "keys gen"],
  [["sign"], "keys sign"],
  [["trust"], "keys trust"],
  [["gate"], "hook gate"],
  [["init"], "setup init"],
  [["doctor"], "setup doctor"],
  [["stats"], "setup stats"],
  [["migrate"], "setup migrate"],
  [["import-guard"], "setup import-guard"],
  [["snapshot-diff"], "snapshot diff"],
  [["mcp"], "mcp"],
  [["serve"], "serve"],
  [["snapshot"], "snapshot"],
  [["gc"], "gc"],
  [["schema"], "schema"],
];

describe("command table", () => {
  it("every entry has a summary, a usage starting with its own name and at least one example", () => {
    for (const c of COMMANDS) {
      const name = commandName(c);
      expect(c.summary.length, name).toBeGreaterThan(5);
      expect(c.usage.startsWith(`axiom ${name}`), name).toBe(true);
      expect(c.examples.length, name).toBeGreaterThan(0);
      for (const o of c.options)
        expect(o.description.length, `${name} --${o.name}`).toBeGreaterThan(3);
    }
  });

  it("canonical paths and aliases are unique across the table", () => {
    const names = COMMANDS.flatMap((c) => [c.path, ...(c.aliases ?? [])].map((p) => p.join(" ")));
    expect(new Set(names).size).toBe(names.length);
  });

  it("every option name is unique within its command", () => {
    for (const c of COMMANDS) {
      const longs = c.options.map((o) => o.name);
      expect(new Set(longs).size, commandName(c)).toBe(longs.length);
    }
  });

  it("every 2.x verb resolves to the same handler as its new name", () => {
    for (const [old, name] of OLD_TO_NEW) {
      const viaOld = resolveCommand([...old, "x"]);
      const viaNew = resolveCommand([...name.split(" "), "x"]);
      expect(viaOld?.cmd, old.join(" ")).toBeDefined();
      expect(viaOld?.cmd, old.join(" ")).toBe(viaNew?.cmd);
      expect(commandName(viaOld?.cmd ?? COMMANDS[0]!), old.join(" ")).toBe(name);
      expect(viaOld?.cmd.run, old.join(" ")).toBe(viaNew?.cmd.run);
      expect(viaOld?.rest).toEqual(["x"]);
    }
  });

  it("longest match wins: `snapshot diff` over `snapshot`, `gate` stays a passthrough", () => {
    expect(commandName(resolveCommand(["snapshot", "diff", "a", "b"])!.cmd)).toBe("snapshot diff");
    expect(commandName(resolveCommand(["snapshot", "--root", "."])!.cmd)).toBe("snapshot");
    const gate = resolveCommand(["gate", "--stdin", "--format", "claude"])!;
    expect(gate.cmd.passthrough).toBe(true);
    expect(gate.rest).toEqual(["--stdin", "--format", "claude"]);
  });

  it("unknown words resolve to nothing", () => {
    expect(resolveCommand(["frobnicate"])).toBeUndefined();
    expect(resolveCommand(["plan"])).toBeUndefined();
    expect(resolveCommand(["plan", "nope"])).toBeUndefined();
  });

  it("every group has at least one command", () => {
    for (const g of GROUPS)
      expect(
        COMMANDS.some((c) => c.path[0] === g.name),
        g.name,
      ).toBe(true);
  });
});

describe("option pre-validation", () => {
  const apply = resolveCommand(["plan", "apply"])!.cmd;
  it("accepts known flags, positionals, --x=v and -o short forms", () => {
    expect(checkOptions(apply, ["b.json", "--root", ".", "--dry-run"])).toBeUndefined();
    expect(checkOptions(apply, ["b.json", "--root=.", "--lock-timeout=5"])).toBeUndefined();
    const compile = resolveCommand(["compile"])!.cmd;
    expect(checkOptions(compile, ["p.json", "-o", "out.json"])).toBeUndefined();
    expect(checkOptions(apply, ["b.json", "--", "--whatever"])).toBeUndefined();
  });
  it("rejects an unknown flag with a did-you-mean", () => {
    expect(checkOptions(apply, ["b.json", "--dryrun"])).toMatch(
      /unknown option '--dryrun'.*'--dry-run'/,
    );
    expect(checkOptions(apply, ["b.json", "--zzzzzz"])).not.toMatch(/did you mean/);
  });
  it("rejects a string flag without a value", () => {
    expect(checkOptions(apply, ["b.json", "--root"])).toMatch(/--root/);
  });
});

describe("did you mean", () => {
  it("levenshtein basics", () => {
    expect(levenshtein("apply", "apply")).toBe(0);
    expect(levenshtein("aply", "apply")).toBe(1);
    expect(levenshtein("comple", "compile")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("suggests within distance 2, never beyond", () => {
    expect(suggest("aply", topLevelCandidates())).toContain("plan apply");
    expect(suggest("jurnal", topLevelCandidates())).toContain("journal");
    expect(suggest("frobnicate", topLevelCandidates())).toEqual([]);
  });
});

describe("help", () => {
  it("overview is grouped, at most 40 lines and pure ASCII", () => {
    const text = renderOverview("3.0.0");
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
    expect(text).toMatch(ASCII);
    for (const g of GROUPS) expect(text).toContain(`  ${g.name}`);
  });

  it("per-command help is ASCII and carries only its own usage", () => {
    for (const c of COMMANDS) {
      const text = renderCommandHelp(c);
      const name = commandName(c);
      expect(text, name).toMatch(ASCII);
      expect(text, name).toContain("Usage:");
      expect(text, name).toContain("Examples:");
      for (const other of COMMANDS) {
        if (other === c) continue;
        // No other command's usage line may appear (prefix-safe: compare whole usage lines).
        for (const line of other.usage.split("\n")) {
          if (!c.usage.includes(line))
            expect(text, `${name} contains ${commandName(other)}`).not.toContain(line);
        }
      }
    }
  });

  it("per-command help lists defaults", () => {
    const text = renderCommandHelp(resolveCommand(["plan", "apply"])!.cmd);
    expect(text).toContain("(default: 30000)");
    expect(text).toContain("old name: axiom apply");
  });

  it("group help lists exactly that group's commands", () => {
    const text = renderGroupHelp(findGroup("keys")!);
    expect(text).toMatch(ASCII);
    expect(text).toContain("axiom keys gen");
    expect(text).toContain("axiom keys sign");
    expect(text).not.toContain("axiom plan");
  });
});

describe("docs/reference/cli.md", () => {
  it("human output strings in cli-main.ts, cli-commands.ts and stats.ts are pure ASCII", async () => {
    for (const f of ["cli-main.ts", "cli-commands.ts", "stats.ts"]) {
      const code = (await readFile(join(here, f), "utf8"))
        .split("\n")
        .map((l, i) => [i + 1, l] as const)
        // comments may use any character; code (and therefore every string) may not
        .filter(([, l]) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
      for (const [n, l] of code) expect(l, `${f}:${n}`).toMatch(ASCII);
    }
  });

  it("generated markdown keeps notes blocks and mentions every command", () => {
    const notes = new Map([["plan apply", "Two-phase commit."]]);
    const md = renderCliMarkdown(notes);
    for (const c of COMMANDS) expect(md).toContain(`\`axiom ${commandName(c)}\``);
    expect(extractNotes(md).get("plan apply")).toBe("Two-phase commit.");
    expect(md).toContain("`gate`"); // the old verb in the command map
  });

  it("the committed page has the marker and is not stale", async () => {
    const doc = (
      await readFile(join(here, "..", "..", "..", "docs", "reference", "cli.md"), "utf8")
    ).replaceAll("\r\n", "\n");
    const at = doc.indexOf(CLI_DOC_MARKER);
    expect(at).toBeGreaterThan(0);
    const expected = `${doc.slice(0, at + CLI_DOC_MARKER.length)}\n\n${renderCliMarkdown(extractNotes(doc.slice(at)))}`;
    expect(doc).toBe(expected);
  });
});
