import { TEMPLATES } from "./templates.js";
import type { TemplateEmitter } from "./types.js";
import { WEB_EMITTER_VERSION } from "./version.js";

export { generatedBanner, WEB_EMITTER_VERSION } from "./version.js";

/** The `web` emitter: pass it to `createEmitterRegistry([webEmitter])` from `@codai/axiom-plan`. */
export const webEmitter: TemplateEmitter = {
  id: "web",
  version: WEB_EMITTER_VERSION,
  templates: TEMPLATES,
};

/** What `axiom … --emitter @codai/axiom-emitters-web` registers (the CLI reads `emitters`). */
export const emitters: readonly TemplateEmitter[] = [webEmitter];

/** `[name, description]` pairs, sorted by name — for `axiom emitters` and docs. */
export function listTemplates(emitter: TemplateEmitter = webEmitter): [string, string][] {
  return Object.keys(emitter.templates)
    .sort()
    .map((k) => [k, emitter.templates[k]?.description ?? ""]);
}

export { TEMPLATES } from "./templates.js";
export { defineTemplate, type TemplateDef, type TemplateEmitter } from "./types.js";
