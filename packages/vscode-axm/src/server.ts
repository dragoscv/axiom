/**
 * Self-contained LSP entry shipped inside the .vsix (`dist/server.cjs`). It is the
 * `@codai/axiom-axm-lsp` bin bundled together with `vscode-languageserver*`, because vsce does
 * not follow pnpm's symlinked `node_modules` and a .vsix must not depend on an npm install.
 */
import "@codai/axiom-axm-lsp/main";
