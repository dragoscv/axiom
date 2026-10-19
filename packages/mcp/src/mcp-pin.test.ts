import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPins, diffPins, MCP_PINS_FILE, pinMain, serverShape } from "./mcp-pin.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-pin-");
  home = await tmpRepo("axiom-pin-home-");
});
afterEach(async () => {
  await repo.cleanup();
  await home.cleanup();
});

async function put(file: string, value: unknown | string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), home: home.root },
  };
}

const VSCODE = `{
  // JSONC with a comment and a trailing comma
  "servers": {
    "axiom": { "command": "axiom", "args": ["mcp", "--root", "."], "env": { "B": "secret-b", "A": "x" } },
    "remote": { "url": "https://example.test/mcp", },
  },
}`;

describe("axiom pin", () => {
  it("pins command/args/url/env KEYS only; env values never reach the pin file", async () => {
    await put(join(repo.root, ".vscode", "mcp.json"), VSCODE);
    await put(join(home.root, ".copilot", "mcp-config.json"), {
      mcpServers: { brivio: { command: "node", args: ["x.js"] } },
    });
    const { servers, sources, errors } = await collectPins(repo.root, home.root);
    expect(errors).toEqual([]);
    expect(sources).toEqual([".vscode/mcp.json", "~/.copilot/mcp-config.json"]);
    expect(servers.map((s) => s.key)).toEqual([
      ".vscode/mcp.json#axiom",
      ".vscode/mcp.json#remote",
      "~/.copilot/mcp-config.json#brivio",
    ]);
    const shape = { command: "axiom", args: ["mcp", "--root", "."], envKeys: ["A", "B"] };
    expect(servers[0]?.shape).toEqual(shape);
    expect(servers[0]?.pin).toBe(`sha256:${sha256Hex(canonicalize(shape))}`);
    const a = io();
    expect(await pinMain(["--root", repo.root], a.io)).toBe(0);
    const file = await readFile(join(repo.root, MCP_PINS_FILE), "utf8");
    expect(file).not.toContain("secret-b");
    expect(JSON.parse(file).v).toBe(1);
    expect(a.out[0]).toContain("3 server(s) from 2 config(s)");
  });

  it("--check: unchanged exit 0; changed env key / added / removed servers exit 1", async () => {
    await put(join(repo.root, ".vscode", "mcp.json"), VSCODE);
    await put(join(repo.root, ".mcp.json"), { mcpServers: { gone: { command: "g" } } });
    expect(await pinMain(["--root", repo.root], io().io)).toBe(0);
    const same = io();
    expect(await pinMain(["--root", repo.root, "--check"], same.io)).toBe(0);
    expect(same.out[0]).toContain("match the pins");
    // env value change alone does NOT change the pin
    await put(join(repo.root, ".vscode", "mcp.json"), VSCODE.replace("secret-b", "rotated"));
    expect(await pinMain(["--root", repo.root, "--check"], io().io)).toBe(0);
    await put(
      join(repo.root, ".vscode", "mcp.json"),
      VSCODE.replace('"A": "x"', '"A": "x", "NODE_OPTIONS": "--require evil"'),
    );
    await put(join(repo.root, ".cursor", "mcp.json"), { mcpServers: { extra: { command: "e" } } });
    await put(join(repo.root, ".mcp.json"), { mcpServers: {} });
    const c = io();
    expect(await pinMain(["--root", repo.root, "--check", "--json"], c.io)).toBe(1);
    expect(JSON.parse(c.out.join("\n"))).toEqual({
      ok: false,
      added: [".cursor/mcp.json#extra"],
      removed: [".mcp.json#gone"],
      changed: [".vscode/mcp.json#axiom"],
    });
  });

  it("--check without pins → 1; malformed config reported; usage error → 2", async () => {
    const n = io();
    expect(await pinMain(["--root", repo.root, "--check"], n.io)).toBe(1);
    expect(n.err[0]).toContain("run `axiom pin` first");
    await put(join(repo.root, ".mcp.json"), "{ nope");
    const m = io();
    expect(await pinMain(["--root", repo.root], m.io)).toBe(1);
    expect(m.err).toEqual(["axiom pin: .mcp.json: not valid JSON"]);
    expect(await pinMain(["--bogus"], io().io)).toBe(2);
  });

  it("serverShape and diffPins are pure", () => {
    expect(
      serverShape({ command: "c", args: [1, "b"], env: { Z: 1, A: 2 }, type: "stdio" }),
    ).toEqual({ command: "c", args: ["1", "b"], envKeys: ["A", "Z"] });
    const p = (pin: string) => ({ source: "s", name: "n", pin });
    expect(
      diffPins(
        { v: 1, servers: { a: p("1"), b: p("2") } },
        { v: 1, servers: { b: p("3"), c: p("4") } },
      ),
    ).toEqual({ added: ["c"], removed: ["a"], changed: ["b"] });
  });
});
