#!/usr/bin/env node
/**
 * check-package-deps — enforce the package boundary graph (PLAN.md §2) and
 * dependency-spec hygiene for every workspace package (packages/_v1 ignored).
 *
 *   schema, canon      → no @codai/* deps
 *   plan, checks, apply → only schema + canon
 *   axm                → only schema (+ plan as a devDependency for the compile-through test)
 *   testkit            → schema + canon + plan
 *   mcp                → anything EXCEPT testkit
 *   conformance        → mcp as a devDependency ONLY (private harness that spawns the built CLI)
 *   nobody else depends on mcp
 *
 * Every `@codai/axiom-*` dep must be `workspace:*`; every external dep must be
 * `catalog:` (pnpm-workspace.yaml is the single version source).
 */
import { join } from "node:path";
import { REPO_ROOT, readJson, report, workspacePackages } from "./_guard-lib.mjs";

const SCOPE = "@codai/axiom-";

/** allowed internal deps per package (by short name). */
const ALLOWED = {
  schema: [],
  canon: [],
  plan: ["schema", "canon"],
  checks: ["schema", "canon"],
  apply: ["schema", "canon"],
  axm: ["schema"],
  testkit: ["schema", "canon", "plan"],
  mcp: ["schema", "canon", "plan", "checks", "apply", "axm"],
  conformance: [],
};

/** devDependencies-only exceptions (test tooling that must not leak into runtime deps). */
const DEV_ALLOWED = {
  axm: ["plan"],
  conformance: ["mcp"],
};

const problems = [];
const pkgs = workspacePackages();

for (const name of pkgs) {
  const file = join(REPO_ROOT, "packages", name, "package.json");
  const pkg = readJson(file);
  const allowed = ALLOWED[name];
  if (!allowed) {
    problems.push(`packages/${name}: not in the boundary graph — add it to ALLOWED in this guard`);
    continue;
  }
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const section of sections) {
    for (const [dep, spec] of Object.entries(pkg[section] ?? {})) {
      if (dep.startsWith(SCOPE)) {
        const short = dep.slice(SCOPE.length);
        const devOk = section === "devDependencies" && (DEV_ALLOWED[name] ?? []).includes(short);
        if (short === "mcp" && !devOk) {
          problems.push(
            `packages/${name}: depends on ${dep} — nobody may depend on mcp (conformance: devDependency only)`,
          );
        } else if (short === "testkit" && name !== "testkit") {
          problems.push(`packages/${name}: depends on ${dep} — testkit is private test tooling`);
        } else if (!allowed.includes(short) && !devOk) {
          problems.push(
            `packages/${name}: ${section} → ${dep} violates boundary (allowed: ${allowed.join(", ") || "none"})`,
          );
        }
        if (spec !== "workspace:*") {
          problems.push(`packages/${name}: ${dep} must be "workspace:*", got "${spec}"`);
        }
      } else if (spec !== "catalog:" && !spec.startsWith("catalog:")) {
        problems.push(`packages/${name}: ${section} → ${dep} must use "catalog:", got "${spec}"`);
      }
    }
  }
}

report("package-deps", problems, {
  notes: [`${pkgs.length} packages: ${pkgs.join(", ")}`],
  stats: { packages: pkgs },
});
