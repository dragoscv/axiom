/**
 * Lazy chunk for `axiom compile <plan.yaml|plan.yml>` (S-707): the `yaml` parser (CJS) lives
 * here, one self-contained file, so the eager `cli-main.js` neither carries it nor statically
 * imports a shared runtime-helper chunk.
 */
export { parsePlanYaml } from "@codai/axiom-plan";
