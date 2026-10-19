import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGate } from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

/**
 * 3.0: when several command rules match one command, a hard code decides the verdict even if a
 * relaxable rule matched first (hard by code, never by evaluation order).
 */
describe("gate: hard verdict wins over an earlier relaxable match", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;

  beforeEach(async () => {
    repo = await tmpRepo("axiom-hf-");
    home = await tmpRepo("axiom-hf-home-");
    await mkdir(join(repo.root, ".git"));
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(
      join(repo.root, ".axiom", "gate-profile.json"),
      JSON.stringify({
        mode: "warn",
        override: true,
        record: false,
        commands: { pack: "house" },
        hard: ["house.forcePush"],
      }),
    );
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  const bash = (command: string) =>
    runGate(JSON.stringify({ cwd: repo.root, tool_name: "Bash", tool_input: { command } }), {
      home: home.root,
      format: "claude",
    });

  it("git add -A (relaxable, first) ; git push --force (hard) → deny house.forcePush", async () => {
    const r = await bash("git add -A ; git push --force origin main");
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("house.forcePush");
  });

  it("the relaxable rule alone is relaxed by warn mode (control)", async () => {
    const r = await bash("git add -A");
    expect(r.decision).toBe("allow");
  });
});
