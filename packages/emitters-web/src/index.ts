import { TEMPLATES } from "./templates.js";
import type { TemplateEmitter } from "./types.js";

/** Bumped whenever any template's output changes — it is part of every manifest digest. */
export const WEB_EMITTER_VERSION = "2.0.0";

/** The `web` emitter: pass it to `createEmitterRegistry([webEmitter])` from `@codai/axiom-plan`. */
export const webEmitter: TemplateEmitter = {
  id: "web",
  version: WEB_EMITTER_VERSION,
  templates: TEMPLATES,
};

/** `[name, description]` pairs, sorted by name — for `axiom emitters` and docs. */
export function listTemplates(emitter: TemplateEmitter = webEmitter): [string, string][] {
  return Object.keys(emitter.templates)
    .sort()
    .map((k) => [k, emitter.templates[k]?.description ?? ""]);
}

export { TEMPLATES } from "./templates.js";
export { defineTemplate, type TemplateDef, type TemplateEmitter } from "./types.js";
