/**
 * VS Code client for `.axm`: spawns the `@codai/axiom-axm-lsp` bin in a Node process and
 * connects over node-ipc. Everything language-related lives in the server.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionContext } from "vscode";
import { LanguageClient, type ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function resolveServerModule(): string {
  // Workspace / dev host: the LSP package is installed next to us → use its own dist so a
  // rebuild of `packages/axm-lsp` is picked up without repackaging the extension.
  try {
    return createRequire(__filename).resolve("@codai/axiom-axm-lsp/main");
  } catch {
    // Packaged .vsix: no node_modules; the server is bundled as `dist/server.cjs`.
    const bundled = join(__dirname, "server.cjs");
    if (existsSync(bundled)) return bundled;
    throw new Error("axiom-axm: language server not found (dist/server.cjs missing)");
  }
}

export function activate(context: ExtensionContext): void {
  const module = resolveServerModule();
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--inspect=6009"] } },
  };
  client = new LanguageClient("axiomAxm", "AXIOM .axm", serverOptions, {
    documentSelector: [{ language: "axm" }],
    synchronize: {},
  });
  context.subscriptions.push({ dispose: () => void client?.stop() });
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
