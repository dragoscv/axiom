/**
 * The deny contract is ONE table (`GATE_FORMAT_TABLE`), rendered for three consumers: the gate
 * (`renderDeny`), the daemon client (which calls `renderDeny`) and the native Rust client
 * (`crates/axiom-hook`, generated from this file). Reality check #2 found three copies that had
 * drifted: the Rust one had no `kiro` case (Kiro reads exit 0 as an allow, A3-5/A2-19) and the
 * daemon client's private copy had neither `kiro` nor the `axiom` block of the `auto` document.
 *
 * This file is the guard the generator's docs promise: it regenerates `deny_table.rs` in-process
 * and compares it with the committed file, so CI fails on drift even when nobody runs the script.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAEMON_AUTH_CODE, daemonAuthDeny } from "./daemon-client.js";
import { GATE_FORMATS } from "./gate-fast.js";
import {
  ASK_FORMATS,
  DENY_PARITY_CODE,
  DENY_PARITY_REASON,
  GATE_FORMAT_TABLE,
  GateDeny,
  renderDeny,
  renderDenyTableRust,
} from "./gate-format.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const DENY_TABLE_RS = join(REPO, "crates", "axiom-hook", "src", "deny_table.rs");
const MAIN_RS = join(REPO, "crates", "axiom-hook", "src", "main.rs");

describe("the per-format deny table (S-1412)", () => {
  it("has a row for every --format and no other", () => {
    expect(Object.keys(GATE_FORMAT_TABLE).sort()).toEqual([...GATE_FORMATS].sort());
  });

  it("agrees with ASK_FORMATS on who can hand the decision to the human", () => {
    expect([...ASK_FORMATS].sort()).toEqual(
      GATE_FORMATS.filter((f) => GATE_FORMAT_TABLE[f].ask).sort(),
    );
  });

  it("renders the committed native table byte for byte (drift guard)", () => {
    // `scripts/gen-deny-table.mjs` writes this file; regenerating it here means a change to
    // GATE_FORMAT_TABLE that nobody propagated to Rust fails in CI, not in the field.
    const committed = readFileSync(DENY_TABLE_RS, "utf8").replaceAll("\r\n", "\n");
    expect(renderDenyTableRust()).toBe(committed);
  });

  it("has the native table registered as a module (otherwise the crate cannot build)", () => {
    // The generator wrote `deny_table.rs` and `deny.rs` imported it, but `mod deny_table;` was
    // missing from main.rs, so `cargo test` failed to compile the whole crate.
    expect(readFileSync(MAIN_RS, "utf8")).toMatch(/^mod deny_table;$/m);
  });

  it("keeps the parity goldens complete and well formed", () => {
    expect(renderDenyTableRust()).toContain(
      `pub const PARITY_CODE: &str = ${JSON.stringify(DENY_PARITY_CODE)};`,
    );
    expect(renderDenyTableRust()).toContain(
      `pub const PARITY_REASON: &str = ${JSON.stringify(DENY_PARITY_REASON)};`,
    );
    for (const format of GATE_FORMATS) {
      const r = renderDeny(
        format,
        new GateDeny(DENY_PARITY_CODE, DENY_PARITY_REASON),
        DENY_PARITY_REASON,
        {},
      );
      if (r.stdout === undefined) {
        // Exit-code-only harnesses: the goldens must say `None`, never an empty string.
        expect(renderDenyTableRust()).toContain(`("${format}", None,`);
        continue;
      }
      // Every other document must be valid JSON that carries the reason the agent will read.
      expect(() => JSON.parse(r.stdout as string), format).not.toThrow();
      expect(r.stdout).toContain(DENY_PARITY_REASON);
    }
  });

  it("renders Kiro as exit 2 with no stdout (the harness reads nothing else)", () => {
    const r = renderDeny("kiro", new GateDeny("ERR_INTERNAL", "x"), "x", {});
    expect(r).toEqual({ stdout: undefined, exitCode: 2 });
    expect(GATE_FORMAT_TABLE.kiro.document).toBe("none");
  });

  it("lets --deny-exit 2 override the default for a document format", () => {
    const d = new GateDeny("ERR_INTERNAL", "x");
    expect(renderDeny("claude", d, "x", {}).exitCode).toBe(0);
    expect(renderDeny("claude", d, "x", { denyExit: 2 }).exitCode).toBe(2);
  });

  it("documents every format in one sentence", () => {
    for (const format of GATE_FORMATS) {
      // The note is emitted into the Rust table, so it is the only place a maintainer reads why
      // a harness gets the document it gets.
      const note = GATE_FORMAT_TABLE[format].note;
      expect(note.length, format).toBeGreaterThan(20);
      expect(renderDenyTableRust(), format).toContain(JSON.stringify(note).slice(1, -1));
    }
  });
});

describe("the daemon client's fail-closed deny uses that same table (A2-19)", () => {
  it("matches renderDeny for every format, including kiro", () => {
    for (const format of GATE_FORMATS) {
      const a = daemonAuthDeny(["--stdin", "--format", format]);
      const b = renderDeny(
        format,
        new GateDeny(DAEMON_AUTH_CODE, a.stderr[0]?.slice(a.stderr[0].indexOf(":") + 2) ?? ""),
        a.stderr[0]?.slice(a.stderr[0].indexOf(":") + 2) ?? "",
        {},
      );
      expect(a.stdout, `${format}: stdout`).toBe(b.stdout ?? "");
      expect(a.exitCode, `${format}: exit`).toBe(b.exitCode);
    }
  });

  it("denies Kiro with exit 2 and empty stdout instead of printing a document", () => {
    const v = daemonAuthDeny(["--stdin", "--format", "kiro"]);
    expect(v.exitCode).toBe(2);
    expect(v.stdout).toBe("");
  });

  it("carries the machine-readable code in the auto document", () => {
    const v = daemonAuthDeny(["--stdin"]);
    expect(JSON.parse(v.stdout)).toMatchObject({
      axiom: { verdict: "deny", code: DAEMON_AUTH_CODE },
      permissionDecision: "deny",
    });
  });

  it("honours --deny-exit 2", () => {
    expect(daemonAuthDeny(["--stdin", "--deny-exit", "2"]).exitCode).toBe(2);
    expect(daemonAuthDeny(["--stdin", "--deny-exit=2"]).exitCode).toBe(2);
  });
});
