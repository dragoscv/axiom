// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlightGitHubAlerts from "starlight-github-alerts";
import starlightLinksValidator from "starlight-links-validator";

const site = "https://dragoscv.github.io";
const base = "/axiom";
const repo = "https://github.com/dragoscv/axiom";

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
      customCss: ["./src/styles/custom.css"],
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
        { tag: "meta", attrs: { name: "theme-color", content: "#090814" } },
      ],
      expressiveCode: { themes: ["github-dark-default", "github-light"] },
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
        {
          label: "Design & research",
          items: [
            { label: "Design", items: [{ autogenerate: { directory: "design" } }] },
            {
              label: "Research",
              collapsed: true,
              items: [{ autogenerate: { directory: "research" } }],
            },
          ],
        },
      ],
      plugins: [
        starlightGitHubAlerts(),
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          errorOnInvalidHashes: false,
        }),
      ],
    }),
  ],
});
