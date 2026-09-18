import { z } from "zod";
import { toolJsonSchema } from "./jsonschema.js";
import { TOOL_DEFS } from "./tools.js";

/** One entry of `spec/tools.json` — the codai agent-core tool manifest shape. */
export interface ToolSpecEntry {
  name: string;
  description: string;
  riskClass: "READ" | "ACT" | "SENSITIVE";
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export function buildToolsSpec(): ToolSpecEntry[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    riskClass: t.riskClass,
    annotations: t.annotations,
    inputSchema: toolJsonSchema(z.object(t.inputSchema)),
    outputSchema: toolJsonSchema(t.outputSchema),
  }));
}

/** Stable text form (2-space JSON + trailing newline) used both by the generator and the parity test. */
export function renderToolsSpec(): string {
  return `${JSON.stringify(buildToolsSpec(), null, 2)}\n`;
}
