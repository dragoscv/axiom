/**
 * LSP wiring: a `Connection` (stdio or node-ipc, chosen by the client's `--stdio`/`--node-ipc`
 * flag) + `TextDocuments`, dispatching to the pure feature functions in `features.ts`.
 *
 * stdout belongs to the JSON-RPC transport in `--stdio` mode; log only via `connection.console`
 * or stderr.
 */
import {
  type Connection,
  createConnection,
  type InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  computeCompletions,
  computeDiagnostics,
  computeHover,
  computeSemanticTokens,
  computeSymbols,
  formatDocument,
  SEMANTIC_LEGEND,
} from "./features.js";

export function startServer(connection: Connection = createConnection(ProposedFeatures.all)): void {
  const documents = new TextDocuments(TextDocument);

  connection.onInitialize(
    (): InitializeResult => ({
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: [" ", ".", "["], resolveProvider: false },
        hoverProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true, range: false },
      },
      serverInfo: { name: "axiom-axm-lsp" },
    }),
  );

  documents.onDidChangeContent((change) => {
    connection.sendDiagnostics({
      uri: change.document.uri,
      diagnostics: computeDiagnostics(change.document.getText()),
    });
  });
  documents.onDidClose((e) => {
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  });

  const text = (uri: string): string | undefined => documents.get(uri)?.getText();

  connection.onCompletion((p) => {
    const t = text(p.textDocument.uri);
    return t === undefined ? [] : computeCompletions(t, p.position);
  });
  connection.onHover((p) => {
    const t = text(p.textDocument.uri);
    return t === undefined ? null : computeHover(t, p.position);
  });
  connection.onDocumentSymbol((p) => {
    const t = text(p.textDocument.uri);
    return t === undefined ? [] : computeSymbols(t);
  });
  connection.onDocumentFormatting((p) => {
    const t = text(p.textDocument.uri);
    return t === undefined ? [] : formatDocument(t);
  });
  connection.languages.semanticTokens.on((p) => {
    const t = text(p.textDocument.uri);
    return t === undefined ? { data: [] } : computeSemanticTokens(t);
  });

  documents.listen(connection);
  connection.listen();
}
