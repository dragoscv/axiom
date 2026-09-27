#!/usr/bin/env node
/**
 * check-mermaid — parse every ```mermaid block under docs/ (and the landing MDX) with the
 * SAME mermaid version the site ships, so a syntax regression fails the build instead of
 * rendering "Error rendering diagram" in the browser.
 *
 * Why: mermaid 12 (PR #6, 2026-09-27) rejected labels that 11 tolerated — `--tree` inside an
 * edge label lexes as an edge operator, `[]` inside a node label closes the shape, `@` cannot
 * start a node label. Three of nineteen diagrams broke silently; the links validator and the
 * build were green. Fix pattern: quote the label (`|"…"|`, `["…"]`) and write `--` as
 * `&#8209;&#8209;`.
 *
 * Runs in `pnpm --filter @codai/axiom-site build` (before `astro build`). Exit 1 on any error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

// mermaid touches `document`/`window` (DOMPurify hooks) at import time; give it a DOM.
const win = new Window({ url: "https://dragoscv.github.io/axiom/" });
for (const k of ["window", "document", "navigator", "DOMParser", "Element", "HTMLElement", "SVGElement", "Node", "MutationObserver"]) {
  if (!(k in globalThis)) Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
}

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = resolve(here, "..");
const repoRoot = resolve(siteDir, "..", "..");
const roots = [join(repoRoot, "docs"), join(siteDir, "src", "content", "docs", "index.mdx")];

function* walk(p) {
  const st = statSync(p);
  if (st.isFile()) {
    if (/\.(md|mdx)$/.test(p)) yield p;
    return;
  }
  for (const name of readdirSync(p)) {
    if (name === "archive" || name === "node_modules") continue;
    yield* walk(join(p, name));
  }
}

const { default: mermaid } = await import("mermaid");
const blocks = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    const re = /```mermaid[^\n]*\n([\s\S]*?)```/g;
    let m;
    let idx = 0;
    while ((m = re.exec(text)) !== null) {
      idx++;
      const line = text.slice(0, m.index).split("\n").length;
      blocks.push({ file: relative(repoRoot, file), line, idx, code: m[1] });
    }
  }
}

let failed = 0;
for (const b of blocks) {
  try {
    await mermaid.parse(b.code, { suppressErrors: false });
  } catch (err) {
    failed++;
    const msg = (err instanceof Error ? err.message : String(err)).split("\n").slice(0, 3).join(" ");
    console.error(`FAIL  ${b.file}:${b.line} (diagram #${b.idx}) — ${msg}`);
  }
}
await win.happyDOM?.close?.();
if (failed > 0) {
  console.error(`check-mermaid: ${failed}/${blocks.length} diagram(s) do not parse with mermaid ${mermaid.version ?? ""}`.trim());
  process.exit(1);
}
console.error(`OK    check-mermaid: ${blocks.length} diagram(s) parse with mermaid ${mermaid.version ?? ""}`.trim());
