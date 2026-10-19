/**
 * `axiom pin` (3.0, I-13): pin the MCP servers an agent can reach from this root, so a config
 * change (a swapped command, a new argument, an extra env var, a new remote URL) is visible.
 *
 * Reads only the configs that exist: `<root>/.vscode/mcp.json` (`servers`),
 * `<root>/.cursor/mcp.json`, `<root>/.mcp.json` and `~/.copilot/mcp-config.json`
 * (`mcpServers`; both keys are accepted everywhere). JSONC is tolerated. Each server's pin is
 * `sha256(JCS({command, args, url, envKeys}))` — env VALUES are never read into the pin or the
 * pin file, only the sorted key names. Pins live in `<root>/.axiom/mcp-pins.json`;
 * `--check` reports added / removed / changed servers and exits 1 on any difference.
 *
 * Future work (deliberately not done): pinning the tool DESCRIPTIONS a server advertises
 * (the "rug pull" vector) needs a live `tools/list`, i.e. starting the server. AXIOM never spawns
 * third-party servers from a config it is auditing, so that needs a separate, opt-in design
 * (e.g. reading descriptions a harness already cached, or a sandboxed launcher).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { isAxiomError } from "@codai/axiom-schema";
import { stripJsonc } from "./doctor.js";
import { createRootsPolicy, resolveRoot } from "./roots.js";

export const MCP_PINS_FILE = ".axiom/mcp-pins.json";

export interface PinIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd?: string;
  /** Home directory for `~/.copilot/mcp-config.json` (default: USERPROFILE/HOME/os.homedir()). */
  home?: string;
}

export interface PinnedServer {
  /** `<source>#<name>`. */
  key: string;
  source: string;
  name: string;
  pin: `sha256:${string}`;
  /** What was pinned, minus env values. */
  shape: { command?: string; args?: string[]; url?: string; envKeys: string[] };
}

export interface PinsFile {
  v: 1;
  servers: Record<string, { source: string; name: string; pin: string }>;
}

export interface PinDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Config files consulted, as `[display source, absolute path]`. */
export function mcpConfigCandidates(rootReal: string, home: string): [string, string][] {
  return [
    [".vscode/mcp.json", path.join(rootReal, ".vscode", "mcp.json")],
    [".cursor/mcp.json", path.join(rootReal, ".cursor", "mcp.json")],
    [".mcp.json", path.join(rootReal, ".mcp.json")],
    ["~/.copilot/mcp-config.json", path.join(home, ".copilot", "mcp-config.json")],
  ];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The pinned shape of one server entry (env values dropped). */
export function serverShape(entry: Record<string, unknown>): PinnedServer["shape"] {
  const shape: PinnedServer["shape"] = { envKeys: [] };
  if (typeof entry.command === "string") shape.command = entry.command;
  if (Array.isArray(entry.args)) shape.args = entry.args.map((a) => String(a));
  if (typeof entry.url === "string") shape.url = entry.url;
  if (isRecord(entry.env)) shape.envKeys = Object.keys(entry.env).sort();
  return shape;
}

export function pinOf(shape: PinnedServer["shape"]): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalize(shape))}`;
}

/** Every server in the configs that exist; unreadable / malformed configs go to `errors`. */
export async function collectPins(
  rootReal: string,
  home: string,
): Promise<{ servers: PinnedServer[]; sources: string[]; errors: string[] }> {
  const servers: PinnedServer[] = [];
  const sources: string[] = [];
  const errors: string[] = [];
  for (const [source, file] of mcpConfigCandidates(rootReal, home)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${source}: unreadable`);
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(stripJsonc(text.replace(/^\uFEFF/, "")));
    } catch {
      errors.push(`${source}: not valid JSON`);
      continue;
    }
    sources.push(source);
    if (!isRecord(doc)) continue;
    for (const key of ["servers", "mcpServers"]) {
      const block = doc[key];
      if (!isRecord(block)) continue;
      for (const name of Object.keys(block).sort()) {
        const entry = block[name];
        if (!isRecord(entry)) continue;
        const shape = serverShape(entry);
        servers.push({ key: `${source}#${name}`, source, name, pin: pinOf(shape), shape });
      }
    }
  }
  servers.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { servers, sources, errors };
}

export function toPinsFile(servers: readonly PinnedServer[]): PinsFile {
  const out: PinsFile = { v: 1, servers: {} };
  for (const s of servers) out.servers[s.key] = { source: s.source, name: s.name, pin: s.pin };
  return out;
}

export function diffPins(saved: PinsFile, current: PinsFile): PinDiff {
  const a = saved.servers;
  const b = current.servers;
  const sort = (x: string[]) => x.sort();
  return {
    added: sort(Object.keys(b).filter((k) => a[k] === undefined)),
    removed: sort(Object.keys(a).filter((k) => b[k] === undefined)),
    changed: sort(Object.keys(b).filter((k) => a[k] !== undefined && a[k]?.pin !== b[k]?.pin)),
  };
}

async function readPinsFile(rootReal: string): Promise<PinsFile | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(rootReal, MCP_PINS_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.servers)) return undefined;
  const out: PinsFile = { v: 1, servers: {} };
  for (const [k, v] of Object.entries(raw.servers)) {
    if (isRecord(v) && typeof v.pin === "string") {
      out.servers[k] = {
        source: typeof v.source === "string" ? v.source : "",
        name: typeof v.name === "string" ? v.name : k,
        pin: v.pin,
      };
    }
  }
  return out;
}

async function writePinsFile(rootReal: string, pins: PinsFile): Promise<string> {
  const file = path.join(rootReal, MCP_PINS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return file;
}

function defaultHome(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

/** `axiom pin [--root <dir>] [--check] [--json]`. Exit 0 ok/unchanged, 1 changed or error, 2 usage. */
export async function pinMain(argv: readonly string[], io: PinIo): Promise<number> {
  let values: { root?: string; check?: boolean; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        check: { type: "boolean" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.stderr(`axiom pin: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  try {
    const cwd = io.cwd ?? process.cwd();
    const policy = await createRootsPolicy([path.resolve(cwd, values.root ?? ".")]);
    const { rootReal } = await resolveRoot(policy);
    const { servers, sources, errors } = await collectPins(rootReal, io.home ?? defaultHome());
    for (const e of errors) io.stderr(`axiom pin: ${e}`);
    const current = toPinsFile(servers);
    if (values.check !== true) {
      const file = await writePinsFile(rootReal, current);
      if (values.json === true) io.stdout(JSON.stringify({ file, sources, servers }, null, 2));
      else {
        io.stdout(
          `axiom pin: ${servers.length} server(s) from ${sources.length} config(s) -> ${file}`,
        );
        for (const s of servers) io.stdout(`  ${s.key} ${s.pin.slice(0, 19)}`);
      }
      return errors.length > 0 ? 1 : 0;
    }
    const saved = await readPinsFile(rootReal);
    if (saved === undefined) {
      io.stderr(`axiom pin: no ${MCP_PINS_FILE} (or unreadable) - run \`axiom pin\` first`);
      return 1;
    }
    const diff = diffPins(saved, current);
    const changed = diff.added.length + diff.removed.length + diff.changed.length > 0;
    if (values.json === true) io.stdout(JSON.stringify({ ok: !changed, ...diff }, null, 2));
    else if (!changed) io.stdout(`axiom pin: ${servers.length} server(s) match the pins`);
    else {
      for (const k of diff.added) io.stdout(`ADDED   ${k}`);
      for (const k of diff.removed) io.stdout(`REMOVED ${k}`);
      for (const k of diff.changed) io.stdout(`CHANGED ${k}`);
      io.stdout("axiom pin: MCP server config changed - review it, then re-run `axiom pin`");
    }
    return changed || errors.length > 0 ? 1 : 0;
  } catch (err) {
    const code = isAxiomError(err) ? err.code : "ERR_INTERNAL";
    io.stderr(`axiom pin: ${code}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
