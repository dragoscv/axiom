#!/usr/bin/env node
/**
 * check-sdk-adapter — the MCP SDK is reached through ONE seam (S-405, v2-architecture §5.4):
 * under `packages/mcp/src`, only `adapter.ts` may import `@modelcontextprotocol/*` at runtime.
 * Test files (`*.test.ts`, `test-helpers.ts`) may import the `@modelcontextprotocol/client`
 * package (devDependency) — they drive the server as a peer, they do not build it.
 *
 * Also asserts the eager CLI bundle carries no SDK code: `dist/cli-main.js` must reach the SDK
 * only through `import("./mcp-lazy.js")` / `import("./http-lazy.js")`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lineOf, REPO_ROOT, readText, rel, report, walk } from "./_guard-lib.mjs";

const SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](@modelcontextprotocol\/[^"']+)["']/g;
const SRC = join(REPO_ROOT, "packages", "mcp", "src");

const problems = [];
let files = 0;
for (const file of walk(SRC, (r) => /\.(ts|mts|cts)$/.test(r))) {
  files++;
  const r = rel(file).replace(/\\/g, "/");
  const isAdapter = r.endsWith("/src/adapter.ts");
  const isTest = /\.test\.ts$/.test(r) || r.endsWith("/src/test-helpers.ts");
  const src = readText(file);
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1];
    if (isAdapter) continue;
    if (isTest && spec.startsWith("@modelcontextprotocol/client")) continue;
    problems.push(
      `${rel(file)}:${lineOf(src, m.index)}: imports "${spec}" — only src/adapter.ts may import the SDK (tests: @modelcontextprotocol/client only)`,
    );
  }
}

const cliMain = join(REPO_ROOT, "packages", "mcp", "dist", "cli-main.js");
const notes = [`${files} files scanned`];
if (existsSync(cliMain)) {
  const js = readText(cliMain);
  // Bundled SDK code carries these literals; the eager chunk must have none of them.
  for (const marker of ["server/discover", "Mcp-Protocol-Version", "@modelcontextprotocol/"]) {
    if (js.includes(marker)) {
      problems.push(
        `packages/mcp/dist/cli-main.js contains SDK marker "${marker}" — the SDK must stay in mcp-lazy/http-lazy`,
      );
    }
  }
  notes.push("dist/cli-main.js free of SDK markers");
} else {
  notes.push("dist absent: bundle check skipped (run pnpm build)");
}

report("sdk-adapter", problems, { notes, stats: { files } });
