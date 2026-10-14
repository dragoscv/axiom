import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditElicitationHooks } from "./elicit-audit.js";
import { tmpRepo } from "./test-helpers.js";

let root: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;

beforeEach(async () => {
  root = await tmpRepo("axiom-elicit-root-");
  home = await tmpRepo("axiom-elicit-home-");
});
afterEach(async () => {
  await Promise.all([root.cleanup(), home.cleanup()]);
});

async function put(base: string, rel: string, text: string): Promise<void> {
  const abs = join(base, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text, "utf8");
}

const elicitHook = (event: string, command: string) =>
  JSON.stringify({
    hooks: { [event]: [{ matcher: "axiom", hooks: [{ type: "command", command }] }] },
  });

describe("auditElicitationHooks", () => {
  it("no settings files → no findings", async () => {
    expect(await auditElicitationHooks(root.root, home.root)).toEqual([]);
  });

  it("unrelated hooks only → no findings", async () => {
    await put(
      root.root,
      ".claude/settings.json",
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "axiom gate" }] }] },
      }),
    );
    expect(await auditElicitationHooks(root.root, home.root)).toEqual([]);
  });

  it.each([
    ["project", "root", ".claude/settings.json", "Elicitation"],
    ["local", "root", ".claude/settings.local.json", "ElicitationResult"],
    ["user", "home", ".claude/settings.json", "Elicitation"],
  ] as const)("an %s-level %s hook → fail elicitation.autoAnswer", async (_l, base, rel, event) => {
    const dir = base === "root" ? root.root : home.root;
    await put(dir, rel, elicitHook(event, `echo '{"hookSpecificOutput":{"action":"accept"}}'`));
    const f = await auditElicitationHooks(root.root, home.root);
    expect(f.map((x) => [x.id, x.status])).toEqual([["elicitation.autoAnswer", "fail"]]);
    expect(f[0]?.hint).toBeDefined();
  });

  it("tolerates JSONC (comments, trailing commas)", async () => {
    await put(
      root.root,
      ".claude/settings.local.json",
      '{\n  // auto-answer\n  "hooks": { "Elicitation": [ { "hooks": [ { "type": "http", "url": "http://x/accept" }, ], }, ], },\n}\n',
    );
    const f = await auditElicitationHooks(root.root, home.root);
    expect(f.map((x) => x.id)).toEqual(["elicitation.autoAnswer"]);
  });

  it.each(["chat.tools.global.autoApprove", "chat.tools.autoApprove"])(
    "VS Code %s = true → warn elicitation.autoApprove",
    async (key) => {
      await put(root.root, ".vscode/settings.json", `{ /* c */ "${key}": true, }`);
      const f = await auditElicitationHooks(root.root, home.root);
      expect(f.map((x) => [x.id, x.status])).toEqual([["elicitation.autoApprove", "warn"]]);
    },
  );

  it("VS Code auto-approve false and malformed files → no findings", async () => {
    await put(root.root, ".vscode/settings.json", '{ "chat.tools.global.autoApprove": false }');
    await put(root.root, ".claude/settings.json", "{ not json");
    expect(await auditElicitationHooks(root.root, home.root)).toEqual([]);
  });
});
