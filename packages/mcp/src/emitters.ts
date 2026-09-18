import { webEmitter } from "@codai/axiom-emitters-web";
import { createEmitterRegistry, type EmitterRegistry } from "@codai/axiom-plan";

/** Template emitters available to `axiom_plan_compile` / `axiom compile` (D-13: optional sugar). */
export const EMITTERS: EmitterRegistry = createEmitterRegistry([webEmitter]);

export interface EmitterRow {
  emitter: string;
  version: string;
  template: string;
  description: string;
}

/** Flat, sorted `emitter@version: template — description` rows for the CLI and the resource. */
export function emitterCatalogue(registry: EmitterRegistry = EMITTERS): EmitterRow[] {
  const rows: EmitterRow[] = [];
  for (const id of registry.list()) {
    const e = registry.get(id);
    if (e === undefined) continue;
    for (const template of Object.keys(e.templates).sort()) {
      rows.push({
        emitter: e.id,
        version: e.version,
        template,
        description: e.templates[template]?.description ?? "",
      });
    }
  }
  return rows;
}
