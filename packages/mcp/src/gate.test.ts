import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_PROFILE,
  extractTargets,
  GATE_EXIT_ALLOW,
  GATE_EXIT_DENY,
  GateProfileSchema,
  gateMain,
  isWriteTool,
  loadGateProfile,
  normalizePayload,
  parseApplyPatch,
  readStdin,
  runGate,
} from "./gate.js";
import { tmpRepo } from "./test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const hasDist = existsSync(CLI);

const AWS_KEY = `AKIA${"ABCDEFGHIJKLMNOP"}`;

function claude(tool: string, input: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    cwd,
    tool_name: tool,
    tool_input: input,
  });
}

/** Copilot CLI: camelCase and `toolArgs` as a JSON string (verified against GitHub docs). */
function copilot(tool: string, args: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({
    sessionId: "s1",
    timestamp: 1,
    cwd,
    toolName: tool,
    toolArgs: JSON.stringify(args),
  });
}

describe("gate: payload normalisation", () => {
  it("accepts snake_case, camelCase and stringified toolArgs", () => {
    const a = normalizePayload({ tool_name: "Write", tool_input: { file_path: "a" }, cwd: "/r" });
    const b = normalizePayload({ toolName: "Write", toolInput: { filePath: "a" }, cwd: "/r" });
    const c = normalizePayload({ toolName: "Write", toolArgs: '{"path":"a"}' });
    expect(a).toStrictEqual({ toolName: "Write", cwd: "/r", input: { file_path: "a" } });
    expect(b).toStrictEqual({ toolName: "Write", cwd: "/r", input: { filePath: "a" } });
    expect(c).toStrictEqual({ toolName: "Write", cwd: undefined, input: { path: "a" } });
    expect(normalizePayload({ cwd: "/r" })).toBeUndefined();
    expect(normalizePayload("nope")).toBeUndefined();
  });

  it.each([
    ["Write", true],
    ["Edit", true],
    ["MultiEdit", true],
    ["NotebookEdit", true],
    ["create_file", true],
    ["replace_string_in_file", true],
    ["insert_edit_into_file", true],
    ["apply_patch", true],
    ["multi_replace_string_in_file", true],
    ["edit_notebook_file", true],
    ["write", true],
    ["edit", true],
    ["Read", false],
    ["read_file", false],
    ["create_directory", false],
    ["list_dir", false],
    ["Bash", false],
    ["grep_search", false],
  ])("isWriteTool(%s) = %s", (name, expected) => {
    expect(isWriteTool(name)).toBe(expected);
  });

  it("extracts Claude MultiEdit new_strings and Copilot multi_replace filePaths", () => {
    const multi = extractTargets({
      toolName: "MultiEdit",
      cwd: undefined,
      input: {
        file_path: "src/a.ts",
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "p", new_string: "q" },
        ],
      },
    });
    expect(multi).toStrictEqual([{ rawPath: "src/a.ts", op: "write", content: "y\nq" }]);
    const mr = extractTargets({
      toolName: "multi_replace_string_in_file",
      cwd: undefined,
      input: {
        replacements: [
          { filePath: "a.ts", oldString: "1", newString: "2" },
          { filePath: "b.ts", oldString: "1", newString: "3" },
          { filePath: "a.ts", oldString: "4", newString: "5" },
        ],
      },
    });
    expect(mr.map((t) => t.rawPath)).toStrictEqual(["a.ts", "b.ts"]);
    expect(mr[0]?.content).toBe("2\n5");
  });

  it("parses apply_patch headers and collects + lines as content", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/x.ts",
      "@@ fn",
      "-old",
      "+new line",
      "+second",
      "*** Add File: pnpm-lock.yaml",
      "+lockfileVersion: 9",
      "*** Delete File: old.txt",
      "*** End Patch",
    ].join("\n");
    expect(parseApplyPatch(patch)).toStrictEqual([
      { rawPath: "src/x.ts", op: "write", content: "new line\nsecond" },
      { rawPath: "pnpm-lock.yaml", op: "write", content: "lockfileVersion: 9" },
      { rawPath: "old.txt", op: "delete", content: undefined },
    ]);
  });
});

describe("gate: profile", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-gate-");
    home = await tmpRepo("axiom-gate-home-");
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  it("schema: strict object, defaults deny=[] noSecrets=true", () => {
    expect(GateProfileSchema.parse({})).toStrictEqual({ deny: [], noSecrets: true });
    expect(GateProfileSchema.safeParse({ deny: [], extra: 1 }).success).toBe(false);
    expect(GateProfileSchema.safeParse({ maxBytes: 0 }).success).toBe(false);
    expect(GateProfileSchema.safeParse(DEFAULT_GATE_PROFILE).success).toBe(true);
  });

  it("search order: --profile > <root>/.axiom > ~/.axiom > builtin", async () => {
    const builtin = await loadGateProfile({ root: repo.root, home: home.root });
    expect(builtin.source).toBe("builtin");
    expect(builtin.profile).toStrictEqual(DEFAULT_GATE_PROFILE);

    await mkdir(join(home.root, ".axiom"), { recursive: true });
    await writeFile(join(home.root, ".axiom", "gate-profile.json"), '{"deny":["home/**"]}');
    expect(
      (await loadGateProfile({ root: repo.root, home: home.root })).profile.deny,
    ).toStrictEqual(["home/**"]);

    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(join(repo.root, ".axiom", "gate-profile.json"), '{"deny":["repo/**"]}');
    expect(
      (await loadGateProfile({ root: repo.root, home: home.root })).profile.deny,
    ).toStrictEqual(["repo/**"]);

    const explicit = join(repo.root, "custom.json");
    await writeFile(explicit, '{"deny":["custom/**"],"noSecrets":false}');
    const r = await loadGateProfile({ root: repo.root, home: home.root, profilePath: explicit });
    expect(r.profile).toStrictEqual({ deny: ["custom/**"], noSecrets: false });
    expect(r.source).toBe(explicit);
  });

  it("explicit --profile that is missing or invalid is an error (not a silent fallback)", async () => {
    await expect(
      loadGateProfile({
        root: repo.root,
        home: home.root,
        profilePath: join(repo.root, "nope.json"),
      }),
    ).rejects.toThrow(/not found/);
    const bad = join(repo.root, "bad.json");
    await writeFile(bad, '{"deny":"not-an-array"}');
    await expect(
      loadGateProfile({ root: repo.root, home: home.root, profilePath: bad }),
    ).rejects.toThrow(/invalid gate profile/);
  });
});

describe("gate: decisions", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-gate-");
    home = await tmpRepo("axiom-gate-home-");
    await mkdir(join(repo.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  const opts = () => ({ home: home.root });

  it("Claude Write to an ordinary path → allow, exit 0, no stdout", async () => {
    const r = await runGate(
      claude("Write", { file_path: join(repo.root, "src", "a.ts"), content: "ok" }, repo.root),
      opts(),
    );
    expect(r.decision).toBe("allow");
    expect(r.exitCode).toBe(GATE_EXIT_ALLOW);
    expect(r.stdout).toBeUndefined();
    expect(r.stderr).toStrictEqual([]);
  });

  it("Claude Write to .env → deny path.deny with Claude JSON on stdout", async () => {
    const r = await runGate(
      claude("Write", { file_path: ".env", content: "X=1" }, repo.root),
      opts(),
    );
    expect(r.decision).toBe("deny");
    expect(r.exitCode).toBe(GATE_EXIT_DENY);
    expect(r.code).toBe("path.deny");
    expect(r.path).toBe(".env");
    expect(r.stderr[0]).toMatch(/^AXIOM GATE DENY path\.deny: .* \(\.env\)$/);
    const json = JSON.parse(r.stdout ?? "{}") as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string };
    };
    expect(json.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("Copilot create_file with an AWS key in content → deny content.noSecrets.awsKey", async () => {
    const r = await runGate(
      copilot(
        "create_file",
        { filePath: "src/cfg.ts", content: `const k = "${AWS_KEY}";` },
        repo.root,
      ),
      opts(),
    );
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("content.noSecrets.awsKey");
    expect(r.path).toBe("src/cfg.ts");
  });

  it("Copilot apply_patch touching pnpm-lock.yaml → deny path.deny", async () => {
    const patch = "*** Begin Patch\n*** Update File: pnpm-lock.yaml\n+x\n*** End Patch";
    const r = await runGate(copilot("apply_patch", { input: patch }, repo.root), opts());
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("path.deny");
    expect(r.path).toBe("pnpm-lock.yaml");
  });

  it("apply_patch with only safe files → allow", async () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n+const a = 1;\n*** End Patch";
    const r = await runGate(copilot("apply_patch", { input: patch }, repo.root), opts());
    expect(r.decision).toBe("allow");
  });

  it("..\\..\\x escapes root → deny ERR_CONTAINMENT (both casings)", async () => {
    const a = await runGate(
      claude("Write", { file_path: "..\\..\\x", content: "" }, repo.root),
      opts(),
    );
    const b = await runGate(
      copilot("create_file", { filePath: "../../x", content: "" }, repo.root),
      opts(),
    );
    expect(a.decision).toBe("deny");
    expect(a.code).toBe("ERR_CONTAINMENT");
    expect(b.code).toBe("ERR_CONTAINMENT");
  });

  it("absolute path outside root → deny ERR_CONTAINMENT", async () => {
    const r = await runGate(
      claude("Write", { file_path: join(home.root, "x.ts"), content: "" }, repo.root),
      opts(),
    );
    expect(r.code).toBe("ERR_CONTAINMENT");
  });

  it("CON.txt → deny ERR_PATH_RESERVED_NAME; NTFS ADS → ERR_PATH_INVALID_CHAR", async () => {
    const con = await runGate(
      claude("Write", { file_path: "src/CON.txt", content: "" }, repo.root),
      opts(),
    );
    expect(con.decision).toBe("deny");
    expect(con.code).toBe("ERR_PATH_RESERVED_NAME");
    const ads = await runGate(
      claude("Write", { file_path: "src/a.txt:stream", content: "" }, repo.root),
      opts(),
    );
    expect(ads.code).toBe("ERR_PATH_INVALID_CHAR");
  });

  it("unknown / read-only tool → allow without touching the filesystem", async () => {
    const r = await runGate(
      claude("Bash", { command: "rm -rf /" }, "/definitely/not/a/dir"),
      opts(),
    );
    expect(r.decision).toBe("allow");
    expect(r.exitCode).toBe(GATE_EXIT_ALLOW);
  });

  it("malformed JSON → fail open (allow) with a warn; --strict → deny ERR_INTERNAL", async () => {
    const open = await runGate("{not json", opts());
    expect(open.decision).toBe("allow");
    expect(open.exitCode).toBe(GATE_EXIT_ALLOW);
    expect(open.stderr.some((l) => l.startsWith("AXIOM GATE WARN"))).toBe(true);
    const strict = await runGate("{not json", { ...opts(), strict: true });
    expect(strict.decision).toBe("deny");
    expect(strict.exitCode).toBe(GATE_EXIT_DENY);
    expect(strict.code).toBe("ERR_INTERNAL");
  });

  it("missing payload (stdin timeout) → fail open", async () => {
    const r = await runGate(undefined, opts());
    expect(r.decision).toBe("allow");
    expect(r.stderr.some((l) => /timeout or empty/.test(l))).toBe(true);
  });

  it("profile file overrides the default (deny src/**, noSecrets off)", async () => {
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(
      join(repo.root, ".axiom", "gate-profile.json"),
      JSON.stringify({ deny: ["src/**"], noSecrets: false }),
    );
    const denied = await runGate(
      claude("Write", { file_path: "src/a.ts", content: "" }, repo.root),
      opts(),
    );
    expect(denied.code).toBe("path.deny");
    // .env is no longer in the deny list and secrets are not scanned.
    const env = await runGate(
      claude("Write", { file_path: ".env", content: AWS_KEY }, repo.root),
      opts(),
    );
    expect(env.decision).toBe("allow");
  });

  it("allow globs and maxBytes are enforced when configured", async () => {
    const prof = join(repo.root, "p.json");
    await writeFile(prof, JSON.stringify({ allow: ["src/**"], maxBytes: 4, noSecrets: false }));
    const outside = await runGate(
      claude("Write", { file_path: "README.md", content: "x" }, repo.root),
      { ...opts(), profilePath: prof },
    );
    expect(outside.code).toBe("path.allow");
    const big = await runGate(
      claude("Write", { file_path: "src/a.ts", content: "12345" }, repo.root),
      { ...opts(), profilePath: prof },
    );
    expect(big.code).toBe("content.maxBytes");
  });

  it("no cwd in payload → --root, then the cwd fallback", async () => {
    const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".env" } });
    const viaRoot = await runGate(payload, { ...opts(), root: repo.root });
    expect(viaRoot.code).toBe("path.deny");
    const viaCwd = await runGate(payload, { ...opts(), cwdFallback: () => repo.root });
    expect(viaCwd.code).toBe("path.deny");
  });

  it("gateMain: requires --stdin; reads the payload from the given stream", async () => {
    const noStdin = await gateMain([]);
    expect(noStdin.exitCode).toBe(GATE_EXIT_DENY);
    const stream = Readable.from([claude("Write", { file_path: ".env", content: "" }, repo.root)]);
    const r = await gateMain(["--stdin"], { stdin: stream, home: home.root });
    expect(r.code).toBe("path.deny");
  });

  it("readStdin: times out (fail open) and caps size", async () => {
    const never = new Readable({ read() {} });
    const t = await readStdin(never, { timeoutMs: 20 });
    expect(t).toStrictEqual({ text: undefined, timedOut: true, tooLarge: false });
    const big = Readable.from([Buffer.alloc(64), Buffer.alloc(64)]);
    const s = await readStdin(big, { maxBytes: 100 });
    expect(s.tooLarge).toBe(true);
    const r = await gateMain(["--stdin"], {
      stdin: Readable.from([Buffer.alloc(GATE_STDIN_MAX_PLUS_ONE)]),
      home: home.root,
    });
    expect(r.decision).toBe("allow");
    expect(r.stderr[0]).toMatch(/exceeded/);
  });
});

const GATE_STDIN_MAX_PLUS_ONE = 4 * 1024 * 1024 + 1;

describe("gate: latency", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-gate-lat-");
    home = await tmpRepo("axiom-gate-home-");
    await mkdir(join(repo.root, "src", "deep", "er"), { recursive: true });
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  it("200 mixed payloads: every decision is correct; p95 < 120 ms in-process", async () => {
    const cases: { text: string; expect: "allow" | "deny" }[] = [];
    for (let i = 0; i < 200; i++) {
      switch (i % 4) {
        case 0:
          cases.push({
            text: claude(
              "Write",
              { file_path: `src/deep/er/f${i}.ts`, content: "x".repeat(2000) },
              repo.root,
            ),
            expect: "allow",
          });
          break;
        case 1:
          cases.push({
            text: claude("Edit", { file_path: ".env", new_string: "" }, repo.root),
            expect: "deny",
          });
          break;
        case 2:
          cases.push({
            text: copilot("create_file", { filePath: `src/s${i}.ts`, content: AWS_KEY }, repo.root),
            expect: "deny",
          });
          break;
        default:
          cases.push({ text: claude("Read", { file_path: "x" }, repo.root), expect: "allow" });
      }
    }
    const samples: number[] = [];
    for (const c of cases) {
      const t0 = performance.now();
      const r = await runGate(c.text, { home: home.root });
      samples.push(performance.now() - t0);
      expect(r.decision).toBe(c.expect);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    // Reported even when the timing assertion is skipped on CI.
    console.error(`gate in-process latency: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    // Timing is asserted locally only; CI runners are too noisy for a hard bound.
    if (process.env.CI === undefined) expect(p95).toBeLessThan(120);
    expect(samples.length).toBe(200);
  });
});

describe.skipIf(!hasDist)("gate: dist/cli.js end-to-end", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  let home: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-gate-e2e-");
    home = await tmpRepo("axiom-gate-home-");
    await mkdir(join(repo.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await repo.cleanup();
    await home.cleanup();
  });

  interface Run {
    code: number;
    stdout: string;
    stderr: string;
  }
  function run(args: string[], stdin: string): Promise<Run> {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [CLI, "gate", "--stdin", ...args],
        { cwd: repo.root, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : ((err as { code?: number }).code ?? -1);
          resolve({ code, stdout, stderr });
        },
      );
      child.stdin?.end(stdin);
    });
  }

  it("allowed Write → exit 0, empty stdout", async () => {
    const r = await run([], claude("Write", { file_path: "src/a.ts", content: "ok" }, repo.root));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("Write to .git/config → exit 2, deny JSON on stdout, reason on stderr", async () => {
    const r = await run([], claude("Write", { file_path: ".git/config", content: "" }, repo.root));
    expect(r.code).toBe(2);
    const json = JSON.parse(r.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(json.hookSpecificOutput.permissionDecisionReason).toContain("path.deny");
    expect(r.stderr).toMatch(/^AXIOM GATE DENY path\.deny/m);
  });

  it("malformed payload → exit 0 (fail open); --strict → exit 2", async () => {
    const open = await run([], "{oops");
    expect(open.code).toBe(0);
    expect(open.stderr).toMatch(/AXIOM GATE WARN/);
    const strict = await run(["--strict"], "{oops");
    expect(strict.code).toBe(2);
  });

  it("dist/gate-lazy.js does not pull in the MCP SDK", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(join(here, "..", "dist", "gate-lazy.js"), "utf8");
    expect(src).not.toMatch(/modelcontextprotocol|StdioServerTransport|McpServer/);
  });
});
