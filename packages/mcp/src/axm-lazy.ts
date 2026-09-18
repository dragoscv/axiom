/**
 * Lazy-loaded `.axm` parser entry. Built by tsdown as its own self-contained chunk
 * (`dist/axm-lazy.js`, chevrotain + its own copy of schema/zod) and reached only via
 * `import("./axm-lazy.js")` from `axiom_axm_parse` and `compile <plan.axm>`, so the
 * eager `cli.js + cli-main.js` budget and cold start are unaffected.
 */
export { parseAxm } from "@codai/axiom-axm";
