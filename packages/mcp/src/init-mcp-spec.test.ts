/**
 * A3-2 / DX-3 / QA-5 (P0): `axiom init` wired every MCP entry as `npx -y @codai/axiom-mcp@2`,
 * which resolves to the 2.x server — a line `SECURITY.md` calls unsupported and which cannot read
 * a 3.0+ plan or profile. Every entry `init` writes must name the major of the build that wrote
 * it, and an entry from an older init must stay recognisable so `--upgrade` can move it forward.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctor.js";
import {
  axiomMcpSpec,
  CODEX_MCP_TOML,
  CURSOR_MCP_ENTRY,
  MCP_SERVER_ENTRY,
  npxMcpArgs,
  PROJECT_MCP_ENTRY,
} from "./init.js";
import { tmpRepo } from "./test-helpers.js";
import { PACKAGE_VERSION } from "./version.js";

const MAJOR: string = PACKAGE_VERSION.split(".")[0] ?? "";

describe("init writes this build's MCP major (A3-2)", () => {
  it("derives the npm spec from a version string", () => {
    expect(axiomMcpSpec("4.1.2")).toBe("@codai/axiom-mcp@4");
    expect(axiomMcpSpec("3.0.0-rc.1")).toBe("@codai/axiom-mcp@3");
    expect(axiomMcpSpec("")).toBe("@codai/axiom-mcp");
    expect(axiomMcpSpec()).toBe(`@codai/axiom-mcp@${MAJOR}`);
  });

  it("every harness entry carries that spec, never a pinned 2.x line", () => {
    const spec = axiomMcpSpec();
    expect(MCP_SERVER_ENTRY.args).toContain(spec);
    expect(CURSOR_MCP_ENTRY.args).toContain(spec);
    expect(PROJECT_MCP_ENTRY.args).toContain(spec);
    expect(CODEX_MCP_TOML.join("\n")).toContain(`"${spec}"`);
    if (MAJOR !== "2") {
      const entries = JSON.stringify([
        MCP_SERVER_ENTRY,
        CURSOR_MCP_ENTRY,
        PROJECT_MCP_ENTRY,
        CODEX_MCP_TOML,
      ]);
      expect(JSON.stringify(entries)).not.toContain("@codai/axiom-mcp@2");
      expect(entries).not.toContain("@codai/axiom-mcp@2");
    }
  });

  it("still recognises an entry written by an older init, so --upgrade can move it", () => {
    expect(npxMcpArgs("npx", ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "."])).toEqual([
      "mcp",
      "--root",
      ".",
    ]);
    expect(npxMcpArgs("npx", ["-y", axiomMcpSpec(), "mcp", "--root", "."])).toEqual([
      "mcp",
      "--root",
      ".",
    ]);
    expect(npxMcpArgs("npx", ["-y", "@codai/axiom-mcp", "mcp"])).toEqual(["mcp"]);
    expect(npxMcpArgs("other", ["-y", "@codai/axiom-mcp@2", "mcp"])).toBeUndefined();
    expect(npxMcpArgs("npx", ["-y", "@codai/axiom-mcp@2", "serve"])).toBeUndefined();
  });
});

describe("doctor reports a stale MCP wiring (A3-2)", () => {
  it("fails an entry pinned below this build, and passes the one init writes now", async () => {
    const repo = await tmpRepo("axiom-mcpspec-");
    const home = await tmpRepo("axiom-mcpspec-home-");
    const opts = {
      root: repo.root,
      version: PACKAGE_VERSION,
      probe: async () => ({ ms: 50, exit: 0 }),
      locateBin: async () => ({ path: "/usr/bin/axiom", version: PACKAGE_VERSION }),
      home: home.root,
      hookLogs: [],
      locateNode: async () => "/usr/bin/node",
    };
    const mcpId = "mcp.vscode";
    const write = (entry: unknown) =>
      writeFile(
        join(repo.root, ".vscode", "mcp.json"),
        JSON.stringify({ servers: { axiom: entry } }),
      );
    try {
      await mkdir(join(repo.root, ".vscode"), { recursive: true });
      await write(MCP_SERVER_ENTRY);
      const good = await runDoctor(opts);
      expect(good.checks.find((c) => c.id === mcpId)?.status).toBe("ok");
      await write({
        type: "stdio",
        command: "npx",
        args: ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "."],
      });
      const stale = await runDoctor(opts);
      const c = stale.checks.find((x) => x.id === mcpId);
      expect(c?.status).toBe("fail");
      expect(c?.hint).toBe("axiom init --upgrade");
    } finally {
      await Promise.all([repo.cleanup(), home.cleanup()]);
    }
  });
});
