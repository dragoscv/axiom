import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASELINE,
  MCP_CLI,
  parseBaseline,
  type RunResult,
  runConformance,
  type ServerHandle,
  startServer,
  summarize,
} from "./run.js";

describe("parseBaseline", () => {
  it("reads the server list, ignoring comments and other sections", () => {
    const yaml = [
      "# header",
      "client:",
      "  - sse-retry",
      "server:",
      "  - a # why",
      "  # - commented-out",
      "  - b:check-1",
      "",
    ].join("\n");
    expect(parseBaseline(yaml)).toEqual(["a", "b:check-1"]);
  });

  it("the committed baseline is non-empty and every entry is a scenario or scenario:check", async () => {
    const entries = parseBaseline(await readFile(BASELINE, "utf8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(/^[a-z0-9-]+(?::[a-z0-9-]+)?$/);
    expect(new Set(entries).size).toBe(entries.length);
  });
});

// The real run needs the BUILT mcp CLI; `pnpm build` produces it. Without it, only the pure
// helpers above run (the guards run with --strict after build in CI, so a missing dist is loud there).
const built = existsSync(MCP_CLI);

describe.skipIf(!built)("conformance run against `axiom mcp --http` (built dist)", () => {
  let server: ServerHandle;
  let outDir: string;
  let result: RunResult;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "axiom-conformance-out-"));
    server = await startServer();
    result = await runConformance({ url: server.url, outDir });
    // eslint-disable-next-line no-console -- the summary is the artifact of this suite
    console.error(summarize(result));
  });
  afterAll(async () => {
    await server?.stop();
    if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
  });

  it("server advertised its URL over stderr JSON and served /health", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const res = await fetch(new URL("/health", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "axiom" });
  });

  it("has zero unexpected failures and no stale baseline entries (CLI exit 0)", () => {
    expect(result.scenarios.length).toBeGreaterThan(10);
    expect(result.unexpectedFailures).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("passes the transport-level scenarios that matter for a write gate", () => {
    const ok = (name: string) =>
      result.scenarios
        .find((s) => s.scenario === name)
        ?.checks.every((c) => c.status !== "FAILURE");
    for (const s of [
      "server-initialize",
      "ping",
      "tools-list",
      "tools-call-simple-text",
      "tools-call-error",
      "resources-list",
      "server-sse-multiple-streams",
      "dns-rebinding-protection",
    ]) {
      expect(ok(s), s).toBe(true);
    }
  });
});
