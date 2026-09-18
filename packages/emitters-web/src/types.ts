import type { z } from "zod";

/**
 * Structural twins of `TemplateEmitter` / `TemplateDef` in `@codai/axiom-plan`.
 * Declared here so this package depends on nothing but zod; `compilePlan` accepts
 * them because it only needs `params.safeParse` and `render`.
 */
export interface TemplateDef<S extends z.ZodType = z.ZodType> {
  params: S;
  render(params: z.output<S>): string;
  description: string;
}

export interface TemplateEmitter {
  id: string;
  version: string;
  templates: Record<string, TemplateDef>;
}

export function defineTemplate<S extends z.ZodType>(
  description: string,
  params: S,
  render: (p: z.output<S>) => string,
): TemplateDef<S> {
  return { description, params, render };
}
