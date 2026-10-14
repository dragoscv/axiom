/**
 * Doctor helper (S-1206): finds harness settings that would answer AXIOM's human-confirmation
 * elicitation WITHOUT a human — a Claude Code `Elicitation` / `ElicitationResult` hook (either can
 * return `action: "accept"` with content, so the dialog never appears or the answer is rewritten)
 * and VS Code's global tool auto-approve. Read-only; missing files are not findings.
 *
 * Hook event names verified against https://code.claude.com/docs/en/hooks (2026-10-14):
 * `Elicitation` fires when an MCP server requests user input during a tool call;
 * `ElicitationResult` after the user answers, before the response is sent back. Both accept
 * `command`, `http` and `mcp_tool` handlers and honour `hookSpecificOutput.action`.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { stripJsonc } from "./doctor.js";

export interface ElicitAuditFinding {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
}

/** Claude Code hook events that can answer or rewrite an elicitation. */
export const ELICITATION_HOOK_EVENTS = ["Elicitation", "ElicitationResult"] as const;
/** VS Code settings that auto-approve every tool call (including `axiom_apply`). */
export const VSCODE_AUTO_APPROVE_KEYS = ["chat.tools.global.autoApprove", "chat.tools.autoApprove"];

const ACCEPT_RE = /\baccept\b/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJsonc(abs: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(stripJsonc(text)) as unknown;
  } catch {
    return undefined;
  }
}

interface HookHit {
  file: string;
  event: string;
  type: string;
  printsAccept: boolean;
}

function hookHits(file: string, doc: unknown): HookHit[] {
  if (!isRecord(doc) || !isRecord(doc.hooks)) return [];
  const hits: HookHit[] = [];
  for (const event of ELICITATION_HOOK_EVENTS) {
    const groups = doc.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of handlers) {
        if (!isRecord(h)) continue;
        const type = typeof h.type === "string" ? h.type : "command";
        const text = JSON.stringify([h.command, h.args, h.input, h.url] as unknown[]);
        hits.push({ file, event, type, printsAccept: ACCEPT_RE.test(text) });
      }
    }
  }
  return hits;
}

/**
 * Audit `<root>/.claude/settings.json`, `<root>/.claude/settings.local.json`,
 * `<home>/.claude/settings.json` and `<root>/.vscode/settings.json`. No findings → `[]`.
 */
export async function auditElicitationHooks(
  root: string,
  home: string,
): Promise<ElicitAuditFinding[]> {
  const claudeFiles = [
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
    path.join(home, ".claude", "settings.json"),
  ];
  const hits: HookHit[] = [];
  for (const file of claudeFiles) hits.push(...hookHits(file, await readJsonc(file)));

  const findings: ElicitAuditFinding[] = [];
  if (hits.length > 0) {
    const where = [...new Set(hits.map((x) => `${x.event} in ${x.file}`))].join("; ");
    const accept = hits.some((x) => x.printsAccept);
    findings.push({
      id: "elicitation.autoAnswer",
      status: "fail",
      message: `${hits.length} Claude Code elicitation hook(s) can answer AXIOM's human confirmation without a human${accept ? " (one prints an accept action)" : ""}: ${where}`,
      hint: 'Remove the Elicitation/ElicitationResult hooks (or scope their matcher away from the axiom server); a hook that returns action "accept" turns the human-only confirm step back into an agent echo.',
    });
  }

  const vscode = await readJsonc(path.join(root, ".vscode", "settings.json"));
  if (isRecord(vscode)) {
    const on = VSCODE_AUTO_APPROVE_KEYS.filter((k) => vscode[k] === true);
    if (on.length > 0) {
      findings.push({
        id: "elicitation.autoApprove",
        status: "warn",
        message: `${on.join(", ")} = true in .vscode/settings.json: VS Code runs axiom_apply / axiom_write without asking`,
        hint: "Set it to false (or remove it); keep per-tool approval so the human confirms destructive AXIOM calls.",
      });
    }
  }
  return findings;
}
