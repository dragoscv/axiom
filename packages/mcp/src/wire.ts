/**
 * `--wire` (D-19) — SDK-free so `cli-main.ts` can print help and validate the flag without
 * loading `@modelcontextprotocol/server` (the eager bundle budget).
 *
 * - `2026`      — 2026-07-28 wire, AND 2025-era clients served from the same entry (default).
 * - `2025`      — same serving; documents that the deployment expects legacy clients.
 * - `2026-only` — refuse 2025-era openings with the unsupported-protocol-version error.
 */
export const WIRE_MODES = ["2026", "2025", "2026-only"] as const;
export type WireMode = (typeof WIRE_MODES)[number];
export function isWireMode(v: string): v is WireMode {
  return (WIRE_MODES as readonly string[]).includes(v);
}
