---
"@codai/axiom-mcp": major
"@codai/axiom-axm": major
"@codai/axiom-axm-lsp": major
"@codai/axiom-emitters-web": major
---

3.0 (D-43 / D-45, S-1312 / S-1319):

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
