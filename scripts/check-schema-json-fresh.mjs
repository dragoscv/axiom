#!/usr/bin/env node
/**
 * check-schema-json-fresh — the committed `packages/schema/schemas/*.json`
 * must equal what `packages/schema/scripts/emit-json-schema.ts` produces from
 * the current Zod schemas. Drift means someone changed a schema and did not
 * run `pnpm --filter @codai/axiom-schema build:jsonschema`.
 *
 * The emitter writes next to itself, so instead of running it in place (which
 * would mutate the tree) this guard mirrors its target list into a temp
 * script that writes to a temp dir, then diffs byte-for-byte. Needs `tsx`
 * (root devDependency); skips with a note when node_modules is absent.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exists, REPO_ROOT, readText, report, STRICT } from "./_guard-lib.mjs";

const SCHEMA_PKG = join(REPO_ROOT, "packages", "schema");
const EMITTER = join(SCHEMA_PKG, "scripts", "emit-json-schema.ts");
const COMMITTED = join(SCHEMA_PKG, "schemas");

const rootRequire = createRequire(join(REPO_ROOT, "package.json"));
let tsxOk = false;
try {
  rootRequire.resolve("tsx/esm");
  tsxOk = true;
} catch {
  tsxOk = false;
}
if (!tsxOk) {
  report("schema-json-fresh", STRICT ? ["tsx not installed — run pnpm install"] : [], {
    notes: ["skipped: tsx not installed"],
    skipped: true,
  });
}
if (!exists(EMITTER)) report("schema-json-fresh", [`${EMITTER} missing`]);

/* Mirror the emitter's target list so the two never drift apart. */
const emitterSrc = readText(EMITTER);
const targets = [...emitterSrc.matchAll(/\[\s*"(\w+)"\s*,\s*(\w+)\s*\]/g)].map((m) => [m[1], m[2]]);
const options = /z\.toJSONSchema\(schema,\s*(\{[\s\S]*?\})\s*\)/.exec(emitterSrc)?.[1] ?? "{}";
const idBase = /\$id:\s*`([^`]*)\$\{name\}/.exec(emitterSrc)?.[1] ?? "";
if (targets.length === 0)
  report("schema-json-fresh", ["could not parse target list from emit-json-schema.ts"]);

const schemaRequire = createRequire(join(SCHEMA_PKG, "package.json"));
const zodUrl = pathToFileURL(schemaRequire.resolve("zod")).href;
const indexUrl = pathToFileURL(join(SCHEMA_PKG, "src", "index.ts")).href;

const tmp = mkdtempSync(join(tmpdir(), "axiom-schema-fresh-"));
const outDir = join(tmp, "schemas");
const script = join(tmp, "emit.mjs");
writeFileSync(
  script,
  `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from ${JSON.stringify(zodUrl)};
import { ${targets.map((t) => t[1]).join(", ")} } from ${JSON.stringify(indexUrl)};
const outDir = ${JSON.stringify(outDir)};
mkdirSync(outDir, { recursive: true });
const targets = [${targets.map((t) => `["${t[0]}", ${t[1]}]`).join(", ")}];
for (const [name, schema] of targets) {
  const json = z.toJSONSchema(schema, ${options});
  const doc = { $id: ${JSON.stringify(idBase)} + name + ".schema.json", title: name, ...json };
  writeFileSync(join(outDir, name + ".schema.json"), JSON.stringify(doc, null, 2) + "\\n", "utf8");
}
`,
);

const run = spawnSync(process.execPath, ["--import", "tsx/esm", script], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  timeout: 45_000,
});

const problems = [];
if (run.status !== 0) {
  problems.push(
    `emitter failed (exit ${run.status ?? run.signal}): ${(run.stderr || run.stdout).trim().split("\n").slice(-3).join(" | ")}`,
  );
} else {
  const fresh = readdirSync(outDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const committed = readdirSync(COMMITTED)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const f of fresh) {
    if (!committed.includes(f)) {
      problems.push(`schemas/${f} is emitted but not committed`);
      continue;
    }
    if (readText(join(outDir, f)) !== readText(join(COMMITTED, f))) {
      problems.push(
        `schemas/${f} is stale — run pnpm --filter @codai/axiom-schema build:jsonschema`,
      );
    }
  }
  for (const f of committed) {
    if (!fresh.includes(f)) problems.push(`schemas/${f} is committed but no longer emitted`);
  }
}
rmSync(tmp, { recursive: true, force: true });

report("schema-json-fresh", problems, {
  notes: [`${targets.length} schemas compared`],
  stats: { schemas: targets.map((t) => t[0]) },
});
