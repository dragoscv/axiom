import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  commandUnits,
  expandNested,
  findTrailingOverride,
  normalizeGit,
  programName,
  shellWords,
  splitSegments,
  stripTrailingOverride,
  UNDECODABLE,
} from "./shell-lex.js";

const enc = (s: string): string => Buffer.from(s, "utf16le").toString("base64");

describe("splitSegments", () => {
  it("splits on ; && || | & and newlines outside quotes", () => {
    expect(splitSegments("a; b && c || d | e & f\ng\r\nh")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
  });

  it("keeps separators inside quotes and redirections intact", () => {
    expect(splitSegments(`echo "a; b && c" 'd | e'`)).toEqual([`echo "a; b && c" 'd | e'`]);
    expect(splitSegments("cmd 2>&1 > out.log")).toEqual(["cmd 2>&1 > out.log"]);
    expect(splitSegments("echo `; still one")).toContain("echo `; still one");
  });

  it("drops heredoc bodies (quoted and bare delimiters, <<-)", () => {
    expect(splitSegments("cat <<'EOF'\ngit push -f\nEOF\nls")).toEqual(["cat <<'EOF'", "ls"]);
    expect(splitSegments("cat <<EOF > x\nrm -rf /\nEOF")).toEqual(["cat <<EOF > x"]);
    expect(splitSegments("cat <<-END\n\tgit push -f\n\tEND\necho done")).toEqual([
      "cat <<-END",
      "echo done",
    ]);
  });

  it("drops PowerShell here-string bodies", () => {
    // PowerShell reading: the body is gone. bash reading: it is one quoted word (data).
    const segs = splitSegments("$x = @'\ngit push -f\n'@\nWrite-Output $x");
    expect(segs).toContain("$x = @''@");
    expect(segs).toContain("Write-Output $x");
    for (const cmd of ["$x = @'\ngit push -f\n'@", '$y = @"\ngit reset --hard\n"@']) {
      const runs = commandUnits(cmd).flatMap((u) => u.variants.map((v) => normalizeGit(v)?.sub));
      expect(
        runs.filter((s) => s !== undefined),
        cmd,
      ).toEqual([]);
    }
  });

  it("drops comments but not # inside a word or quotes", () => {
    expect(splitSegments("ls # git push -f")).toEqual(["ls"]);
    expect(splitSegments("echo a#b")).toEqual(["echo a#b"]);
    expect(splitSegments("echo '# x'")).toEqual(["echo '# x'"]);
  });
});

describe("shellWords", () => {
  it("joins quotes to adjacent text", () => {
    expect(shellWords(`git push --forc"e" -"f" '--x'y`)).toEqual([
      "git",
      "push",
      "--force",
      "-f",
      "--xy",
    ]);
  });

  it("removes PowerShell backtick escapes outside single quotes only", () => {
    expect(shellWords("git p`ush --for`ce")).toEqual(["git", "push", "--force"]);
    expect(shellWords('git "p`ush"')).toEqual(["git", "push"]);
    expect(shellWords("echo 'a`b'")).toEqual(["echo", "a`b"]);
  });

  it("strips the call operator, quotes on the program and ( / $( openers", () => {
    expect(shellWords("& 'git' push")).toEqual(["git", "push"]);
    expect(shellWords('&"C:\\Git\\git.exe" push')).toEqual(["C:\\Git\\git.exe", "push"]);
    expect(shellWords("$(git push -f)")).toEqual(["git", "push", "-f"]);
    expect(shellWords("(git status)")).toEqual(["git", "status"]);
  });

  it("decodes bash $'...' strings and stops at a comment", () => {
    expect(shellWords("git $'pu\\x73h' -f")).toEqual(["git", "push", "-f"]);
    expect(shellWords("ls -la # trailing")).toEqual(["ls", "-la"]);
  });
});

describe("programName / normalizeGit", () => {
  it("lowercases the basename and drops .exe/.cmd, skipping env and sudo prefixes", () => {
    expect(programName(["C:\\Program Files\\Git\\cmd\\GIT.EXE", "x"])).toBe("git");
    expect(programName(["/usr/bin/git"])).toBe("git");
    expect(programName(["FOO=1", "sudo", "pnpm.cmd", "i"])).toBe("pnpm");
    expect(programName([])).toBe("");
  });

  it("skips global git options and returns the subcommand and its args", () => {
    expect(normalizeGit(["git", "-C", ".", "-c", "a=b", "--no-pager", "push", "-f"])).toEqual({
      sub: "push",
      args: ["-f"],
    });
    expect(normalizeGit(["git", "--git-dir=.git", "--work-tree", "w", "-P", "Reset"])).toEqual({
      sub: "reset",
      args: [],
    });
    expect(normalizeGit(["git", "--bare", "--namespace", "n", "--paginate", "log"])?.sub).toBe(
      "log",
    );
    expect(normalizeGit(["git", "--version"])).toEqual({ sub: undefined, args: [] });
    expect(normalizeGit(["echo", "git", "push"])).toBeUndefined();
  });
});

describe("expandNested / commandUnits", () => {
  it("expands cmd /c, bash -c, sh -c, pwsh -Command and iex literals", () => {
    expect(expandNested('cmd /c "git push -f"')).toContain("git push -f");
    expect(expandNested("cmd.exe /C git status")).toContain("git status");
    expect(expandNested("bash -c 'a; b'")).toEqual(expect.arrayContaining(["a", "b"]));
    expect(expandNested("sh -ec 'git push -f'")).toContain("git push -f");
    expect(expandNested('pwsh -NoProfile -Command "git push -f"')).toContain("git push -f");
    expect(expandNested("powershell -c git push -f")).toContain("git push -f");
    expect(expandNested("iex 'git push -f'")).toContain("git push -f");
    expect(expandNested('Invoke-Expression "git push -f"')).toContain("git push -f");
  });

  it("decodes -EncodedCommand / -enc / -e as base64 UTF-16LE", () => {
    const b64 = enc("git push --force origin main");
    for (const flag of ["-EncodedCommand", "-enc", "-e", "-ec", "-encodedc"]) {
      expect(expandNested(`pwsh ${flag} ${b64}`), flag).toContain("git push --force origin main");
    }
    expect(expandNested(`powershell -NoProfile -WindowStyle Hidden -enc ${b64}`)).toContain(
      "git push --force origin main",
    );
  });

  it("returns the undecodable marker for bad base64 and for nesting past the depth", () => {
    expect(expandNested("pwsh -enc not-base64!")).toContain(UNDECODABLE);
    expect(expandNested("pwsh -enc")).toContain(UNDECODABLE);
    expect(expandNested(`pwsh -enc ${enc("git status")}`, 0)).toContain(UNDECODABLE);
    expect(expandNested(`pwsh -enc ${enc("git status")}`, 1)).not.toContain(UNDECODABLE);
  });

  it("does not expand script files or non-literal iex", () => {
    expect(expandNested("pwsh -File x.ps1")).toEqual(["pwsh -File x.ps1"]);
    expect(expandNested("bash script.sh")).toEqual(["bash script.sh"]);
    expect(expandNested("iex $cmd")).toEqual(["iex $cmd"]);
  });

  it("feeds heredoc bodies and echoed literals into a shell, but not into cat", () => {
    const fed = commandUnits("bash <<'EOF'\ngit push -f\nEOF").map((u) => u.text);
    expect(fed).toContain("git push -f");
    const notFed = commandUnits("cat <<'EOF'\ngit push -f\nEOF").map((u) => u.text);
    expect(notFed).not.toContain("git push -f");
    expect(commandUnits("echo 'git push -f' | sh").map((u) => u.text)).toContain("git push -f");
    expect(commandUnits("echo 'git push -f' | grep x").map((u) => u.text)).not.toContain(
      "git push -f",
    );
  });

  it("flags nested units and gives word variants per unit", () => {
    const units = commandUnits("bash -c 'git push -f'");
    const inner = units.find((u) => u.text === "git push -f");
    expect(inner?.nested).toBe(true);
    expect(inner?.variants).toContainEqual(["git", "push", "-f"]);
    expect(units.find((u) => u.text === "bash -c 'git push -f'")?.nested).toBe(false);
  });
});

describe("findTrailingOverride / stripTrailingOverride", () => {
  const REASON = "owner approved the release rewrite";

  it("accepts a trailing comment outside quotes with a real reason", () => {
    const cmd = `git push -f origin main # axiom-override: ${REASON}`;
    expect(findTrailingOverride(cmd)).toBe(REASON);
    expect(stripTrailingOverride(cmd)).toBe("git push -f origin main");
    expect(findTrailingOverride(`ls\ngit push -f #AXIOM-OVERRIDE:   ${REASON}  `)).toBe(REASON);
  });

  it("rejects an override inside quotes, mid-word, or followed by more commands", () => {
    expect(findTrailingOverride(`echo "# axiom-override: ${REASON}"`)).toBeUndefined();
    expect(findTrailingOverride(`echo '# axiom-override: ${REASON}'`)).toBeUndefined();
    expect(findTrailingOverride(`git push -f#axiom-override: ${REASON}`)).toBeUndefined();
    expect(findTrailingOverride(`ls # axiom-override: ${REASON}\ngit push -f`)).toBeUndefined();
    expect(findTrailingOverride(`cat <<'EOF'\n# axiom-override: ${REASON}\nEOF`)).toBeUndefined();
    const cmd = `echo "# axiom-override: ${REASON}"`;
    expect(stripTrailingOverride(cmd)).toBe(cmd);
  });

  it("rejects short or wordless reasons and reasons over 300 chars", () => {
    expect(findTrailingOverride("x # axiom-override: because")).toBeUndefined();
    expect(findTrailingOverride("x # axiom-override: ok ok ok")).toBeUndefined(); // < 12 letters
    expect(findTrailingOverride("x # axiom-override: 1234 5678 9012 3456")).toBeUndefined();
    expect(findTrailingOverride("x # axiom-override: abcdefghijklmnop qr")).toBeUndefined(); // 2 words
    expect(findTrailingOverride("x # axiom-override:")).toBeUndefined();
    expect(findTrailingOverride(`x # axiom-override: ${"word ".repeat(70)}`)).toBeUndefined();
    expect(findTrailingOverride("x # just a comment")).toBeUndefined();
  });
});

describe("robustness", () => {
  it("never throws and stays linear on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        commandUnits(s);
        findTrailingOverride(s);
        return Array.isArray(splitSegments(s)) && Array.isArray(shellWords(s));
      }),
      { numRuns: 500 },
    );
    const t0 = performance.now();
    commandUnits(`${"'a' ".repeat(5_000)}${"`".repeat(5_000)}${"<<E\n".repeat(2_000)}`);
    commandUnits(`bash -c "${"x; ".repeat(5_000)}"`);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
