import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  extractJson,
  isUnknownCommand,
  pickServerModule,
  renderDoctor,
  resolveInvocation,
  statusFromDoctor,
} from "./status.js";

const doc = (checks: { id: string; status: "ok" | "warn" | "fail" }[]) => ({
  root: "/r",
  ok: checks.every((c) => c.status !== "fail"),
  checks: checks.map((c) => ({ ...c, message: `${c.id} message` })),
});

describe("doctor JSON → status bar", () => {
  it("all ok → AXIOM ok, no background, tooltip counts checks", () => {
    const s = statusFromDoctor(
      doc([
        { id: "bin", status: "ok" },
        { id: "hook", status: "ok" },
      ]),
    );
    expect(s.level).toBe("ok");
    expect(s.text).toBe("$(shield) AXIOM ok");
    expect(s.background).toBeUndefined();
    expect(s.problems).toEqual([]);
    expect(s.tooltip).toContain("all 2 doctor checks ok");
  });

  it("any warn (no fail) → AXIOM warn with the warning ThemeColor and the warn ids", () => {
    const s = statusFromDoctor(
      doc([
        { id: "bin", status: "ok" },
        { id: "hook.vscode", status: "warn" },
        { id: "gate.latency", status: "warn" },
      ]),
    );
    expect(s.level).toBe("warn");
    expect(s.text).toBe("$(warning) AXIOM warn");
    expect(s.background).toBe("statusBarItem.warningBackground");
    expect(s.problems).toEqual(["hook.vscode", "gate.latency"]);
    expect(s.tooltip).toContain("⚠ hook.vscode");
  });

  it("any fail → AXIOM fail; failing ids listed before warnings", () => {
    const s = statusFromDoctor(
      doc([
        { id: "hook.vscode", status: "warn" },
        { id: "mcp.json", status: "fail" },
      ]),
    );
    expect(s.level).toBe("fail");
    expect(s.text).toBe("$(error) AXIOM fail");
    expect(s.background).toBe("statusBarItem.errorBackground");
    expect(s.problems).toEqual(["mcp.json", "hook.vscode"]);
    expect(s.tooltip).toMatch(/1 failing, 1 warning/);
    expect(s.tooltip).toContain("✗ mcp.json");
  });

  it("garbage / missing checks → unknown", () => {
    for (const bad of [undefined, null, "x", {}, { checks: "no" }]) {
      expect(statusFromDoctor(bad).level).toBe("unknown");
    }
    // malformed rows are ignored, not counted
    expect(statusFromDoctor({ checks: [{ id: 1, status: "fail" }] }).level).toBe("ok");
  });

  it("extractJson tolerates a banner line before the report", () => {
    expect(extractJson('axiom 3.0.0\n{"checks":[]}\n')).toEqual({ checks: [] });
    expect(extractJson("no json")).toBeUndefined();
    expect(extractJson("{broken")).toBeUndefined();
  });

  it("renderDoctor prints one line per check with hints", () => {
    const text = renderDoctor({
      root: "/r",
      checks: [{ id: "hook", status: "fail", message: "missing", hint: "axiom init" }],
    });
    expect(text).toContain("FAIL hook: missing");
    expect(text).toContain("→ axiom init");
  });
});

describe("CLI helpers", () => {
  it("isUnknownCommand recognises an older CLI rejecting `setup` / `explain`", () => {
    expect(isUnknownCommand('{"code":"ERR_USAGE","message":"unknown command setup"}')).toBe(true);
    expect(isUnknownCommand("Unknown command: explain")).toBe(true);
    expect(isUnknownCommand("ERR_CONTAINMENT")).toBe(false);
  });

  it("compareVersions is numeric", () => {
    expect(compareVersions("3.0.0", "2.7.0")).toBe(1);
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("3.0.0-rc.1", "3.0.0")).toBe(0);
    expect(compareVersions("v2.0.0", "2.0.1")).toBe(-1);
  });

  it("pickServerModule uses the workspace LSP only when trusted AND not older", () => {
    const base = { bundled: "/ext/server.cjs", bundledVersion: "3.0.0" };
    const ws = { module: "/ws/lsp-main.js", version: "3.1.0" };
    expect(pickServerModule({ ...base, trusted: true, workspace: ws }).source).toBe("workspace");
    expect(pickServerModule({ ...base, trusted: false, workspace: ws }).source).toBe("bundled");
    expect(
      pickServerModule({ ...base, trusted: true, workspace: { ...ws, version: "2.7.0" } }).source,
    ).toBe("bundled");
    expect(pickServerModule({ ...base, trusted: true }).module).toBe("/ext/server.cjs");
  });

  it("resolveInvocation: win32 prefers axiom.exe, else runs the npm .cmd shim's cli.js via node", () => {
    const bin = "C:\\npm";
    const cli = join(bin, "node_modules", "@codai", "axiom-mcp", "dist", "cli.js");
    const files = new Set([join(bin, "axiom.cmd"), cli]);
    const env = {
      platform: "win32" as const,
      path: `C:\\x;${bin}`,
      exists: (f: string) => files.has(f),
    };
    expect(resolveInvocation("axiom", env)).toEqual({ file: "node", prefix: [cli] });
    files.add(join(bin, "axiom.exe"));
    expect(resolveInvocation("axiom", env)).toEqual({ file: join(bin, "axiom.exe"), prefix: [] });
  });

  it("resolveInvocation: posix PATH lookup, explicit paths, missing → undefined", () => {
    const env = {
      platform: "linux" as const,
      path: "/usr/bin:/opt/axiom/bin",
      exists: (f: string) => f === join("/opt/axiom/bin", "axiom") || f === "/x/cli.js",
    };
    expect(resolveInvocation("", env)).toEqual({
      file: join("/opt/axiom/bin", "axiom"),
      prefix: [],
    });
    expect(resolveInvocation("/x/cli.js", env)).toEqual({ file: "node", prefix: ["/x/cli.js"] });
    expect(resolveInvocation("nope", env)).toBeUndefined();
  });
});
