/**
 * `axiom init` (S-701): wire a repository for AXIOM in one idempotent step — MCP server entry,
 * PreToolUse hook(s) for the detected harness(es), a repo profile extending `default`, a gate
 * profile and the `.gitignore` lines that keep `.axiom/` state out of git while committing the
 * two policy files. Every write goes through `resolveContained` (no symlink/junction segment, no
 * escape) + `writeAtomic`; an existing file is never overwritten without `force`.
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { resolveContained, writeAtomic } from "@codai/axiom-apply";
import { AxiomError, ProfileNameSchema } from "@codai/axiom-schema";

export const HARNESSES = ["copilot", "claude", "codex", "vscode"] as const;
export type HarnessName = (typeof HARNESSES)[number];
export type HarnessArg = HarnessName | "auto";

export function isHarnessArg(v: string): v is HarnessArg {
  return v === "auto" || (HARNESSES as readonly string[]).includes(v);
}

export type InitAction = "created" | "merged" | "updated" | "skipped";

export interface InitFileResult {
  /** Root-relative POSIX path. */
  path: string;
  action: InitAction;
  /** Why a file was skipped (exists / already configured / unparseable). */
  reason?: string;
}

export interface InitResult {
  root: string;
  harnesses: HarnessName[];
  profile: string;
  files: InitFileResult[];
  notes: string[];
}

export interface InitOptions {
  /** realpath'd root (the only directory init writes under). */
  root: string;
  harness?: HarnessArg;
  profileName?: string;
  force?: boolean;
}

/** Root-relative files `init` owns (doctor reads the same list). */
export const INIT_FILES = {
  mcp: ".vscode/mcp.json",
  copilotHook: ".github/hooks/axiom-gate.json",
  claudeSettings: ".claude/settings.json",
  gateProfile: ".axiom/gate-profile.json",
  gitignore: ".gitignore",
} as const;

export const GITIGNORE_LINES = [".axiom/*", "!.axiom/profiles/", "!.axiom/gate-profile.json"];

/** Global bin, never `npx` — `npx` resolution alone exceeds every harness hook timeout (hooks.md). */
export const COPILOT_HOOK = {
  version: 1,
  hooks: {
    preToolUse: [{ type: "command", exec: "axiom", args: ["gate", "--stdin"], timeoutSec: 5 }],
  },
};

export const CLAUDE_HOOK_ENTRY = {
  matcher: "Write|Edit|MultiEdit|NotebookEdit",
  hooks: [{ type: "command", command: "axiom gate --stdin", timeout: 5 }],
};

export const MCP_SERVER_ENTRY = {
  type: "stdio",
  command: "npx",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code substitutes ${workspaceFolder} itself.
  args: ["-y", "@codai/axiom-mcp@2", "mcp", "--root", "${workspaceFolder}"],
};

const BUILTIN_PROFILE_NAMES = new Set(["default", "strict", "permissive"]);

/** Repo directory name → a valid, non-builtin profile name (`^[a-z0-9][a-z0-9._-]{0,63}$`). */
export function profileNameFor(dir: string): string {
  let n = path
    .basename(dir)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  if (n === "") n = "repo";
  // A repo profile named like a builtin would `extends` itself (cycle).
  if (BUILTIN_PROFILE_NAMES.has(n)) n = `${n}-repo`;
  return n;
}

export function repoProfile(name: string): Record<string, unknown> {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Profile",
    name,
    extends: "default",
    facts: { allowRepo: true, allowGuards: false },
    checks: [
      {
        id: "repo.noOverwriteOf",
        predicate: "repo.noOverwriteOf",
        params: {
          globs: [
            ".git/**",
            ".axiom/**",
            ".github/**",
            "pnpm-lock.yaml",
            "**/*.lock",
            ".env*",
            "**/.env*",
          ],
        },
      },
      { id: "content.noSecrets", predicate: "content.noSecrets", params: {} },
      {
        id: "path.deny",
        predicate: "path.deny",
        params: { globs: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/.turbo/**"] },
      },
    ],
  };
}

export const GATE_PROFILE = {
  deny: [
    ".git/**",
    ".axiom/**",
    ".github/**",
    "pnpm-lock.yaml",
    "**/*.lock",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
  ],
  noSecrets: true,
  pii: false,
  maxBytes: 262144,
};

async function readOrUndefined(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function exists(root: string, rel: string): Promise<boolean> {
  return stat(path.join(root, rel)).then(
    () => true,
    () => false,
  );
}

/** `auto`: one harness per marker dir present; none → copilot + vscode. */
export async function detectHarnesses(
  root: string,
  arg: HarnessArg = "auto",
): Promise<HarnessName[]> {
  if (arg !== "auto") return [arg];
  const isDir = (rel: string) =>
    stat(path.join(root, rel)).then(
      (s) => s.isDirectory(),
      () => false,
    );
  const found: HarnessName[] = [];
  if (await isDir(".github")) found.push("copilot");
  if (await isDir(".claude")) found.push("claude");
  if (await isDir(".codex")) found.push("codex");
  if (await isDir(".vscode")) found.push("vscode");
  return found.length === 0 ? ["copilot", "vscode"] : found;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

class Writer {
  readonly files: InitFileResult[] = [];
  private readonly root: string;
  private readonly force: boolean;
  constructor(root: string, force: boolean) {
    this.root = root;
    this.force = force;
  }

  private async write(rel: string, text: string): Promise<void> {
    // Contained: rejects a symlink/junction segment (ERR_SYMLINK_IN_PATH) or an escape.
    const { abs } = await resolveContained(this.root, rel);
    await writeAtomic(abs, new TextEncoder().encode(text));
  }

  private record(rel: string, action: InitAction, reason?: string): void {
    this.files.push(reason === undefined ? { path: rel, action } : { path: rel, action, reason });
  }

  /** Whole-file ownership: create, or `updated` with `force`, else `skipped (exists)`. */
  async owned(rel: string, text: string): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current === undefined) {
      await this.write(rel, text);
      this.record(rel, "created");
    } else if (current === text) {
      this.record(rel, "skipped", "up to date");
    } else if (this.force) {
      await this.write(rel, text);
      this.record(rel, "updated");
    } else {
      this.record(rel, "skipped", "exists");
    }
  }

  /**
   * Shared JSON file: `edit(doc)` returns "present" (our entry is already there), or mutates
   * `doc` and returns "added" / "replaced". Replacement only happens with `force`.
   */
  async mergeJson(
    rel: string,
    fresh: () => Record<string, unknown>,
    edit: (doc: Record<string, unknown>, force: boolean) => "present" | "added" | "replaced",
  ): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    if (current === undefined) {
      await this.write(rel, json(fresh()));
      this.record(rel, "created");
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(current);
    } catch {
      // JSONC (comments) or broken JSON: never rewrite a file we cannot round-trip.
      this.record(rel, "skipped", "not plain JSON; add the entry by hand");
      return;
    }
    if (!isRecord(doc)) {
      this.record(rel, "skipped", "top level is not an object");
      return;
    }
    const r = edit(doc, this.force);
    if (r === "present") {
      this.record(rel, "skipped", "already configured");
      return;
    }
    await this.write(rel, json(doc));
    this.record(rel, r === "added" ? "merged" : "updated");
  }

  async appendLines(rel: string, lines: readonly string[]): Promise<void> {
    await resolveContained(this.root, rel);
    const current = await readOrUndefined(path.join(this.root, rel));
    const have = new Set((current ?? "").split(/\r?\n/).map((l) => l.trim()));
    const missing = lines.filter((l) => !have.has(l));
    if (missing.length === 0) {
      this.record(rel, "skipped", "already present");
      return;
    }
    const eol = current?.includes("\r\n") ? "\r\n" : "\n";
    const prefix =
      current === undefined || current === ""
        ? ""
        : current.endsWith("\n")
          ? current
          : current + eol;
    await this.write(rel, `${prefix}${missing.join(eol)}${eol}`);
    this.record(rel, current === undefined ? "created" : "updated");
  }
}

function mergeMcp(doc: Record<string, unknown>, force: boolean): "present" | "added" | "replaced" {
  const servers = isRecord(doc.servers) ? doc.servers : {};
  doc.servers = servers;
  if (servers.axiom !== undefined && !force) return "present";
  const had = servers.axiom !== undefined;
  servers.axiom = MCP_SERVER_ENTRY;
  return had ? "replaced" : "added";
}

function isAxiomGateEntry(v: unknown): boolean {
  if (!isRecord(v) || !Array.isArray(v.hooks)) return false;
  return v.hooks.some(
    (h) => isRecord(h) && typeof h.command === "string" && /\baxiom\b.*\bgate\b/.test(h.command),
  );
}

function mergeClaude(
  doc: Record<string, unknown>,
  force: boolean,
): "present" | "added" | "replaced" {
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};
  doc.hooks = hooks;
  const list = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  hooks.PreToolUse = list;
  const i = list.findIndex(isAxiomGateEntry);
  if (i >= 0 && !force) return "present";
  if (i >= 0) {
    list[i] = CLAUDE_HOOK_ENTRY;
    return "replaced";
  }
  list.push(CLAUDE_HOOK_ENTRY);
  return "added";
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const root = opts.root;
  const harnesses = await detectHarnesses(root, opts.harness ?? "auto");
  const profile = opts.profileName ?? profileNameFor(root);
  if (!ProfileNameSchema.safeParse(profile).success || BUILTIN_PROFILE_NAMES.has(profile)) {
    throw new AxiomError(
      "ERR_INVALID_PROFILE",
      `profile name must match ^[a-z0-9][a-z0-9._-]{0,63}$ and not be a builtin: ${profile}`,
      { details: { profile } },
    );
  }
  const w = new Writer(root, opts.force === true);
  const notes: string[] = [];

  await w.mergeJson(INIT_FILES.mcp, () => ({ servers: { axiom: MCP_SERVER_ENTRY } }), mergeMcp);
  if (harnesses.includes("copilot") || harnesses.includes("vscode")) {
    await w.owned(INIT_FILES.copilotHook, json(COPILOT_HOOK));
  }
  if (harnesses.includes("claude")) {
    await w.mergeJson(
      INIT_FILES.claudeSettings,
      () => ({ hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] } }),
      mergeClaude,
    );
  }
  if (harnesses.includes("codex")) {
    notes.push(
      "codex: no PreToolUse hook API — add [mcp_servers.axiom] to ~/.codex/config.toml and route writes through axiom_apply (docs/integration/harnesses.md#codex)",
    );
  }
  await w.owned(`.axiom/profiles/${profile}.json`, json(repoProfile(profile)));
  await w.owned(INIT_FILES.gateProfile, json(GATE_PROFILE));
  await w.appendLines(INIT_FILES.gitignore, GITIGNORE_LINES);
  if (!(await exists(root, ".git")))
    notes.push("no .git here: root discovery in the gate uses cwd");
  notes.push("hooks call the global bin: npm install -g @codai/axiom-mcp (never npx in a hook)");
  return { root, harnesses, profile, files: w.files, notes };
}
