/**
 * Self-contained LSP entry shipped inside the .vsix (`dist/server.cjs`). It is the
 * `axm-lsp` bin of `@codai/axiom-axm` (`@codai/axiom-axm/lsp/main`, merged from the deprecated
 * `@codai/axiom-axm-lsp` in 3.0) bundled together with `vscode-languageserver*`, because vsce does
 * not follow pnpm's symlinked `node_modules` and a .vsix must not depend on an npm install.
 */
import "@codai/axiom-axm/lsp/main";
