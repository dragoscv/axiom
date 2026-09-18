# Template emitters (`template` sources)

**Status:** v2.1 · owner decision D-13 · story S-207.

A `template` source lets a Plan artifact say *"render this small, well-known file for me"*
instead of carrying the bytes inline:

```json
{
  "path": "src/routes/health.ts",
  "source": {
    "type": "template",
    "emitter": "web",
    "template": "hono.route",
    "params": { "name": "health", "path": "/health", "methods": ["GET"] }
  }
}
```

At compile time the emitter renders the bytes; from then on the artifact is
indistinguishable from an `inline` one — it gets a sha256 digest, travels as a blob, goes
through `checks` and the two-phase `apply` like everything else. The manifest records
`origin: "template"` and `toolchain.emitters[<emitter>] = <version>`.

## What templates are — and are not

| Are | Are not |
|-----|---------|
| One file each, a few dozen lines, on the golden stack (Next 16 App Router, Hono 4, Drizzle, Tailwind v4, Biome). | An app scaffolder. Nothing here generates a whole project, a page tree, or a "notes app" — that was v1's mistake (see `docs/research/2026-09-18-red-team-critique.md` §(a)). |
| Pure functions of their Zod-validated `params`: same params → identical bytes, forever, on every OS. | Anything that calls an LLM, the network, the clock or `Math.random`. |
| Versioned. The emitter `version` is hashed into `manifestDigest`, so changing a template's output without bumping the version is caught by the golden-digest guard in CI. | Implicit. `compilePlan` ships **no** emitters; the caller injects a registry (`@codai/axiom-mcp` injects `web`). |
| Optional sugar. A Plan that never uses `template` behaves exactly as in v2.0. | A dependency of `@codai/axiom-plan`. The registry is an interface; `plan` does not depend on `emitters-web`. |

## Determinism contract

- `render(params)` must be referentially transparent. The `emitters-web` tests render every
  template twice and compare bytes, and pin a `manifestDigest` for a 3-template Plan that CI
  checks on ubuntu/windows/macos.
- Output is LF-only, ends with exactly one `\n`, contains no timestamps.
- Input `params` are part of `planDigest` (they are the inputs); the emitter `version` is part
  of `manifestDigest` (it is the toolchain). Bumping the version changes the manifest, not the plan.

## Error codes

| Code | When |
|------|------|
| `ERR_EMITTER_UNKNOWN` | no registry was given, or `source.emitter` is not in it (`details.available` lists ids) |
| `ERR_TEMPLATE_UNKNOWN` | emitter exists, template name does not (`details.available` lists names) |
| `ERR_TEMPLATE_PARAMS` | `params` fail the template's Zod schema (`details.issues`) |
| `ERR_BLOB_TOO_LARGE` | rendered output exceeds `INLINE_CONTENT_MAX` (256 KiB) |

## Catalogue — emitter `web@2.0.0` (`@codai/axiom-emitters-web`)

`axiom emitters` prints the same list; `axiom emitters --json` and the MCP resource
`axiom://emitters` return it as `{emitter, version, template, description}[]`.

| Template | Params | Output |
|----------|--------|--------|
| `next.route-handler` | `segment: string` (`posts`, `posts/[id]`), `methods: ("GET"\|"POST"\|"PUT"\|"DELETE")[]`, `zodSchemaName?: identifier` | `app/api/<segment>/route.ts`: one `export async function <METHOD>(request: NextRequest): Promise<Response>` per method, `Response.json`; POST/PUT validate the body with `<zodSchemaName>.safeParse` imported from `./schema` when given. Methods are emitted in canonical order. |
| `next.server-action` | `name: identifier`, `fields: { name: identifier, zod: "string"\|"number"\|"boolean"\|"email" }[]` | `"use server"` module: `z.object` schema, `<Name>State { ok, errors, values }`, `initial<Name>State`, and `async function <name>(prev, formData)` for `useActionState`. |
| `hono.route` | `name: identifier`, `path: "/..."`, `methods` | Module exporting `const <name> = new Hono()` with `<name>.get/post/put/delete(path, c => …)`; `export default <name>`. |
| `drizzle.table` | `name: snake_case`, `columns: { name: snake_case, type: "text"\|"integer"\|"boolean"\|"timestamp"\|"uuid", primaryKey?, notNull? }[]` | `pgTable("<name>", …)` with an `id integer generatedAlwaysAsIdentity().primaryKey()` unless a column sets `primaryKey`, `timestamp(..., { withTimezone: true })`, camelCase TS keys, `$inferSelect`/`$inferInsert` types. |
| `biome.config` | `{}` | `biome.json` in this repo's own style (Biome 2.5, 2-space, width 100, double quotes, LF; `noExplicitAny`/`noConsole`/`noNonNullAssertion` errors). |
| `tailwind.globals` | `{}` | Tailwind v4 CSS-first entry: `@import "tailwindcss"`, an `@theme` block with two colour tokens + radius, a `@layer base` body rule. |
| `readme.section` | `title: string`, `body: string` | `## <title>\n\n<body>` with CRLF normalised to LF. |

Every param object is `.strict()` — unknown keys are rejected.

Golden outputs live in `packages/emitters-web/src/__golden__/*.txt` and *are* the spec.
Change a template → run `pnpm --filter @codai/axiom-emitters-web run update-golden`, review
the diff, bump `WEB_EMITTER_VERSION`, update the pinned digest in `src/compile.test.ts`, and
say so in the changeset.

## Authoring an emitter package

An emitter is a plain object; the interfaces live in `@codai/axiom-plan`:

```ts
import { z } from "zod";
import type { TemplateEmitter } from "@codai/axiom-plan";

export const myEmitter: TemplateEmitter = {
  id: "acme",           // matches source.emitter
  version: "1.0.0",     // hashed into manifestDigest — bump on ANY output change
  templates: {
    "license.mit": {
      description: "MIT LICENSE file for the given holder",
      params: z.object({ holder: z.string().min(1) }).strict(),
      render: ({ holder }) => `MIT License\n\nCopyright (c) ${holder}\n`,
    },
  },
};
```

Rules:

1. `params` is anything with Zod's `safeParse` signature — `plan` has no zod dependency, so
   the type is structural (`ParamsSchema<T>`).
2. `render` returns `string` (UTF-8) or `Uint8Array`. No I/O, no clock, no randomness.
3. Depend on `@codai/axiom-schema` at most (for shared types); never on `plan`, `checks`,
   `apply` or `mcp`. `scripts/check-package-deps.mjs` enforces this for in-repo emitters.
4. Ship golden files and a pure-render test; pin a `manifestDigest` for a sample Plan so a
   silent output change fails CI.

Wire it in:

```ts
import { compilePlan, createEmitterRegistry } from "@codai/axiom-plan";
import { webEmitter } from "@codai/axiom-emitters-web";

const emitters = createEmitterRegistry([webEmitter, myEmitter]); // duplicate ids throw
const { bundle } = await compilePlan(plan, { emitters });
```

The published `axiom` CLI and MCP server register only `web`. Adding a third-party emitter
to them is not supported in 2.x — use the library API above.
