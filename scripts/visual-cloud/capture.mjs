#!/usr/bin/env node
/**
 * Visual + accessibility pass over the AXIOM docs site. Runs ON THE CLOUD VM
 * (scripts/visual-cloud/vm-run.sh), never on the workstation.
 *
 *   node capture.mjs --base <url ending in /> --out <dir>
 *
 * Writes <out>/screens/*.png, <out>/report.json, <out>/summary.md and exits 0 when every
 * capture succeeded (axe violations are reported, not fatal), 1 otherwise.
 * Depends on `playwright` and `@axe-core/playwright`, installed on the VM
 * at pinned versions by vm-run.sh — not repo dependencies.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "https://dragoscv.github.io/axiom/").replace(/\/?$/, "/");
const OUT = arg("out", "out");
const SHOTS = join(OUT, "screens");
mkdirSync(SHOTS, { recursive: true });

const PAGES = [
  "/",
  "/getting-started/quickstart/",
  "/getting-started/hooks/",
  "/concepts/pipeline/",
  "/guides/apply/",
  "/guides/undo/",
  "/reference/cli/",
  "/reference/mcp-tools/",
  "/reference/error-codes/",
  "/reference/profiles/",
  "/integration/vscode/",
  "/integration/harnesses/",
  "/this-page-does-not-exist-axiom-visual/",
];
const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "3440x1440", width: 3440, height: 1440 },
];
const THEMES = ["light", "dark"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const AXE_VIEWPORT = "1440x900";

const url = (p) => new URL(p.replace(/^\//, ""), BASE).href;
const slug = (p) => (p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/\//g, "__"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const report = {
  base: BASE,
  startedAt: new Date().toISOString(),
  axeTags: AXE_TAGS,
  axeViewport: AXE_VIEWPORT,
  screenshots: [],
  errors: [],
  pages: [],
};

/** Wait until every mermaid block on the page has rendered its SVG (no-op when there are none). */
async function waitMermaid(page) {
  const blocks = await page.locator("pre.mermaid, .mermaid").count();
  if (!blocks) return 0;
  await page
    .waitForFunction(
      () => {
        const all = [...document.querySelectorAll("pre.mermaid, div.mermaid")];
        return all.length > 0 && all.every((el) => el.querySelector("svg"));
      },
      null,
      { timeout: 10_000 },
    )
    .catch(() =>
      report.errors.push({ where: page.url(), what: "mermaid did not render within 10 s" }),
    );
  return blocks;
}

async function open(context, path) {
  const page = await context.newPage();
  const res = await page.goto(url(path), { waitUntil: "networkidle", timeout: 45_000 });
  await page.evaluate(() => document.fonts?.ready);
  const mermaid = await waitMermaid(page);
  return { page, status: res?.status() ?? 0, mermaid };
}

async function shot(page, name, fullPage = true) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(SHOTS, file), fullPage, animations: "disabled" });
  report.screenshots.push(file);
}

function newContext(browser, vp, theme) {
  return browser
    .newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: theme,
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
      isMobile: vp.width < 600,
      hasTouch: vp.width < 600,
    })
    .then(async (ctx) => {
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem("starlight-theme", t);
        } catch {
          /* storage blocked */
        }
      }, theme);
      return ctx;
    });
}

async function axe(page, path, theme, status) {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const byImpact = {};
  for (const v of r.violations) {
    const k = v.impact ?? "unknown";
    if (!byImpact[k]) byImpact[k] = [];
    byImpact[k].push({
      id: v.id,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    });
  }
  report.pages.push({ path, theme, status, violations: r.violations.length, byImpact });
  log(`axe ${theme} ${path}: ${r.violations.length} rule(s) violated`);
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await newContext(browser, vp, theme);
      for (const path of PAGES) {
        const name = `${vp.name}-${theme}-${slug(path)}`;
        try {
          const { page, status, mermaid } = await open(ctx, path);
          await shot(page, name);
          log(`shot ${name} status=${status}${mermaid ? ` mermaid=${mermaid}` : ""}`);
          if (vp.name === AXE_VIEWPORT) await axe(page, path, theme, status);
          await page.close();
        } catch (e) {
          report.errors.push({ where: name, what: String(e?.message ?? e).split("\n")[0] });
          log(`FAIL ${name}: ${String(e?.message ?? e).split("\n")[0]}`);
        }
      }
      // Search dialog (Ctrl+K) on the home page, with a query so results render.
      const sname = `${vp.name}-${theme}-search-open`;
      try {
        const { page } = await open(ctx, "/");
        await page.keyboard.press("Control+k");
        const dialog = page.locator("site-search dialog[open], dialog[open]").first();
        await dialog.waitFor({ state: "visible", timeout: 10_000 });
        const input = dialog.locator("input").first();
        if (await input.count()) {
          await input.fill("rollback");
          await page
            .locator(".pagefind-ui__result")
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() =>
              report.errors.push({ where: sname, what: "no search results within 10 s" }),
            );
        }
        await shot(page, sname, false);
        log(`shot ${sname}`);
        await page.close();
      } catch (e) {
        report.errors.push({ where: sname, what: String(e?.message ?? e).split("\n")[0] });
        log(`FAIL ${sname}: ${String(e?.message ?? e).split("\n")[0]}`);
      }
      // Mobile navigation menu, only at the phone width. Opened on a docs page:
      // the home page uses Starlight's splash template, which has no sidebar toggle.
      if (vp.width < 600) {
        const mname = `${vp.name}-${theme}-mobile-menu-open`;
        try {
          const { page } = await open(ctx, "/getting-started/quickstart/");
          await page
            .locator(
              "button[popovertarget='starlight__sidebar'], starlight-menu-button button, button[aria-controls='starlight__sidebar']",
            )
            .first()
            .click({ timeout: 10_000 });
          // Current Starlight: native popover (#starlight__sidebar:popover-open); older: data attribute.
          await page.waitForFunction(
            () =>
              document.querySelector("#starlight__sidebar")?.matches?.(":popover-open") ||
              document.querySelector("[data-mobile-menu-expanded]") !== null,
            null,
            { timeout: 10_000 },
          );
          await page.waitForTimeout(300);
          await shot(page, mname, false);
          log(`shot ${mname}`);
          await page.close();
        } catch (e) {
          report.errors.push({ where: mname, what: String(e?.message ?? e).split("\n")[0] });
          log(`FAIL ${mname}: ${String(e?.message ?? e).split("\n")[0]}`);
        }
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

// Summary: totals by impact and the most frequent rules across all page/theme runs.
const totals = {};
const rules = {};
for (const p of report.pages) {
  for (const [impact, list] of Object.entries(p.byImpact)) {
    totals[impact] = (totals[impact] ?? 0) + list.length;
    for (const v of list) {
      if (!rules[v.id]) rules[v.id] = { id: v.id, impact, help: v.help, pages: 0, nodes: 0 };
      const r = rules[v.id];
      r.pages += 1;
      r.nodes += v.nodes;
    }
  }
}
report.summary = {
  screenshots: report.screenshots.length,
  errors: report.errors.length,
  axeRuns: report.pages.length,
  violationsByImpact: totals,
  topRules: Object.values(rules)
    .sort((a, b) => b.pages - a.pages || b.nodes - a.nodes)
    .slice(0, 10),
};
report.finishedAt = new Date().toISOString();
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const IMPACTS = ["critical", "serious", "moderate", "minor"];
const md = [
  `# AXIOM docs visual + axe summary`,
  "",
  `Base: ${BASE}  `,
  `Run: ${report.startedAt} → ${report.finishedAt}  `,
  `Screenshots: ${report.screenshots.length} · capture errors: ${report.errors.length} · axe runs: ${report.pages.length} (${AXE_TAGS.join(", ")} @ ${AXE_VIEWPORT})`,
  "",
  `## Violations by impact (rule × page)`,
  "",
  ...IMPACTS.map((i) => `- ${i}: ${totals[i] ?? 0}`),
  "",
  `## Per page`,
  "",
  `| page | theme | status | ${IMPACTS.join(" | ")} |`,
  `|---|---|---|${IMPACTS.map(() => "---").join("|")}|`,
  ...report.pages.map(
    (p) =>
      `| ${p.path} | ${p.theme} | ${p.status} | ${IMPACTS.map((i) => p.byImpact[i]?.length ?? 0).join(" | ")} |`,
  ),
  "",
  `## Top rules`,
  "",
  `| rule | impact | pages | nodes | help |`,
  `|---|---|---|---|---|`,
  ...report.summary.topRules.map(
    (r) =>
      `| ${r.id} | ${r.impact} | ${r.pages} | ${r.nodes} | ${r.help.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`,
  ),
  "",
  `## Capture errors`,
  "",
  ...(report.errors.length ? report.errors.map((e) => `- ${e.where}: ${e.what}`) : ["none"]),
  "",
];
writeFileSync(join(OUT, "summary.md"), md.join("\n"));
log(
  `done: ${report.screenshots.length} screenshots, ${report.errors.length} errors, axe by impact ${JSON.stringify(totals)}`,
);
process.exit(report.errors.some((e) => !/mermaid|search results/.test(e.what)) ? 1 : 0);
