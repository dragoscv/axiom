/**
 * "AXIOM" VS Code extension (id dragoscv.axiom-axm): the `.axm` language client plus a status
 * bar item showing the gate state of the workspace and the AXIOM commands.
 *
 * Process rules: every CLI call is `execFile` with an args array (never a shell); nothing is
 * spawned in an untrusted workspace (`capabilities.untrustedWorkspaces: limited`); the workspace
 * copy of the language server is used only when the workspace is trusted and its version is not
 * older than the bundled one.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  commands,
  type ExtensionContext,
  type OutputChannel,
  StatusBarAlignment,
  type StatusBarItem,
  ThemeColor,
  window,
  workspace,
} from "vscode";
import { LanguageClient, type ServerOptions, TransportKind } from "vscode-languageclient/node";
import {
  extractJson,
  type GateStatus,
  type Invocation,
  isUnknownCommand,
  pickServerModule,
  renderDoctor,
  resolveInvocation,
  statusFromDoctor,
  unknownStatus,
} from "./status.js";

const REFRESH_MS = 10 * 60 * 1000;
const CLI_TIMEOUT_MS = 60_000;

let client: LanguageClient | undefined;
let output: OutputChannel | undefined;
let item: StatusBarItem | undefined;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  missing?: boolean;
}

function wsRoot(): string | undefined {
  return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function invocation(): Invocation | undefined {
  const setting = workspace.getConfiguration("axiom").get<string>("path", "axiom");
  return resolveInvocation(setting, {
    platform: process.platform,
    path: process.env.PATH ?? process.env.Path ?? "",
    exists: existsSync,
  });
}

function runCli(args: readonly string[], cwd: string | undefined): Promise<CliResult> {
  const inv = invocation();
  if (inv === undefined) {
    return Promise.resolve({ code: 127, stdout: "", stderr: "axiom not found", missing: true });
  }
  return new Promise((resolve) => {
    execFile(
      inv.file,
      [...inv.prefix, ...args],
      { cwd, timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "ENOENT") {
          resolve({ code: 127, stdout: "", stderr: String(err?.message), missing: true });
          return;
        }
        resolve({ code: typeof code === "number" ? code : err ? 1 : 0, stdout, stderr });
      },
    );
  });
}

function channel(): OutputChannel {
  output ??= window.createOutputChannel("AXIOM");
  return output;
}

function applyStatus(s: GateStatus): void {
  if (item === undefined) return;
  item.text = s.text;
  item.tooltip = s.tooltip;
  item.backgroundColor = s.background === undefined ? undefined : new ThemeColor(s.background);
  item.show();
}

/** `axiom setup doctor --json`, falling back to the pre-3.0 `axiom doctor --json`. */
async function doctor(root: string): Promise<{ doc?: unknown; raw: CliResult }> {
  let raw = await runCli(["setup", "doctor", "--json", "--root", root], root);
  if (
    !raw.missing &&
    extractJson(raw.stdout) === undefined &&
    isUnknownCommand(raw.stderr, raw.stdout)
  ) {
    raw = await runCli(["doctor", "--json", "--root", root], root);
  }
  const doc = extractJson(raw.stdout);
  return doc === undefined ? { raw } : { doc, raw };
}

async function refresh(): Promise<GateStatus> {
  const root = wsRoot();
  let s: GateStatus;
  if (!workspace.isTrusted) s = unknownStatus("Workspace not trusted — AXIOM runs nothing here");
  else if (root === undefined) s = unknownStatus("Open a folder to see its AXIOM gate state");
  else {
    const { doc, raw } = await doctor(root);
    s = raw.missing
      ? unknownStatus("axiom CLI not found — set `axiom.path` or `npm i -g @codai/axiom-mcp`")
      : statusFromDoctor(doc);
  }
  applyStatus(s);
  return s;
}

function requireTrusted(): string | undefined {
  if (!workspace.isTrusted) {
    void window.showWarningMessage(
      "AXIOM: trust this workspace first — nothing is run in untrusted workspaces.",
    );
    return undefined;
  }
  const root = wsRoot();
  if (root === undefined) void window.showWarningMessage("AXIOM: open a folder first.");
  return root;
}

function show(title: string, body: string): void {
  const out = channel();
  out.appendLine(`── ${title} — ${new Date().toISOString()}`);
  out.appendLine(body.trimEnd());
  out.show(true);
}

async function cmdDoctor(): Promise<void> {
  const root = requireTrusted();
  if (root === undefined) return;
  const { doc, raw } = await doctor(root);
  applyStatus(raw.missing ? unknownStatus("axiom CLI not found") : statusFromDoctor(doc));
  show("AXIOM: Doctor", doc === undefined ? `${raw.stdout}\n${raw.stderr}` : renderDoctor(doc));
}

async function cmdInit(): Promise<void> {
  const root = requireTrusted();
  if (root === undefined) return;
  const pick = await window.showWarningMessage(
    `Run "axiom init" in ${root}? It writes AXIOM hook / MCP / profile files into the workspace.`,
    { modal: true },
    "Run axiom init",
  );
  if (pick !== "Run axiom init") return;
  const r = await runCli(["init", "--root", root], root);
  show("AXIOM: Init", `${r.stdout}\n${r.stderr}`);
  await refresh();
}

async function cmdStats(): Promise<void> {
  const root = requireTrusted();
  if (root === undefined) return;
  const r = await runCli(["stats", "--json", "--root", root], root);
  const doc = extractJson(r.stdout);
  show(
    "AXIOM: Stats",
    doc === undefined ? `${r.stdout}\n${r.stderr}` : JSON.stringify(doc, null, 2),
  );
}

async function cmdExplain(): Promise<void> {
  const root = requireTrusted();
  if (root === undefined) return;
  const r = await runCli(["explain", "last", "--root", root], root);
  if (!r.missing && r.code !== 0 && isUnknownCommand(r.stderr, r.stdout)) {
    void window.showWarningMessage(
      "AXIOM: Explain last decision needs axiom ≥ 3.0 (npm i -g @codai/axiom-mcp@3).",
    );
    return;
  }
  show("AXIOM: Explain last decision", `${r.stdout}\n${r.stderr}`);
}

function readVersion(pkgJson: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Workspace `@codai/axiom-axm` (its `lsp/main` export) when installed next to the workspace. */
function workspaceServer(
  root: string | undefined,
): { module: string; version: string } | undefined {
  if (root === undefined) return undefined;
  try {
    const req = createRequire(join(root, "package.json"));
    const module = req.resolve("@codai/axiom-axm/lsp/main");
    const version = readVersion(req.resolve("@codai/axiom-axm/package.json"));
    return version === undefined ? undefined : { module, version };
  } catch {
    return undefined;
  }
}

function startLanguageClient(context: ExtensionContext): void {
  const bundled = join(__dirname, "server.cjs");
  const bundledVersion = readVersion(join(dirname(__dirname), "package.json")) ?? "0.0.0";
  const { module, source } = pickServerModule({
    trusted: workspace.isTrusted,
    bundled,
    bundledVersion,
    workspace: workspace.isTrusted ? workspaceServer(wsRoot()) : undefined,
  });
  if (!existsSync(module)) {
    channel().appendLine(`AXIOM: language server not found (${module})`);
    return;
  }
  channel().appendLine(`AXIOM: .axm language server (${source}) ${module}`);
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

export function activate(context: ExtensionContext): void {
  item = window.createStatusBarItem("axiom.gate", StatusBarAlignment.Left, 50);
  item.name = "AXIOM gate";
  item.command = "axiom.doctor";
  applyStatus(unknownStatus("AXIOM: checking…"));
  context.subscriptions.push(
    item,
    commands.registerCommand("axiom.doctor", cmdDoctor),
    commands.registerCommand("axiom.init", cmdInit),
    commands.registerCommand("axiom.stats", cmdStats),
    commands.registerCommand("axiom.explainLast", cmdExplain),
    commands.registerCommand("axiom.refresh", refresh),
    workspace.onDidGrantWorkspaceTrust(() => void refresh()),
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("axiom.path")) void refresh();
    }),
  );
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh();
  startLanguageClient(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
