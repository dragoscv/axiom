/**
 * Reality-check 2026-10-19 regressions (S-1301..S-1303, S-1307, S-1313): every case here was
 * ALLOWED by the published 2.7.0 gate under an enforce profile.
 */
import { mkdir, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDecisions } from "./decisions.js";
import {
  findOverrideReason,
  type GateResult,
  isOverrideReason,
  loadGateProfileForRoot,
  runGate,
} from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

const HARD = [
  "house.forcePush",
  "house.resetHard",
  "house.cleanForce",
  "house.worktreeRemoveForce",
];
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

describe("gate hardening (reality check 2026-10-19)", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;

  const writeProfile = async (p: Record<string, unknown>, root = repo.root) => {
    await mkdir(join(root, ".axiom"), { recursive: true });
    await writeFile(join(root, ".axiom", "gate-profile.json"), JSON.stringify(p));
  };
  const enforce = (extra: Record<string, unknown> = {}) =>
    writeProfile({
      deny: [".env", "**/.env", ".git/**", ".axiom/**", "secrets/**"],
      mode: "enforce",
      outside: "deny",
      override: true,
      record: true,
      commands: { pack: "house" },
      hard: HARD,
      ...extra,
    });
  const gate = (payload: Record<string, unknown>, failOpen = false): Promise<GateResult> =>
    runGate(JSON.stringify({ cwd: repo.root, ...payload }), {
      home: home.root,
      format: "claude",
      ...(failOpen ? { failOpen: true } : {}),
    });
  const bash = (command: string, extra: Record<string, unknown> = {}) =>
    gate({ tool_name: "Bash", tool_input: { command, ...extra } });
  const write = (file_path: string, extra: Record<string, unknown> = {}) =>
    gate({ tool_name: "Write", tool_input: { file_path, content: "x", ...extra } });

  beforeEach(async () => {
    repo = await tmpRepo("axiom-gh-");
    home = await tmpRepo("axiom-gh-home-");
    await mkdir(join(repo.root, ".git"));
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  describe("shell scan", () => {
    it("a newline separates commands", async () => {
      await enforce();
      const r = await bash("echo ok\nrm .env");
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("path.deny");
    });

    it.each([
      ["git push -uf origin main", "house.forcePush"],
      ["git push origin +main", "house.forcePush"],
      ["git -C . push --force", "house.forcePush"],
      ["git -c x=y push --force origin main", "house.forcePush"],
      ["git push --mirror", "house.forcePush"],
    ])("%s → %s", async (cmd, code) => {
      await enforce();
      const r = await bash(cmd);
      expect(r.decision).toBe("deny");
      expect(r.code).toBe(code);
    });

    it("git -C . checkout -- .env targets .env, not the -C value", async () => {
      await enforce();
      const r = await bash("git -C . checkout -- .env");
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("path.deny");
    });

    it("PowerShell aliases and -Path:value are scanned", async () => {
      await enforce();
      for (const cmd of ["ri .env", "sc .env x", "Remove-Item -Path:.env"]) {
        const r = await bash(cmd);
        expect(r.code, cmd).toBe("path.deny");
      }
    });

    it("commands nested in cmd /c are scanned", async () => {
      await enforce();
      const r = await bash('cmd /c "del .env"');
      expect(r.code).toBe("path.deny");
    });
  });

  describe("hard codes are matched by code, not by rule order", () => {
    it("worktree remove --force with an override stays denied (hard)", async () => {
      await enforce();
      const r = await bash(
        "git worktree remove --force x # axiom-override: cleanup after the merge is done",
      );
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("house.worktreeRemoveForce");
    });

    it("reset HEAD --hard in warn mode stays denied (hard)", async () => {
      await enforce({ mode: "warn" });
      const r = await bash("git reset HEAD --hard");
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("house.resetHard");
    });

    it("git clean -d -f with outside: allow is not mistaken for an outside write", async () => {
      await enforce({ outside: "allow" });
      const r = await bash("git clean -d -f");
      expect(r.decision).toBe("deny");
    });

    it("the whole-tree deny carries git.destructiveTree and is hard when reset/clean are", async () => {
      await enforce({ mode: "warn", commands: undefined });
      const r = await bash("git rm -r --cached . ; git clean -fdx");
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("git.destructiveTree");
    });
  });

  describe("override grammar (D-44)", () => {
    it("is not read from a quoted string inside the command", async () => {
      await enforce();
      const r = await bash("echo 'axiom-override: aaaaaaaaaa bbbbbb cccccc' > .env");
      expect(r.decision).toBe("deny");
    });

    it("is not read from a heredoc body", async () => {
      await enforce();
      const r = await bash(
        "cat > .env <<'EOF'\n# axiom-override: heredoc body text here please\nEOF",
      );
      expect(r.decision).toBe("deny");
    });

    it("is not read from an apply_patch body", async () => {
      await enforce();
      const patch =
        "*** Begin Patch\n*** Add File: .env\n+# axiom-override: content of the file says so\n*** End Patch";
      const r = await gate({ tool_name: "apply_patch", tool_input: { command: patch } });
      expect(r.decision).toBe("deny");
    });

    it("a trailing comment outside quotes with a real reason relaxes a non-hard deny", async () => {
      await enforce();
      const r = await bash("echo x > .env # axiom-override: owner asked to reset the env file");
      expect(r.decision).toBe("allow");
    });

    it("an explanation field with a real reason relaxes a non-hard deny and is journaled", async () => {
      await enforce({ record: false });
      const r = await write(".env", {
        explanation: "axiom-override: owner approved writing the local env file",
      });
      expect(r.decision).toBe("allow");
      const lines = await readDecisions(repo.root);
      expect(lines.at(-1)?.relaxed).toBe("override");
    });

    it.each(["........", "ok ok ok", "fix", "do it now"])("rejects the reason %j", (reason) => {
      expect(isOverrideReason(reason)).toBe(false);
      expect(findOverrideReason({ explanation: `axiom-override: ${reason}` })).toBeUndefined();
    });

    it("never reads the command key unless it is the shell command", () => {
      expect(
        findOverrideReason({ command: "x # axiom-override: a long enough real reason" }),
      ).toBeUndefined();
    });
  });

  describe("paths", () => {
    it.runIf(CASE_INSENSITIVE)("globs are case-insensitive on this filesystem", async () => {
      await enforce();
      for (const p of [".ENV", ".GIT/config", "SECRETS/x.txt"]) {
        const r = await write(p);
        expect(r.decision, p).toBe("deny");
      }
    });

    it.runIf(process.platform === "win32")("8.3 short-name segments are refused", async () => {
      await enforce();
      const r = await write("VERYLO~1/x.txt");
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("ERR_PATH_SEGMENT");
    });
  });

  describe("profiles (S-1307)", () => {
    it("unknown keys are ignored with a warning, deny still applies", async () => {
      await enforce({ someFutureKey: { x: 1 } });
      const r = await write(".env");
      expect(r.decision).toBe("deny");
      expect(r.stderr.join("\n")).toContain("someFutureKey");
    });

    it("a profile version newer than this binary denies with ERR_PROFILE_VERSION, even with --fail-open", async () => {
      await enforce({ version: 99 });
      const r = await gate({ tool_name: "Write", tool_input: { file_path: "a.txt" } }, true);
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("ERR_PROFILE_VERSION");
    });

    it("broken JSON denies with ERR_INVALID_PROFILE, even with --fail-open", async () => {
      await mkdir(join(repo.root, ".axiom"), { recursive: true });
      await writeFile(join(repo.root, ".axiom", "gate-profile.json"), "{ not json");
      const r = await gate({ tool_name: "Write", tool_input: { file_path: "a.txt" } }, true);
      expect(r.decision).toBe("deny");
      expect(r.code).toBe("ERR_INVALID_PROFILE");
    });

    it("a linked worktree without its own profile inherits the main clone's", async () => {
      await enforce();
      const slot = await tmpRepo("axiom-gh-slot-");
      try {
        const gitdir = join(repo.root, ".git", "worktrees", "s1");
        await mkdir(gitdir, { recursive: true });
        await writeFile(join(slot.root, ".git"), `gitdir: ${gitdir}\n`);
        await writeFile(join(gitdir, "gitdir"), `${join(slot.root, ".git")}\n`);
        await writeFile(join(gitdir, "commondir"), "../..\n");
        const loaded = await loadGateProfileForRoot(slot.root, { home: home.root });
        // The main clone's file (compare realpaths: CI temp dirs are 8.3 / symlinked).
        expect(await realpath(loaded.source)).toBe(
          await realpath(join(repo.root, ".axiom", "gate-profile.json")),
        );
        // An older own profile is also superseded by the main clone's newer one.
        await writeProfile({ deny: [] }, slot.root);
        const old = new Date(Date.now() - 3_600_000);
        await utimes(join(slot.root, ".axiom", "gate-profile.json"), old, old);
        const again = await loadGateProfileForRoot(slot.root, { home: home.root });
        expect(again.profile.deny).toContain(".env");
      } finally {
        await slot.cleanup();
      }
    });
  });

  describe("stdin", () => {
    it("an empty payload is allowed with a warning (harness hiccup, not an action)", async () => {
      const r = await runGate(undefined, { home: home.root });
      expect(r.decision).toBe("allow");
      expect(r.stderr.join("\n")).toContain("no payload");
    });

    it("unparseable JSON stays fail-closed and never echoes the payload", async () => {
      const r = await runGate("ghp_SECRETSECRETSECRET not json", { home: home.root });
      expect(r.decision).toBe("deny");
      expect(JSON.stringify(r)).not.toContain("ghp_SECRET");
    });
  });

  it("init's default profile denies force push out of the box", async () => {
    const { GATE_PROFILE } = await import("./init.js");
    await writeProfile(GATE_PROFILE as Record<string, unknown>);
    const r = await bash("git push --force origin main");
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("house.forcePush");
    expect(
      JSON.parse(await readFile(join(repo.root, ".axiom", "gate-profile.json"), "utf8")).version,
    ).toBe(3);
  });
});
