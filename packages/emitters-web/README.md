# @codai/axiom-emitters-web

The `web@2.0.0` template emitter for AXIOM `template` plan sources: seven small, pure,
deterministic file templates on the golden stack — **not** an app scaffolder.

| Template | Emits |
|----------|-------|
| `next.route-handler` | Next 16 App Router `route.ts` (`NextRequest` → `Response.json`, optional Zod body check) |
| `next.server-action` | `"use server"` action with Zod v4 + `useActionState` state shape |
| `hono.route` | Hono 4 route module |
| `drizzle.table` | `pgTable` with identity `id`, `withTimezone` timestamps |
| `biome.config` | Biome 2.5 `biome.json` (this repo's style) |
| `tailwind.globals` | Tailwind v4 CSS-first `globals.css` |
| `readme.section` | one `## title` markdown section |

```ts
import { compilePlan, createEmitterRegistry } from "@codai/axiom-plan";
import { webEmitter } from "@codai/axiom-emitters-web";

const { bundle } = await compilePlan(plan, { emitters: createEmitterRegistry([webEmitter]) });
// bundle.manifest.toolchain.emitters → { web: "2.0.0" }
```

Since AXIOM 3.0 the CLI no longer bundles this emitter (D-45). Install it next to the repo and
load it explicitly:

```sh
pnpm add -D @codai/axiom-emitters-web
axiom compile plan.json --emitter @codai/axiom-emitters-web
axiom mcp --root . --emitter @codai/axiom-emitters-web
```

`--emitter` takes a package name (resolved from the root's `node_modules`) or a path; the module
must export `emitters` (an array), an emitter as `default`, or named emitter objects. Without it,
a `template` source fails `ERR_EMITTER_UNKNOWN` with that install hint.

Golden outputs in `src/__golden__/*.txt` are the spec; `pnpm run update-golden` regenerates
them. Any output change must bump `WEB_EMITTER_VERSION` (it is hashed into every manifest
digest). Full contract, params and error codes: [docs/guides/emitters.md](../../docs/guides/emitters.md).
