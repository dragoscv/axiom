/**
 * Template sources (v2.1, D-13). An *emitter* is a versioned bag of small, pure,
 * deterministic file templates. The compiler never ships one — the caller injects an
 * `EmitterRegistry` (`compilePlan(plan, { emitters })`); `@codai/axiom-emitters-web`
 * is the reference implementation. The emitter version is recorded in
 * `manifest.toolchain.emitters[<id>]`, so bumping it changes the manifest digest.
 */

/** Structural subset of `z.ZodType.safeParse` — keeps `plan` free of a zod dependency. */
export interface ParamsSchema<T = unknown> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } };
}

export interface TemplateDef<T = unknown> {
  /** Zod schema (or anything with the same `safeParse`) validating `source.params`. */
  params: ParamsSchema<T>;
  /** Pure function: same params → identical output. No clock, no randomness, no I/O. */
  render(params: T): string | Uint8Array;
  description: string;
}

export interface TemplateEmitter {
  /** Matches `source.emitter`; `^[a-z][a-z0-9-]*$` recommended. */
  id: string;
  /** SemVer; part of the manifest digest via `toolchain.emitters`. */
  version: string;
  /** Keyed by `source.template`, e.g. `next.route-handler`. */
  templates: Record<string, TemplateDef>;
}

export interface EmitterRegistry {
  get(id: string): TemplateEmitter | undefined;
  list(): string[];
}

export function createEmitterRegistry(emitters: readonly TemplateEmitter[]): EmitterRegistry {
  const byId = new Map<string, TemplateEmitter>();
  for (const e of emitters) {
    if (byId.has(e.id)) throw new Error(`duplicate emitter id: ${e.id}`);
    byId.set(e.id, e);
  }
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.keys()].sort(),
  };
}
