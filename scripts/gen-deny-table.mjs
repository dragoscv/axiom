#!/usr/bin/env node
/**
 * gen-deny-table - regenerate `crates/axiom-hook/src/deny_table.rs` from the ONE per-format
 * deny table in `packages/mcp/src/gate-format.ts` (`GATE_FORMAT_TABLE`), so the native client
 * and the gate can no longer drift (A3-5/A2-19: the Rust copy had no `kiro` case and its Claude
 * document carried keys Claude rejects).
 *
 * The Rust table is not hand-written anywhere: this script is the only writer of
 * `deny_table.rs`, and `packages/mcp/src/gate-format.test.ts` regenerates the same text
 * in-process and compares it with the committed file, so CI fails on drift even when nobody
 * runs this script.
 *
 * Usage:
 *   node scripts/gen-deny-table.mjs           # write the file
 *   node scripts/gen-deny-table.mjs --check   # exit 3 when the file is out of date
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { REPO_ROOT } from "./_guard-lib.mjs";

export const DENY_TABLE_RS = join(REPO_ROOT, "crates", "axiom-hook", "src", "deny_table.rs");
const GATE_FORMAT_TS = join(REPO_ROOT, "packages", "mcp", "src", "gate-format.ts");

/** The expected Rust text for the current table (imports the TS source through tsx). */
export async function expectedDenyTable() {
  const unregister = register();
  try {
    const mod = await import(pathToFileURL(GATE_FORMAT_TS).href);
    if (typeof mod.renderDenyTableRust !== "function") {
      throw new Error("packages/mcp/src/gate-format.ts must export renderDenyTableRust()");
    }
    return mod.renderDenyTableRust();
  } finally {
    unregister();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const next = await expectedDenyTable();
  let current = "";
  try {
    current = readFileSync(DENY_TABLE_RS, "utf8").replaceAll("\r\n", "\n");
  } catch {
    current = "";
  }
  if (next === current) {
    console.log("crates/axiom-hook/src/deny_table.rs is up to date");
  } else if (process.argv.includes("--check")) {
    console.error("ERROR crates/axiom-hook/src/deny_table.rs is out of date");
    console.error("      run: node scripts/gen-deny-table.mjs");
    process.exit(3);
  } else {
    writeFileSync(DENY_TABLE_RS, next, "utf8");
    console.log("crates/axiom-hook/src/deny_table.rs regenerated");
  }
}
