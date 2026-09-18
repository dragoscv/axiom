/** One representative param set per template; drives both the golden files and the tests. */
export const GOLDEN_PARAMS: Record<string, Record<string, unknown>> = {
  "next.route-handler": {
    segment: "posts/[id]",
    methods: ["DELETE", "GET", "POST", "PUT"],
    zodSchemaName: "PostSchema",
  },
  "next.server-action": {
    name: "createPost",
    fields: [
      { name: "title", zod: "string" },
      { name: "views", zod: "number" },
      { name: "published", zod: "boolean" },
      { name: "author", zod: "email" },
    ],
  },
  "hono.route": { name: "health", path: "/health", methods: ["GET", "DELETE", "POST"] },
  "drizzle.table": {
    name: "blog_posts",
    columns: [
      { name: "title", type: "text", notNull: true },
      { name: "views", type: "integer" },
      { name: "published", type: "boolean", notNull: true },
      { name: "created_at", type: "timestamp", notNull: true },
      { name: "author_id", type: "uuid" },
    ],
  },
  "biome.config": {},
  "tailwind.globals": {},
  "readme.section": { title: "Install", body: "```sh\npnpm add @codai/axiom-mcp\n```\r\n" },
};
