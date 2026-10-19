#!/usr/bin/env node
/**
 * gen-cli-doc - regenerate the command sections of docs/reference/cli.md from the CLI command
 * table (D-43, `packages/mcp/src/cli-commands.ts`, read from the built `dist/cli-main.js`).
 *
 * Everything above `<!-- cli:generated -->` is hand-written and kept verbatim. Below it, every
 * section is generated; the hand-written prose of a command lives in its
 * `<!-- notes:<command> -->` ... `<!-- /notes -->` block and survives regeneration.
 *
 * Usage: pnpm --filter @codai/axiom-mcp run build && node scripts/gen-cli-doc.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./_guard-lib.mjs";

export const CLI_DOC = join(REPO_ROOT, "docs", "reference", "cli.md");
export const CLI_MAIN = join(REPO_ROOT, "packages", "mcp", "dist", "cli-main.js");

/** The expected cli.md text for the current table, given the current file. */
export async function expectedCliDoc(current) {
  const { CLI_DOC_MARKER, extractNotes, renderCliMarkdown } = await import(
    pathToFileURL(CLI_MAIN).href
  );
  const text = current.replaceAll("\r\n", "\n");
  const at = text.indexOf(CLI_DOC_MARKER);
  if (at === -1) throw new Error(`docs/reference/cli.md has no ${CLI_DOC_MARKER} marker`);
  const head = text.slice(0, at + CLI_DOC_MARKER.length);
  const notes = extractNotes(text.slice(at));
  return `${head}\n\n${renderCliMarkdown(notes)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const current = readFileSync(CLI_DOC, "utf8");
  const next = await expectedCliDoc(current);
  if (next === current.replaceAll("\r\n", "\n")) {
    console.log("docs/reference/cli.md is up to date");
  } else {
    writeFileSync(CLI_DOC, next, "utf8");
    console.log("docs/reference/cli.md regenerated");
  }
}
