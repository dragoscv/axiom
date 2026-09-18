import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_PARAMS } from "./fixtures.js";
import { listTemplates, WEB_EMITTER_VERSION, webEmitter } from "./index.js";

const goldenDir = join(import.meta.dirname, "__golden__");
const NAMES = Object.keys(webEmitter.templates).sort();

const render = (name: string, params: unknown): string => {
  const def = webEmitter.templates[name];
  if (def === undefined) throw new Error(`no template ${name}`);
  return def.render(def.params.parse(params)) as string;
};

describe("web emitter", () => {
  it("is identified as web@2.0.0 with 7 documented templates", () => {
    expect(webEmitter.id).toBe("web");
    expect(webEmitter.version).toBe(WEB_EMITTER_VERSION);
    expect(WEB_EMITTER_VERSION).toBe("2.0.0");
    expect(NAMES).toEqual([
      "biome.config",
      "drizzle.table",
      "hono.route",
      "next.route-handler",
      "next.server-action",
      "readme.section",
      "tailwind.globals",
    ]);
    for (const [, description] of listTemplates()) expect(description.length).toBeGreaterThan(20);
    expect(Object.keys(GOLDEN_PARAMS).sort()).toEqual(NAMES);
  });

  it.each(NAMES)("%s renders byte-identically to its golden file", async (name) => {
    const expected = await readFile(join(goldenDir, `${name}.txt`), "utf8");
    const out = render(name, GOLDEN_PARAMS[name]);
    expect(out).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it.each(NAMES)("%s output is LF-only, newline-terminated and has no trailing blank", (name) => {
    const out = render(name, GOLDEN_PARAMS[name]);
    expect(out).not.toContain("\r");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it.each(NAMES)("%s render is pure: same params → identical bytes", (name) => {
    const a = render(name, GOLDEN_PARAMS[name]);
    const b = render(name, structuredClone(GOLDEN_PARAMS[name]));
    expect(b).toBe(a);
    expect(a).not.toMatch(/20\d\d-\d\d-\d\dT/); // no timestamps
  });

  it("method order in the output is canonical, not the caller's order", () => {
    const a = render("hono.route", { name: "h", path: "/h", methods: ["POST", "GET", "GET"] });
    const b = render("hono.route", { name: "h", path: "/h", methods: ["GET", "POST"] });
    expect(a).toBe(b);
    expect(a.indexOf("h.get(")).toBeLessThan(a.indexOf("h.post("));
  });
});

describe("web emitter — params validation", () => {
  const bad: [string, unknown][] = [
    ["next.route-handler", { segment: "/leading", methods: ["GET"] }],
    ["next.route-handler", { segment: "posts", methods: [] }],
    ["next.route-handler", { segment: "posts", methods: ["PATCH"] }],
    ["next.route-handler", { segment: "posts", methods: ["GET"], extra: 1 }],
    ["next.route-handler", { segment: "posts", methods: ["GET"], zodSchemaName: "2bad" }],
    ["next.server-action", { name: "createPost", fields: [] }],
    ["next.server-action", { name: "create post", fields: [{ name: "a", zod: "string" }] }],
    ["next.server-action", { name: "a", fields: [{ name: "b", zod: "date" }] }],
    ["hono.route", { name: "h", path: "health", methods: ["GET"] }],
    ["drizzle.table", { name: "BlogPosts", columns: [{ name: "a", type: "text" }] }],
    ["drizzle.table", { name: "posts", columns: [{ name: "a", type: "json" }] }],
    ["drizzle.table", { name: "posts", columns: [] }],
    ["biome.config", { anything: true }],
    ["tailwind.globals", { anything: true }],
    ["readme.section", { title: "", body: "x" }],
    ["readme.section", { title: "t" }],
  ];

  it.each(bad)("%s rejects %j", (name, params) => {
    const def = webEmitter.templates[name];
    const r = def?.params.safeParse(params);
    expect(r?.success).toBe(false);
    expect(r?.success === false && r.error.issues.length).toBeGreaterThan(0);
  });

  it("drizzle.table applies defaults and keeps an explicit primary key", () => {
    const withIdentity = render("drizzle.table", {
      name: "notes",
      columns: [{ name: "body", type: "text" }],
    });
    expect(withIdentity).toContain('id: integer("id").generatedAlwaysAsIdentity().primaryKey()');
    expect(withIdentity).toContain('body: text("body"),');

    const explicit = render("drizzle.table", {
      name: "notes",
      columns: [{ name: "slug", type: "uuid", primaryKey: true }],
    });
    expect(explicit).not.toContain("generatedAlwaysAsIdentity");
    expect(explicit).toContain('slug: uuid("slug").primaryKey(),');
  });

  it("next.route-handler omits the zod import when no schema name is given", () => {
    const out = render("next.route-handler", { segment: "ping", methods: ["POST"] });
    expect(out).not.toContain("./schema");
    expect(out).toContain("const data = (await request.json()) as unknown;");
  });

  it("readme.section normalises CRLF input to LF", () => {
    const out = render("readme.section", { title: "T", body: "a\r\nb\r\n\r\n" });
    expect(out).toBe("## T\n\na\nb\n");
  });
});
