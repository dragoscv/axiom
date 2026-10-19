# @codai/axiom-emitters-web

## 3.0.0

### Major Changes

- 9122967: 3.0 (D-43 / D-45, S-1312 / S-1319):
  
  - **mcp — core toolset by default.** `createServer` / `serverFactory` take `toolset: "core" | "full"`;
    `core` (default) serves `axiom_write`, `axiom_status`, `axiom_rollback`, `axiom_check`,
    `axiom_apply`, `axiom_apply_dry_run`; `full` serves every tool. `parseToolset(value)` parses the
    `--tools core|full` flag (`ERR_USAGE` otherwise). `spec/tools.json` and `spec/codai-tools.json`
    mark each tool `"toolset": "core" | "full"` (codai spec format version 3.0.0).
  - **mcp — emitters-web is no longer bundled.** `template` sources need an emitter loaded with
    `--emitter <pkg>` (`loadEmitters(specs, root)`: package name resolved from the root's
    `node_modules`, or a path). Without one they fail `ERR_EMITTER_UNKNOWN` with
    `details.hint` "install @codai/axiom-emitters-web and pass --emitter @codai/axiom-emitters-web".
    `axiom://emitters` is empty by default.
  - **axm — language server merged in.** `@codai/axiom-axm/lsp` (+ bin `axm-lsp`) is the `.axm`
    language server; the main entry stays LSP-free. Fixed: a plan named `meta` (or any keyword) no
    longer mis-lexes its body as a JSON block; `KEYWORD_IMAGES` is exported.
  - **axm-lsp — deprecated.** Thin re-export of `@codai/axiom-axm/lsp` for 3.x; not published for 4.0.
  - **emitters-web** — banners derive from `WEB_EMITTER_VERSION` (`generatedBanner`); exports
    `emitters` for `--emitter` loading.

## 2.7.0

No changes in this release.

## 2.6.1

No changes in this release.

## 2.6.0

No changes in this release.

## 2.5.2

No changes in this release.

## 2.5.1

No changes in this release.

## 2.5.0

No changes in this release.

## 2.4.1

No changes in this release.

## 2.4.0

No changes in this release.

## 2.3.1

No changes in this release.

## 2.3.0

No changes in this release.

## 2.2.1

No changes in this release.

## 2.2.0

No changes in this release.

## 2.1.0

### Minor Changes

- f70b6d2: Template sources (S-207, D-13). `compilePlan(plan, { emitters })` now renders
  `{ type: "template", emitter, template, params }` sources through an injected
  `EmitterRegistry` (`createEmitterRegistry`, `TemplateEmitter`, `TemplateDef` exported from
  `@codai/axiom-plan`; `plan` gains no dependency). Rendered bytes follow the inline path; the
  manifest records `origin: "template"` and `toolchain.emitters[<id>] = <version>` so an emitter
  bump changes `manifestDigest`, while `params` are hashed into `planDigest`. New closed error codes
  `ERR_EMITTER_UNKNOWN`, `ERR_TEMPLATE_UNKNOWN`, `ERR_TEMPLATE_PARAMS` (template sources no longer
  raise `ERR_UNSUPPORTED_OP`).
  
  New package `@codai/axiom-emitters-web`: emitter `web@2.0.0` with seven small deterministic
  golden-stack templates — `next.route-handler`, `next.server-action`, `hono.route`,
  `drizzle.table`, `biome.config`, `tailwind.globals`, `readme.section` — each with strict Zod
  params, a committed golden file and a pinned cross-OS manifest digest. Not an app generator.
  
  `@codai/axiom-mcp` registers `web` in `axiom_plan_compile` / `axiom_plan_validate` and
  `axiom compile`, adds the `axiom emitters [--json]` verb and the static `axiom://emitters`
  resource. No tool input schema changed.
