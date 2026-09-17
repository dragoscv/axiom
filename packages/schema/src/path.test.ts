import { describe, expect, it } from "vitest";
import { isValidRelPath, RelPathSchema, relPathIssues } from "./path.js";

const cases: ReadonlyArray<readonly [string, string, string | null]> = [
  // [label, input, expected first issue code | null when valid]
  ["simple file", "a.txt", null],
  ["nested", "src/lib/index.ts", null],
  ["dotfile", ".gitignore", null],
  ["dot dir", ".github/workflows/ci.yml", null],
  ["unicode NFC", "docs/caf\u00e9.md", null],
  ["hyphen underscore", "my-pkg/some_file.v2.json", null],
  ["con as prefix is fine", "console.log", null],
  ["com0 is not reserved", "COM0", null],
  ["com10 is not reserved", "com10.txt", null],
  ["1024 chars", `${"a".repeat(1019)}/b.ts`, null],
  ["parent segment", "../x", "ERR_PATH_SEGMENT"],
  ["parent in middle", "a/../b", "ERR_PATH_SEGMENT"],
  ["dot segment", "./a", "ERR_PATH_SEGMENT"],
  ["backslash", "a\\b", "ERR_PATH_NOT_RELATIVE_POSIX"],
  ["drive letter", "C:/x", "ERR_PATH_NOT_RELATIVE_POSIX"],
  ["drive letter lower", "c:x", "ERR_PATH_NOT_RELATIVE_POSIX"],
  ["absolute", "/x", "ERR_PATH_NOT_RELATIVE_POSIX"],
  ["CON", "CON", "ERR_PATH_RESERVED_NAME"],
  ["con.txt", "con.txt", "ERR_PATH_RESERVED_NAME"],
  ["nested nul", "src/NUL", "ERR_PATH_RESERVED_NAME"],
  ["COM1", "COM1", "ERR_PATH_RESERVED_NAME"],
  ["lpt9 ext", "dir/lpt9.log", "ERR_PATH_RESERVED_NAME"],
  ["aux mixed case", "Aux.TS", "ERR_PATH_RESERVED_NAME"],
  ["trailing dot", "a.", "ERR_PATH_SEGMENT"],
  ["trailing space", "a ", "ERR_PATH_SEGMENT"],
  ["trailing dot mid-path", "a./b", "ERR_PATH_SEGMENT"],
  ["ADS colon", "a:b", "ERR_PATH_INVALID_CHAR"],
  ["angle bracket", "a<b", "ERR_PATH_INVALID_CHAR"],
  ["pipe", "a|b", "ERR_PATH_INVALID_CHAR"],
  ["question", "a?", "ERR_PATH_INVALID_CHAR"],
  ["star", "*.ts", "ERR_PATH_INVALID_CHAR"],
  ["double quote", 'a"b', "ERR_PATH_INVALID_CHAR"],
  ["C0 control", "a\u0001b", "ERR_PATH_INVALID_CHAR"],
  ["DEL", "a\u007fb", "ERR_PATH_INVALID_CHAR"],
  ["NFD string", "docs/cafe\u0301.md", "ERR_PATH_NOT_NFC"],
  ["empty segment", "a//b", "ERR_PATH_SEGMENT"],
  ["trailing slash", "a/", "ERR_PATH_SEGMENT"],
  ["empty string", "", "ERR_PATH_SEGMENT"],
  ["1025 chars", `${"a".repeat(1020)}/b.ts`, "ERR_PATH_SEGMENT"],
];

describe("RelPath", () => {
  it.each(cases)("%s: %j", (_label, input, expected) => {
    const issues = relPathIssues(input);
    const result = RelPathSchema.safeParse(input);
    if (expected === null) {
      expect(issues).toEqual([]);
      expect(isValidRelPath(input)).toBe(true);
      expect(result.success).toBe(true);
    } else {
      expect(issues).toContain(expected);
      expect(isValidRelPath(input)).toBe(false);
      expect(result.success).toBe(false);
    }
  });

  it("reports every issue, not just the first", () => {
    expect(relPathIssues("/CON.txt/..\\x")).toEqual(
      expect.arrayContaining([
        "ERR_PATH_NOT_RELATIVE_POSIX",
        "ERR_PATH_SEGMENT",
        "ERR_PATH_RESERVED_NAME",
      ]),
    );
  });

  it("schema issues carry the code in message and params", () => {
    const r = RelPathSchema.safeParse("a:b");
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain("ERR_PATH_INVALID_CHAR");
    }
  });
});
