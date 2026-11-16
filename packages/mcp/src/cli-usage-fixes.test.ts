/**
 * DX-2 and DX-13: two documented CLI forms that failed as written.
 *
 *  - `axiom setup migrate --profile` is the upgrade path from `MIGRATION.md` / `README.md`, and
 *    `checkOptions` rejected it ("option '--profile' needs a value [<name>]") although the table
 *    declares the value optional. It also swallowed the flag that followed it.
 *  - `axiom explain -3 --json` (the shipped example) failed with `Unknown option '-3'`, because
 *    `parseArgs` cannot tell a negative-number selector from a flag.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, type CommandDef, checkOptions } from "./cli-commands.js";
import { explainMain, withNegativeSelectors } from "./explain.js";

function command(path: string): CommandDef {
  const found = COMMANDS.find((c) => c.path.join(" ") === path);
  if (found === undefined) throw new Error(`no command ${path}`);
  return found;
}

describe("cli option table (DX-2)", () => {
  const migrate = command("setup migrate");

  it("accepts a bare optional-valued option as the last argument", () => {
    expect(checkOptions(migrate, ["--profile"])).toBeUndefined();
    expect(checkOptions(migrate, ["v1", "out.json", "-o", "plan.json"])).toBeUndefined();
  });

  it("does not swallow the flag that follows an optional-valued option", () => {
    expect(checkOptions(migrate, ["--profile", "--dry-run"])).toBeUndefined();
    expect(checkOptions(migrate, ["--profile", "--root", "."])).toBeUndefined();
    // `--json` is not an option of `migrate`: it must be reported, not eaten as the profile value.
    expect(checkOptions(migrate, ["--profile", "--json"])).toContain("--json");
  });

  it("still reports a genuinely missing value", () => {
    expect(checkOptions(migrate, ["--root"])).toContain("needs a value");
    expect(checkOptions(migrate, ["--cas"])).toContain("needs a value");
  });
});

describe("explain selector (DX-13)", () => {
  it("moves a negative-number selector behind --, keeping the flags", () => {
    expect(withNegativeSelectors(["-3", "--json"])).toEqual(["--json", "--", "-3"]);
    expect(withNegativeSelectors(["--json", "-2"])).toEqual(["--json", "--", "-2"]);
    expect(withNegativeSelectors(["--root", "/r", "-1"])).toEqual(["--root", "/r", "--", "-1"]);
  });

  it("leaves an argv without a numeric selector alone, and never adds a second --", () => {
    const plain = ["last", "--json"];
    expect(withNegativeSelectors(plain)).toEqual(plain);
    expect(withNegativeSelectors(["--", "-3"])).toEqual(["--", "-3"]);
  });

  it("`explain -3` reaches the journal instead of a usage error", async () => {
    const root = await mkdtemp(join(tmpdir(), "axiom-explain-"));
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
    try {
      const code = await explainMain(["-3", "--root", root], io);
      // 1 = nothing to explain in an empty root; 2 would be the usage error DX-13 reported.
      expect(code).toBe(1);
      expect(err.join("")).not.toContain("Unknown option");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
