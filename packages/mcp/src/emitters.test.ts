import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManifestBundle } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMITTER_HINT,
  emitterCatalogue,
  emittersOf,
  loadEmitters,
  NO_EMITTERS,
  resolveEmitterModule,
} from "./emitters.js";
import { type Harness, harness, structured, tmpRepo } from "./test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
/** packages/mcp — its node_modules links the workspace `@codai/axiom-emitters-web` (devDependency). */
const MCP_DIR = resolve(here, "..");
const EMITTERS_WEB_DIR = resolve(here, "..", "..", "emitters-web");

const templatePlan = {
  apiVersion: "axiom.dev/v2",
  kind: "Plan",
  name: "tpl",
  intent: "template source",
  artifacts: [
    {
      path: "src/routes/health.ts",
      source: {
        type: "template",
        emitter: "web",
        template: "hono.route",
        params: { name: "health", path: "/health", methods: ["GET"] },
      },
    },
  ],
};

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let h: Harness | undefined;
beforeEach(async () => {
  repo = await tmpRepo("axiom-emitters-");
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  await repo.cleanup();
});

describe("--emitter loading (D-45: emitters-web is not bundled)", () => {
  it("default registry is empty; a template source fails ERR_EMITTER_UNKNOWN with the install hint", async () => {
    expect(NO_EMITTERS.list()).toEqual([]);
    expect(emitterCatalogue()).toEqual([]);
    h = await harness([repo.root]);
    const r = await h.call("axiom_plan_compile", { plan: templatePlan });
    expect(r.isError).toBe(true);
    const err = structured<{ code: string; message: string; details: { hint: string } }>(r);
    expect(err.code).toBe("ERR_EMITTER_UNKNOWN");
    expect(err.details.hint).toBe(EMITTER_HINT);
    expect(err.message).toContain("--emitter @codai/axiom-emitters-web");
    const v = await h.call("axiom_plan_validate", { plan: templatePlan });
    expect(structured<{ code: string }>(v).code).toBe("ERR_EMITTER_UNKNOWN");
  });

  it("a package that is not installed under the root → ERR_EMITTER_UNKNOWN reason not-installed", async () => {
    await expect(loadEmitters(["@codai/axiom-emitters-nope"], repo.root)).rejects.toMatchObject({
      code: "ERR_EMITTER_UNKNOWN",
      details: { reason: "not-installed", hint: EMITTER_HINT },
    });
  });

  it("--emitter <pkg name> resolves from the root's node_modules and renders the template", async () => {
    const registry = await loadEmitters(["@codai/axiom-emitters-web"], MCP_DIR);
    expect(registry.list()).toEqual(["web"]);
    const rows = emitterCatalogue(registry);
    expect(rows.map((x) => x.template)).toContain("hono.route");
    h = await harness([repo.root], { emitters: registry });
    const r = await h.call("axiom_plan_compile", { plan: templatePlan });
    expect(r.isError).toBeUndefined();
    const bundle = structured<ManifestBundle>(r);
    expect(Object.keys(bundle.manifest.toolchain.emitters ?? {})).toEqual(["web"]);
    expect(bundle.manifest.artifacts[0]?.origin).toBe("template");
    const em = await h.client.readResource({ uri: "axiom://emitters" });
    expect(JSON.parse(em.contents[0]?.text as string)).toHaveLength(rows.length);
  });

  it("--emitter <path to the workspace package dir> works too", async () => {
    const file = resolveEmitterModule(EMITTERS_WEB_DIR, repo.root);
    expect(file.replaceAll("\\", "/")).toMatch(/emitters-web\/dist\/index\.js$/);
    const registry = await loadEmitters([EMITTERS_WEB_DIR], repo.root);
    expect(registry.get("web")?.templates).toHaveProperty("next.route-handler");
  });

  it("a module without an emitter export → ERR_EMITTER_UNKNOWN reason no-emitter", async () => {
    const notEmitter = join(repo.root, "not-emitter.mjs");
    await writeFile(notEmitter, "export const answer = 42;\n");
    expect(emittersOf({ PACKAGE_VERSION: "x" })).toEqual([]);
    await expect(loadEmitters([notEmitter], repo.root)).rejects.toMatchObject({
      code: "ERR_EMITTER_UNKNOWN",
      details: { reason: "no-emitter" },
    });
  });
});
