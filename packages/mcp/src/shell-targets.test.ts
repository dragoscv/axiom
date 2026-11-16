import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGate } from "./gate.js";
import {
  extractShellWriteTargets,
  type GateTarget,
  type ShellScanOptions,
} from "./shell-targets.js";
import { tmpRepo } from "./test-helpers.js";

/** A fixed home so no assertion depends on the machine. */
const HOME = "C:\\Users\\agent";
const WIN: ShellScanOptions = { home: HOME, win32: true };
/** `rm -rf ${HOME}/` as text: the literal is a PowerShell variable, never interpolation here. */
const BRACE_HOME = "rm -rf $" + "{HOME}/";

const scan = (cmd: string, opts: ShellScanOptions = WIN): GateTarget[] =>
  extractShellWriteTargets(cmd, opts);
const paths = (cmd: string, opts: ShellScanOptions = WIN): string[] =>
  scan(cmd, opts).map((t) => `${t.op}:${t.rawPath}`);
const flags = (cmd: string, opts: ShellScanOptions = WIN): string[] =>
  scan(cmd, opts).map((t) => {
    const on = [
      t.recursive === true ? "r" : "",
      t.linkTo === true ? "l" : "",
      t.wholeTree === true ? "w" : "",
    ].filter((x) => x !== "");
    return `${t.op}:${t.rawPath}:${on.join("")}`;
  });
/** All payload text: never a command this test would run. */
describe("OPS-1: a backslash is a separator on Windows, never an escape", () => {
  it("keeps the segments of a PowerShell path (corpus RD186/RD185/OPS-1)", () => {
    expect(paths("Set-Content packages\\db\\.env 'X=1'")).toContain("write:packages\\db\\.env");
    expect(paths("Remove-Item -Recurse -Force .git\\hooks")).toContain("delete:.git\\hooks");
    expect(paths("Move-Item a.txt .git\\config")).toContain("write:.git\\config");
    // The bash reading (only used off Windows) must not lose the separation either.
    const posix = extractShellWriteTargets("Set-Content packages\\db\\.env 'X=1'", {
      home: HOME,
      win32: false,
    });
    expect(posix.map((t) => t.rawPath)).toContain("packages\\db\\.env");
  });

  it("still reads a command with no backslash under the Windows reading", () => {
    expect(paths('Set-Content -Path ".env" -Value "x"')).toEqual(["write:.env"]);
  });

  it("does not turn a read into a target", () => {
    expect(paths("Get-Content packages\\db\\.env")).toEqual([]);
    expect(paths("Select-String -Path .git\\config -Pattern x")).toEqual([]);
  });
});

describe("OPS-2: only the git forms set wholeTree; a bare . operand is no target", () => {
  it("gives no target for a `.` operand of cp/Copy-Item (corpus RD192/RD193)", () => {
    expect(paths("Copy-Item src\\a.ts .")).toEqual([]);
    expect(paths("cp -r src/a.ts .")).toEqual([]);
    expect(paths("Move-Item a.txt .")).toEqual([]);
    expect(paths("Set-Content -Path . -Value x")).toEqual([]);
  });

  it("gives no target for a `.` inside a nested command (field false deny, OPS-2)", () => {
    expect(paths("Add-Content $o (rg -c 'T306' . -g '!node_modules')")).toEqual([]);
  });

  it("marks the four git forms as wholeTree", () => {
    expect(flags("git clean -fd")).toEqual(["delete:.:rw"]);
    expect(flags("git reset --hard origin/dev")).toEqual(["delete:.:rw"]);
    expect(flags("git checkout -- .")).toEqual(["write:.:w"]);
    expect(flags("git restore .")).toEqual(["write:.:w"]);
  });

  it("keeps a dry run and an unstage out (corpus CL094-CL096, OK214)", () => {
    expect(paths("git clean -n")).toEqual([]);
    expect(paths("git clean --dry-run -d")).toEqual([]);
    expect(paths("git clean -nd")).toEqual([]);
    expect(paths("git restore --staged .")).toEqual([]);
  });

  it("treats a recursive delete of the tree as a recursive target", () => {
    expect(flags("rm -rf ./*")).toEqual(["delete:.:r"]);
    expect(flags("Remove-Item -Recurse -Force .")).toEqual(["delete:.:r"]);
  });
});

describe("OPS-3: home, tilde and root tokens resolve through ShellScanOptions.home", () => {
  it("expands the home forms the corpus lists (RM103-RM111, RM125-RM130)", () => {
    for (const cmd of [
      "rm -rf ~/",
      "rm -rf $HOME",
      'rm -rf "$HOME"',
      BRACE_HOME,
      "rm -r -f ~",
      "rm --recursive --force ~",
      "rm -rf tests/ patches/ ~/",
      "Remove-Item -Recurse -Force $HOME",
      "Remove-Item $HOME -Recurse -Force",
      "Remove-Item -Path $env:USERPROFILE -Recurse -Force",
      "Remove-Item -Path:$HOME -Recurse -Force",
      "Remove-Item ~ -Recurse -Force",
      "ri -r -fo $HOME",
    ]) {
      const home = scan(cmd).filter((t) => t.rawPath.replace(/[\\/]+$/, "") === HOME);
      expect(
        home.map((t) => t.op),
        cmd,
      ).toEqual(["delete"]);
    }
  });

  it("expands `~/*`, `%USERPROFILE%` and `$env:APPDATA` (RM107, OPS-1)", () => {
    expect(paths("rm -rf ~/*")).toEqual([`delete:${HOME}`]);
    expect(flags("rm -rf ~/*")).toEqual([`delete:${HOME}:r`]);
    expect(paths("Remove-Item %USERPROFILE% -Recurse -Force")).toEqual([`delete:${HOME}`]);
    expect(paths("Remove-Item -Path $env:APPDATA -Recurse -Force")).toEqual([
      `delete:${HOME}\\AppData/Roaming`,
    ]);
  });

  it("expands a home path inside a redirect and a .NET call (RD169/RD170/RD189/RM139)", () => {
    expect(paths('echo x > "$HOME/.axiom/daemon.json"')).toEqual([
      `write:${HOME}\\.axiom/daemon.json`,
    ]);
    expect(paths("echo x > ~/.axiom/gate-profile.json")).toEqual([
      `write:${HOME}\\.axiom/gate-profile.json`,
    ]);
    expect(paths("Set-Content $env:USERPROFILE\\.axiom\\daemon.json '{}'")).toEqual([
      `write:${HOME}\\.axiom\\daemon.json`,
    ]);
    expect(paths("[IO.File]::WriteAllText(\"$PWD\\.env\", 'x')")).toEqual(["write:.\\.env"]);
    expect(flags("[IO.Directory]::Delete($HOME, $true)")).toEqual([`delete:${HOME}:r`]);
    expect(flags("find ~ -delete")).toEqual([`delete:${HOME}:r`]);
  });

  it("leaves a path outside the home family as written, and an unknown variable opaque", () => {
    expect(paths("mkdir -p /tmp/scratch")).toEqual(["write:/tmp/scratch"]);
    expect(paths("rm -rf /tmp/scratch/a.txt")).toEqual(["delete:/tmp/scratch/a.txt"]);
    expect(paths("Remove-Item -Recurse -Force $env:FOO")).toEqual([]);
    expect(paths("echo x > $HOME_BACKUP/file")).toEqual([]);
    expect(paths("Get-ChildItem $HOME")).toEqual([]);
  });

  it("uses process HOME only when the caller passes none", () => {
    const none = extractShellWriteTargets("rm -rf ~/", { win32: true });
    expect(none[0]?.rawPath.replace(/[\\/]+$/, "")).toBe(
      (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/[\\/]+$/, ""),
    );
  });
});

describe("OPS-3: a created link judges its pointee", () => {
  it("marks the pointee of every link form as linkTo (p3 symlink chain)", () => {
    expect(flags("ln -s .env lnk")).toEqual(["write:.env:l"]);
    expect(flags("ln -s .env cfg.txt")).toEqual(["write:.env:l"]);
    expect(flags("cmd /c mklink lnk .env")).toEqual(["write:.env:l"]);
    expect(flags("cmd /c mklink /J j .git")).toEqual(["write:.git:l"]);
    expect(flags("mklink /H h .env")).toEqual(["write:.env:l"]);
    expect(flags("fsutil hardlink create h .env")).toEqual(["write:.env:l"]);
    expect(flags("New-Item -ItemType SymbolicLink -Path l -Target .env")).toContain("write:.env:l");
    expect(flags("New-Item -ItemType Junction -Path j -Value .git")).toContain("write:.git:l");
    expect(flags("New-Item -ItemType HardLink -Path h -Target .env")).toContain("write:.env:l");
  });

  it("does not mark an ordinary create as a link", () => {
    expect(flags("New-Item -ItemType Directory -Path build")).toEqual(["write:build:"]);
    expect(flags("ln -s src/a.ts dst")).toEqual(["write:src/a.ts:l"]); // still a pointee
    expect(scan("New-Item -ItemType Directory -Path build")[0]?.linkTo).toBeUndefined();
  });
});

describe("OPS-18: tokens that are not paths are never targets", () => {
  it("drops parameter values, git subcommands and refs", () => {
    expect(
      paths("Remove-Item tsconfig.tsbuildinfo -ErrorAction SilentlyContinue; git stash list"),
    ).toEqual(["delete:tsconfig.tsbuildinfo"]);
    expect(paths("git stash list")).toEqual([]);
    expect(paths("git checkout -q -b lane/x origin/dev")).toEqual([]);
    expect(paths("git checkout -q -b lane/x")).toEqual([]);
    expect(paths("git status && git log")).toEqual([]);
    expect(paths("rg -n 'x' .")).toEqual([]);
    expect(paths("Set-Content -Path a.txt -Value out.json -Encoding utf8")).toEqual([
      "write:a.txt",
    ]);
  });

  it("still returns the real operands of the same primitives", () => {
    expect(paths("git stash push -m wip -- docs/a.md")).toEqual(["write:docs/a.md"]);
    expect(paths("git rm cached.txt")).toEqual(["delete:cached.txt"]);
    expect(paths("git mv -f a.ts b.ts")).toEqual(["write:b.ts"]);
    expect(paths("git checkout -- a.ts b.ts")).toEqual(["write:a.ts", "write:b.ts"]);
    expect(paths("Remove-Item -LiteralPath x.txt -Force")).toEqual(["delete:x.txt"]);
  });

  it("never reports the SOURCE of a copy or move as a target (p2: `cp .env x` is a read)", () => {
    expect(paths("cp .env x")).toEqual(["write:x"]);
    expect(paths("mv .env notes.txt")).toEqual(["write:notes.txt"]);
    expect(paths("Copy-Item .env .git\\config")).toEqual(["write:.git\\config"]);
    expect(paths("Move-Item .env notes.txt")).toEqual(["write:notes.txt"]);
    expect(paths("Set-Content -Path .git\\config -Value x")).toEqual(["write:.git\\config"]);
  });
});

describe("OPS-13: a leading cd moves the operands that follow it", () => {
  it("applies cd / Set-Location / pushd and git -C to relative operands", () => {
    expect(paths("cd E:\\gh\\.wt\\codai\\task-1; Remove-Item -Recurse -Force .env")).toEqual([
      "delete:E:\\gh\\.wt\\codai\\task-1\\.env",
    ]);
    expect(paths("Set-Location sub; Set-Content .env x")).toEqual(["write:sub/.env"]);
    expect(paths("pushd apps/hub && rm -rf dist")).toEqual(["delete:apps/hub/dist"]);
    expect(paths("git -C E:\\gh\\codai rm .env")).toEqual(["delete:E:\\gh\\codai\\.env"]);
    expect(paths("git -C E:\\gh\\codai status; git -C E:\\gh\\codai rm .env")).toEqual([
      "delete:E:\\gh\\codai\\.env",
    ]);
  });

  it("records an out-of-root cd as an absolute target", () => {
    expect(paths("cd /tmp/scratch; echo hi > a.txt")).toEqual(["write:/tmp/scratch/a.txt"]);
  });

  it("leaves an absolute operand alone", () => {
    expect(paths("cd E:\\gh\\codai; rm -rf E:\\gh\\codai\\dist")).toEqual([
      "delete:E:\\gh\\codai\\dist",
    ]);
  });
});

describe("A2-8/OPS-1: Win32 name aliases, before judgement", () => {
  it("strips trailing dots and spaces per segment (A2-8 B1/B3/B4)", () => {
    expect(paths("Set-Content 'probe.'")).toEqual(["write:probe"]);
    expect(paths("Set-Content -Path '.env.'")).toEqual(["write:.env"]);
    expect(paths('cmd /c "echo x> .env."')).toEqual(["write:.env"]);
    expect(paths("Set-Content 'a. b. '")).toEqual(["write:a. b"]);
  });

  it("keeps `.` and `..` as they are", () => {
    expect(paths("rm -rf ../sibling/.")).toEqual(["delete:../sibling/."]);
    expect(paths("cp x ..")).toEqual(["write:.."]);
  });

  it("returns an 8.3-shaped operand so the gate can refuse it, and a tilde name as a path", () => {
    expect(paths("Set-Content PROGRA~1\\.env")).toEqual(["write:PROGRA~1\\.env"]);
    expect(paths("Set-Content a~1b.txt")).toEqual(["write:a~1b.txt"]);
  });
});

describe("missing primitives from the corpus", () => {
  it("knows Clear-Content / clc as a write of an empty file (RD183, A2-21)", () => {
    expect(paths("Clear-Content .env")).toEqual(["write:.env"]);
    expect(paths("clc .env")).toEqual(["write:.env"]);
    expect(paths("Clear-Content -Path a.txt")).toEqual(["write:a.txt"]);
  });

  it("knows the clobber redirect and cmd redirects (RD157, RD187)", () => {
    expect(paths("echo x >| .env")).toEqual(["write:.env"]);
    expect(paths("echo x >|.env")).toEqual(["write:.env"]);
    expect(paths('cmd /c "echo x> .env"')).toEqual(["write:.env"]);
  });

  it("knows curl/wget output (RD166)", () => {
    expect(paths("curl -o .env https://example.com")).toEqual(["write:.env"]);
    expect(paths("curl --output=.env https://example.com")).toEqual(["write:.env"]);
    expect(paths("wget -O .env https://example.com")).toEqual(["write:.env"]);
    expect(paths("curl -O https://example.com/x")).toEqual([]);
  });

  it("knows a Start-Process redirect (item 8)", () => {
    expect(paths("Start-Process -FilePath pwsh -RedirectStandardOutput out.txt")).toContain(
      "write:out.txt",
    );
    expect(paths("Start-Process -FilePath pwsh -ArgumentList 'push','-f'")).toEqual(["write:pwsh"]);
  });

  it("marks find -delete and find -exec rm as recursive (RM120/RM121)", () => {
    expect(flags("find . -delete")).toEqual(["delete:.:r"]);
    expect(flags("find build -name '*.js' -delete")).toEqual(["delete:build:r"]);
    expect(flags("find . -type f -exec rm {} +")).toEqual(["delete:.:r"]);
    expect(paths("find . -name '*.ts'")).toEqual([]);
  });

  it("never mistakes a -Value for a path (item 8)", () => {
    expect(paths("Set-Content sub\\.env x")).toEqual(["write:sub\\.env"]);
    expect(paths("Set-Content -Path a.txt -Value '.env'")).toEqual(["write:a.txt"]);
    expect(paths("Add-Content -Path out.log -Value $env:USERPROFILE")).toEqual(["write:out.log"]);
  });

  it("knows the recursive delete flags of rm and ri (RM110/RM111/RM130)", () => {
    expect(flags("rm -r -f ~")).toEqual([`delete:${HOME}:r`]);
    expect(flags("rm --recursive --force ~")).toEqual([`delete:${HOME}:r`]);
    expect(flags("ri -r -fo $HOME")).toEqual([`delete:${HOME}:r`]);
    expect(paths("rm -f x.txt")).toEqual(["delete:x.txt"]);
  });
});

/**
 * The rows above are the module contract; this block proves the same commands end to end through
 * `runGate` on a temp root with a temp HOME. Every command is TEXT in a hook payload — nothing is
 * executed. Verified against the worktree build with `-Bp mcp` + `probe.mjs` as well.
 */
describe("end to end: the gate denies/allows the corpus rows the scan owns", () => {
  const PROFILE = {
    version: 3,
    deny: [".git/**", ".env", "**/.env", "pnpm-lock.yaml"],
    mode: "enforce",
    record: false,
  };
  const payload = (cwd: string, command: string): string =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "w-f-e2e",
      cwd,
      tool_name: "Bash",
      tool_input: { command },
    });

  it("judges backslash paths, link pointees, cd, redirects and primitives", async () => {
    const root = await tmpRepo("axiom-wf-e2e-");
    const home = await tmpRepo("axiom-wf-home-");
    try {
      await mkdir(join(root.root, ".git"), { recursive: true });
      await writeFile(join(root.root, ".git", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(root.root, ".axiom"), { recursive: true });
      await writeFile(join(root.root, ".axiom", "gate-profile.json"), JSON.stringify(PROFILE));
      const judge = async (command: string): Promise<string> => {
        const r = await runGate(payload(root.root, command), { home: home.root });
        return `${r.decision}:${r.code ?? ""}`;
      };
      // OPS-1: `\` is a separator, so the deny glob sees packages/db/.env.
      expect(await judge("Set-Content packages\\db\\.env 'X=1'")).toBe("deny:path.deny");
      expect(await judge("Remove-Item -Recurse -Force .git\\hooks")).toBe("deny:path.deny");
      // OPS-2: a `.` destination is not a whole-tree command; a dry-run clean removes nothing.
      expect(await judge("Copy-Item src\\a.ts .")).toBe("allow:");
      expect(await judge("git clean -n")).toBe("allow:");
      // No command pack in this profile: the deny is the wholeTree target, not a house rule.
      expect(await judge("git clean -fd")).toBe("deny:git.destructiveTree");
      // A2-8 / item 8: Win32 name aliases and the primitives the corpus found missing.
      expect(await judge('cmd /c "echo x> .env."')).toBe("deny:path.deny");
      expect(await judge("Clear-Content .env")).toBe("deny:path.deny");
      expect(await judge("echo x >| .env")).toBe("deny:path.deny");
      // OPS-3: a link being created is judged at its pointee.
      expect(await judge("ln -s .env lnk")).toBe("deny:path.deny");
      // OPS-13: a leading `cd` moves the operands that follow it.
      expect(await judge("cd src && echo hi >> ../.env")).toBe("deny:path.deny");
      expect(await judge("cd sub; Set-Content .env x")).toBe("deny:path.deny");
      // OPS-18: a parameter value and a git subcommand word are not paths.
      expect(
        await judge(
          "Remove-Item tsconfig.tsbuildinfo -ErrorAction SilentlyContinue; git stash list",
        ),
      ).toBe("allow:");
    } finally {
      await root.cleanup();
      await home.cleanup();
    }
  });
});
