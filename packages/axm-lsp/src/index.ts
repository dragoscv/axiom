/**
 * `@codai/axiom-axm-lsp` — language server for `.axm` (docs/reference/axm-syntax.md "Editor support").
 *
 * The feature functions are pure (text in, LSP structures out) so hosts other than the bundled
 * bin can embed them; `startServer` wires them to a `vscode-languageserver` connection.
 */
export {
  computeCompletions,
  computeDiagnostics,
  computeHover,
  computeSemanticTokens,
  computeSymbols,
  DIAGNOSTIC_SOURCE,
  formatDocument,
  SEMANTIC_LEGEND,
  SEMANTIC_TOKEN_TYPES,
  toLspRange,
} from "./features.js";
export { LineIndex, type ScanToken, scan, type TokenKind } from "./scan.js";
export { startServer } from "./server.js";
export {
  CAPABILITIES,
  KEYWORDS,
  type KeywordDoc,
  MODE_VALUES,
  OP_VALUES,
  PREDICATE_IDS,
  PREDICATES,
  PROFILE_VALUES,
} from "./vocabulary.js";
