// @ts-check
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlightGitHubAlerts from "starlight-github-alerts";
import starlightLinksValidator from "starlight-links-validator";

const site = "https://dragoscv.github.io";
const base = "/axiom";
const repo = "https://github.com/dragoscv/axiom";

// `.axm` fences reuse the VS Code extension's TextMate grammar (single source). Shiki keys a
// language by `name`, so the display name "AXIOM plan" is replaced by the fence id. No
// `embeddedLangs: ["json"]`: Expressive Code loads bundled langs lazily and rejects the
// dependency ("Missing languages `json`"); an unresolved `source.json` include renders as text.
const axmGrammar = {
  ...JSON.parse(
    readFileSync(new URL("../../packages/vscode-axm/syntaxes/axm.tmLanguage.json", import.meta.url), "utf8"),
  ),
  name: "axm",
  displayName: "AXIOM plan",
};

/**
 * Starlight's injected 404 route always emits `<link rel="canonical">` (+ `og:url`) pointing at
 * `/axiom/404/`, which tells crawlers a not-found page is a real document. There is no config
 * switch for it, so the built page is rewritten: canonical/og:url dropped, `noindex` added.
 */
const noindex404 = {
  name: "axiom-404-noindex",
  hooks: {
    /** @param {{ dir: URL }} options */
    "astro:build:done": ({ dir }) => {
      const file = fileURLToPath(new URL("404.html", dir));
      // Read and rewrite through one descriptor (no exists-then-open race).
      let fd;
      try {
        fd = openSync(file, "r+");
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return;
        throw err;
      }
      try {
        const html = readFileSync(fd, "utf8")
          .replace(/<link rel="canonical"[^>]*>/g, "")
          .replace(/<meta property="og:url"[^>]*>/g, "")
          .replace(/<head>/, '<head><meta name="robots" content="noindex">');
        ftruncateSync(fd, 0);
        writeSync(fd, html, 0, "utf8");
      } finally {
        closeSync(fd);
      }
    },
  },
};

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  integrations: [
    // astro-mermaid must run before Starlight so its code-fence transform is registered first.
    mermaid({ autoTheme: true }),
    starlight({
      title: "AXIOM",
      description: "The transactional write gate for coding agents.",
      logo: { src: "./src/assets/logo.svg", alt: "AXIOM" },
      favicon: "/favicon.svg",
      lastUpdated: true,
      social: [{ icon: "github", label: "GitHub", href: repo }],
      // Self-hosted fonts (@fontsource): no request to Google Fonts, so no visitor IP leaves the site.
      customCss: [
        "@fontsource/instrument-serif/400.css",
        "@fontsource/instrument-serif/400-italic.css",
        "@fontsource/inter/400.css",
        "@fontsource/inter/500.css",
        "@fontsource/inter/600.css",
        "@fontsource/jetbrains-mono/400.css",
        "@fontsource/jetbrains-mono/500.css",
        "./src/styles/custom.css",
      ],
      head: [
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:image", content: `${site}${base}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "AXIOM — the transactional write gate for coding agents",
          },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${site}${base}/og.png` } },
        {
          // Wide tables scroll horizontally: give each overflowing one keyboard access
          // (WCAG 2.1.1; axe scrollable-region-focusable).
          tag: "script",
          content:
            "addEventListener('DOMContentLoaded',()=>{for(const t of document.querySelectorAll('.sl-markdown-content table')){if(t.scrollWidth>t.clientWidth){t.tabIndex=0;if(!t.hasAttribute('aria-label'))t.setAttribute('aria-label',(t.querySelector('th')?.textContent?.trim()||'Table')+' (scrollable table)')}}})",
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#fbf7ef",
            media: "(prefers-color-scheme: light)",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#17181c",
            media: "(prefers-color-scheme: dark)",
          },
        },
      ],
      expressiveCode: {
        themes: ["github-light", "github-dark-default"],
        useStarlightDarkModeSwitch: true,
        shiki: { langs: [axmGrammar] },
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", link: "/overview/" },
            { autogenerate: { directory: "getting-started" } },
          ],
        },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Integrations", items: [{ autogenerate: { directory: "integration" } }] },
        // docs/spec/** keeps its exact URIs (sync-docs sets `slug`): they are predicate types.
        { label: "Specifications", items: [{ autogenerate: { directory: "spec" } }] },
        // docs/research/** is not published (sync-docs EXCLUDE_DIRS) — it links to GitHub.
        { label: "Design", items: [{ autogenerate: { directory: "design" } }] },
      ],
      plugins: [
        starlightGitHubAlerts(),
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          errorOnInvalidHashes: false,
        }),
      ],
    }),
    noindex404,
  ],
});
