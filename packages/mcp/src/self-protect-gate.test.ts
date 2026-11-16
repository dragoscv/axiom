/**
 * S-1410: the built-in self-protection set is enforced by the GATE, not by the profile.
 *
 * Reality check #2 showed an agent could rewrite the policy file, the hook wiring and
 * `~/.axiom/daemon.json` with one allowed write, and that warn mode relaxed whatever covered
 * them. `self-protect.ts` already carried the list; nothing consumed it, so these cases were all
 * ALLOWED. The profile here is deliberately the weakest the file format allows (no deny list,
 * no hard list, warn mode, overrides and outside writes allowed): the built-in set must hold
 * anyway.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GateResult, runGate } from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

describe("gate self-protection (S-1410)", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;

  const weakestProfile = async (): Promise<void> => {
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(
      join(repo.root, ".axiom", "gate-profile.json"),
      JSON.stringify({ mode: "warn", outside: "allow", override: true, deny: [], hard: [] }),
    );
  };
  const gate = (payload: Record<string, unknown>): Promise<GateResult> =>
    runGate(JSON.stringify({ cwd: repo.root, ...payload }), { home: home.root, format: "claude" });
  const write = (filePath: string, extra: Record<string, unknown> = {}) =>
    gate({ tool_name: "Write", tool_input: { file_path: filePath, content: "x", ...extra } });
  const bash = (command: string) => gate({ tool_name: "Bash", tool_input: { command } });

  beforeEach(async () => {
    repo = await tmpRepo("axiom-self-");
    home = await tmpRepo("axiom-self-home-");
    await mkdir(join(repo.root, ".git"));
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  it("refuses the policy file in warn mode, with and without an override reason", async () => {
    await weakestProfile();
    const plain = await write(".axiom/axiom.json");
    expect(plain.decision).toBe("deny");
    expect(plain.code).toBe("self.protect");
    const overridden = await write(".axiom/gate-profile.json", {
      explanation: "axiom-override: the operator asked me to relax this file for a moment",
    });
    expect(overridden.decision).toBe("deny");
    expect(overridden.code).toBe("self.protect");
  });

  it("refuses the hook wiring, the trust store, the pins and a planted profile", async () => {
    await weakestProfile();
    for (const p of [
      ".github/hooks/axiom-gate.json",
      ".axiom/trust/keys.json",
      ".axiom/mcp-pins.json",
      ".axiom/profiles/strict.json",
    ]) {
      const r = await write(p);
      expect([p, r.decision, r.code]).toEqual([p, "deny", "self.protect"]);
    }
  });

  it("asks before touching harness configuration AXIOM shares with other tools", async () => {
    await weakestProfile();
    const r = await write(".claude/settings.json");
    expect(r.verdict).toBe("ask");
    expect(r.code).toBe("self.harnessConfig");
    expect(r.decision).toBe("deny");
  });

  it("protects ~/.axiom even where `outside` allows writes outside the root", async () => {
    await weakestProfile();
    const abs = join(home.root, ".axiom", "daemon.json").replace(/\\/g, "/");
    const r = await gate({ tool_name: "Write", tool_input: { file_path: abs, content: "{}" } });
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("self.protect");
  });

  it("a recursive delete of the home directory, the root or .git is a hard treeDelete", async () => {
    await weakestProfile();
    const homeAbs = home.root.replace(/\\/g, "/");
    const homeDelete = await bash(`rm -rf ${homeAbs}`);
    expect(homeDelete.decision).toBe("deny");
    expect(homeDelete.code).toBe("self.treeDelete");
    expect(homeDelete.path).toBe(homeAbs);
    const gitDelete = await bash("rm -rf .git");
    expect(gitDelete.decision).toBe("deny");
    expect(gitDelete.code).toBe("self.treeDelete");
    expect(gitDelete.path).toBe(".git");
  });

  it("still allows an ordinary write under the same weakest profile", async () => {
    await weakestProfile();
    const r = await write("src/ok.ts");
    expect(r.decision).toBe("allow");
    const shell = await bash("rm -rf src/build");
    expect(shell.decision).toBe("allow");
  });
});
