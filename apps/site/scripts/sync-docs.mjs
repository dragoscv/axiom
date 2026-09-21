#!/usr/bin/env node
/**
 * sync-docs — copy `docs/**` (except `archive/`) into `src/content/docs/`, inject Starlight
 * frontmatter, rewrite relative `.md` links to site routes, and emit the static extras
 * (brand assets, favicon, og.png, llms.txt, llms-full.txt, install.sh, install.ps1).
 *
 * Deterministic: the same `docs/` tree always produces byte-identical output. Runs before
 * `astro dev` / `astro build` (see package.json scripts).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(SITE_ROOT, "..", "..");
const DOCS_SRC = join(REPO_ROOT, "docs");
const BRAND_SRC = join(REPO_ROOT, "assets", "brand");
const CONTENT_OUT = join(SITE_ROOT, "src", "content", "docs");
const PUBLIC_OUT = join(SITE_ROOT, "public");
const ASSETS_OUT = join(SITE_ROOT, "src", "assets");

const SITE_URL = "https://dragoscv.github.io";
const BASE = "/axiom";
const REPO_URL = "https://github.com/dragoscv/axiom";
const EXCLUDE_DIRS = new Set(["archive"]);
const LANDING = "index.mdx"; // hand-written, never touched by this script

/** Explicit sidebar order per directory. Anything not listed sorts after, alphabetically. */
const ORDER = {
  "getting-started": ["install", "quickstart", "hooks"],
  concepts: ["pipeline", "invariants", "trust-model", "cas"],
  guides: ["apply", "checks", "signing", "verify-tree", "snapshot", "emitters", "migrate"],
  reference: [
    "cli",
    "mcp-tools",
    "plan-format",
    "profiles",
    "error-codes",
    "axm-syntax",
    "versioning",
  ],
  integration: ["harnesses", "github-action", "vscode", "codai", "brivio", "metu"],
  design: ["v2-architecture", "decisions"],
  research: [], // dated files — sorted by name (= by date)
};
/** Section order for llms.txt / llms-full.txt. */
const SECTION_ORDER = [
  "",
  "getting-started",
  "concepts",
  "guides",
  "reference",
  "integration",
  "design",
  "research",
];
const SECTION_LABEL = {
  "": "Start here",
  "getting-started": "Getting started",
  concepts: "Concepts",
  guides: "Guides",
  reference: "Reference",
  integration: "Integrations",
  design: "Design",
  research: "Research",
};

// ---------------------------------------------------------------------------------------------
// helpers

async function walkMd(dir, rel = "") {
  const out = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
  for (const e of entries) {
    const r = rel ? posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      out.push(...(await walkMd(join(dir, e.name), r)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(r);
    }
  }
  return out;
}

/**
 * Mirror Astro's content-layer slug for one path segment (github-slugger semantics: lowercase,
 * drop punctuation such as `.`, spaces → `-`). `2026-09-19-v2.2-roadmap` → `2026-09-19-v22-roadmap`.
 */
function slugSegment(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** docs-relative source path → site route (no base), e.g. `guides/apply.md` → `/guides/apply/`. */
function routeFor(relPath) {
  if (relPath === "README.md") return "/overview/";
  return `/${relPath.replace(/\.md$/, "").split("/").map(slugSegment).join("/")}/`;
}

function yamlString(s) {
  return JSON.stringify(s);
}

function sidebarOrder(relPath) {
  const dir = posix.dirname(relPath);
  const slug = posix.basename(relPath, ".md");
  const list = ORDER[dir] ?? [];
  const i = list.indexOf(slug);
  return i === -1 ? 100 : i + 1;
}

/**
 * Rewrite one markdown link target found in `srcRel` (docs-relative path of the file).
 * Returns the new target or the original when it must be left alone.
 */
function rewriteTarget(target, srcRel) {
  if (/^(https?:|mailto:|#)/i.test(target)) return target;
  const [pathPart, hash = ""] = target.split("#", 2);
  if (!pathPart) return target;
  // Only markdown files are rewritten; images, yml, ts etc. are left alone (Starlight
  // treats them as relative links, which the validator is told to ignore).
  if (!/\.md$/i.test(pathPart)) return target;

  const srcDir = posix.dirname(srcRel); // "" for README.md → "."
  const resolved = posix.normalize(posix.join(srcDir === "." ? "" : srcDir, pathPart));

  if (resolved.startsWith("../")) {
    // Escapes docs/ → point at GitHub blob view of the repo file.
    const repoRel = posix.normalize(posix.join("docs", resolved));
    return `${REPO_URL}/blob/main/${repoRel}${hash ? `#${hash}` : ""}`;
  }
  if (resolved.split("/")[0] === "archive") {
    return `${REPO_URL}/blob/main/docs/${resolved}${hash ? `#${hash}` : ""}`;
  }
  if (!existsSync(join(DOCS_SRC, resolved))) {
    // Dangling relative link inside docs/ (e.g. v1 paths quoted in research notes) — keep it
    // resolvable as a GitHub link rather than a 404 on the site.
    return `${REPO_URL}/blob/main/docs/${resolved}${hash ? `#${hash}` : ""}`;
  }
  const route = `${BASE}${routeFor(resolved)}`;
  return hash ? `${route}#${hash.toLowerCase()}` : route;
}

/** Rewrite `](target)` occurrences outside fenced code blocks. */
function rewriteLinks(body, srcRel) {
  const lines = body.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = line.replace(/\]\(([^)\s]+)\)/g, (m, target) => {
      const next = rewriteTarget(target, srcRel);
      return next === target ? m : `](${next})`;
    });
  }
  return lines.join("\n");
}

/** Pull H1 (title) and the optional first italic summary line out of the body. */
function extractHeader(md, relPath) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const h1 = lines[i]?.match(/^#\s+(.+?)\s*$/);
  if (!h1) throw new Error(`${relPath}: first non-empty line must be an H1`);
  // Sidebar labels and <title> are plain text — drop inline-code backticks from the H1.
  const title = h1[1].replace(/`/g, "").replace(/\s+/g, " ").trim();
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  let description;
  const italic = lines[i]?.match(/^\*([^*].*?)\*\s*$/);
  if (italic) {
    description = italic[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // strip links
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
  }
  return { title, description, body: lines.slice(i).join("\n").trimEnd() };
}

function frontmatter(fm) {
  const out = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (typeof v === "object" && v !== null) {
      out.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) out.push(`  ${k2}: ${JSON.stringify(v2)}`);
    } else out.push(`${k}: ${typeof v === "string" ? yamlString(v) : String(v)}`);
  }
  out.push("---", "");
  return out.join("\n");
}

/** Strip markdown to plain-ish text for llms-full.txt (keep code fences intact). */
function plainBody(body) {
  return body.replace(/\]\((\/axiom\/[^)]*)\)/g, (_, p) => `](${SITE_URL}${p})`);
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function writeLF(path, content) {
  await ensureDir(dirname(path));
  await writeFile(path, content.replace(/\r\n/g, "\n"), { encoding: "utf8" });
}

// ---------------------------------------------------------------------------------------------
// main

async function main() {
  // 1. reset generated content (keep the hand-written landing page)
  await ensureDir(CONTENT_OUT);
  for (const e of await readdir(CONTENT_OUT)) {
    if (e === LANDING) continue;
    await rm(join(CONTENT_OUT, e), { recursive: true, force: true });
  }

  // 2. docs → content
  const files = await walkMd(DOCS_SRC);
  const pages = [];
  for (const rel of files) {
    const raw = await readFile(join(DOCS_SRC, rel), "utf8");
    const { title, description, body } = extractHeader(raw, rel);
    const rewritten = rewriteLinks(body, rel);
    const route = routeFor(rel);
    const outRel = rel === "README.md" ? "overview.md" : rel;
    const fm = {
      title,
      description,
      editUrl: `${REPO_URL}/edit/main/docs/${rel}`,
      sidebar: rel === "README.md" ? { hidden: true } : { order: sidebarOrder(rel) },
    };
    await writeLF(join(CONTENT_OUT, outRel), `${frontmatter(fm)}\n${rewritten}\n`);
    pages.push({
      rel,
      route,
      title,
      description: description ?? "",
      body: rewritten,
      section: rel === "README.md" ? "" : posix.dirname(rel),
    });
  }

  // 3. ordering for llms.txt: section order, then explicit ORDER, then name
  pages.sort((a, b) => {
    const sa = SECTION_ORDER.indexOf(a.section);
    const sb = SECTION_ORDER.indexOf(b.section);
    if (sa !== sb) return sa - sb;
    const oa = sidebarOrder(a.rel);
    const ob = sidebarOrder(b.rel);
    if (oa !== ob) return oa - ob;
    return a.rel.localeCompare(b.rel, "en");
  });

  // 4. brand assets → public/brand, logo, favicon, og
  await ensureDir(join(PUBLIC_OUT, "brand"));
  await ensureDir(ASSETS_OUT);
  for (const f of (await readdir(BRAND_SRC)).sort()) {
    await copyFile(join(BRAND_SRC, f), join(PUBLIC_OUT, "brand", f));
  }
  await copyFile(join(BRAND_SRC, "axiom-mark.svg"), join(ASSETS_OUT, "logo.svg"));
  await copyFile(join(BRAND_SRC, "axiom-mark.svg"), join(PUBLIC_OUT, "favicon.svg"));
  await copyFile(join(BRAND_SRC, "og-image.svg"), join(PUBLIC_OUT, "og.svg"));
  await renderOg(join(BRAND_SRC, "og-image.svg"), join(PUBLIC_OUT, "og.png"));

  // 5. llms.txt / llms-full.txt
  const summary =
    "AXIOM is the transactional write gate for coding agents: an agent submits a Plan, AXIOM " +
    "compiles it to a canonical content-addressed Manifest, runs set-level checks over the whole " +
    "change set, and applies it with a hash-gated two-phase commit that leaves a journal and, " +
    "optionally, a signed attestation. One npm package (@codai/axiom-mcp) is an MCP server, a " +
    "CLI, a PreToolUse hook and a GitHub Action.";
  const llms = [
    "# AXIOM",
    "",
    `> ${summary}`,
    "",
    `Docs: ${SITE_URL}${BASE}/ · Source: ${REPO_URL}`,
    "",
    "## Docs",
    "",
  ];
  let lastSection = null;
  for (const p of pages) {
    if (p.section !== lastSection) {
      if (lastSection !== null) llms.push("");
      llms.push(`### ${SECTION_LABEL[p.section] ?? p.section}`, "");
      lastSection = p.section;
    }
    const url = `${SITE_URL}${BASE}${p.route}`;
    llms.push(`- [${p.title}](${url})${p.description ? `: ${p.description}` : ""}`);
  }
  llms.push("", "## Optional", "", `- [Full docs, one file](${SITE_URL}${BASE}/llms-full.txt)`, "");
  await writeLF(join(PUBLIC_OUT, "llms.txt"), llms.join("\n"));

  const full = [`# AXIOM — full documentation`, "", summary, "", "---", ""];
  for (const p of pages) {
    full.push(`# ${p.title}`, "", `URL: ${SITE_URL}${BASE}${p.route}`, "");
    if (p.description) full.push(`_${p.description}_`, "");
    full.push(plainBody(p.body), "", "---", "");
  }
  await writeLF(join(PUBLIC_OUT, "llms-full.txt"), full.join("\n"));

  // 6. install scripts — copied from templates/, normalised to LF, no BOM
  for (const name of ["install.sh", "install.ps1"]) {
    const src = await readFile(join(SITE_ROOT, "templates", name), "utf8");
    await writeLF(join(PUBLIC_OUT, name), src.replace(/^\uFEFF/, ""));
  }

  const digest = createHash("sha256");
  for (const p of pages) digest.update(p.rel).update(p.body);
  console.error(
    `[sync-docs] ${pages.length} pages → src/content/docs (content sha256 ${digest
      .digest("hex")
      .slice(0, 12)}); public/: brand, favicon.svg, og.{svg,png}, llms.txt, llms-full.txt, install.{sh,ps1}`,
  );
}

async function renderOg(svgPath, pngPath) {
  const { default: sharp } = await import("sharp");
  const svg = await readFile(svgPath);
  await ensureDir(dirname(pngPath));
  await sharp(svg, { density: 144 })
    .resize(1280, 640, { fit: "contain", background: "#090814" })
    .png({ compressionLevel: 9 })
    .toFile(pngPath);
}

main().catch((err) => {
  console.error(`[sync-docs] failed: ${err?.stack ?? err}`);
  process.exit(1);
});
