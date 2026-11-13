/**
 * Where the native hook client (`axiom-hook`) lives (4.0, D-51 / S-1412).
 *
 * Reality check #2: `setup init --daemon` wrote hooks that call a bare `axiom-hook`, which an
 * npm install never puts on PATH — every tool call was then denied or failed open, and doctor
 * stayed green. Init and doctor now ask this module for a command that resolves, and run its
 * self-test before they wire or report it.
 */
export interface HookBin {
  /** Absolute path of the executable (or of the launcher script). */
  path: string;
  /** `native` = the Rust client; `node` = `axiom gate` through node (always available). */
  kind: "native" | "node";
  version?: string;
}

export interface HookSelfTest {
  ok: boolean;
  /** Wall time of one allow decision through the wired command, in ms. */
  ms?: number;
  /** Why it failed (`not-found`, `spawn-failed`, `bad-verdict`, `timeout`). */
  reason?: string;
}

/** The native hook client for this install, or `undefined` when none is usable. */
export async function resolveHookBin(): Promise<HookBin | undefined> {
  return undefined;
}

/** Run one canned allow and one canned deny through `bin` and compare with the in-process gate. */
export async function selfTestHook(_bin: HookBin): Promise<HookSelfTest> {
  return { ok: false, reason: "not-found" };
}
