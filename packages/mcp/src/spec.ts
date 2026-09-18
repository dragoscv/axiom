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

/**
 * One entry of `spec/codai-tools.json` — the exact shape of an entry in codai's
 * `packages/agent-core/spec/tools-v2.json` (`{ name, risk, description, parameters }`),
 * so codai's harness can register AXIOM's MCP tools under its `APPROVAL_MATRIX` by `risk`.
 * `parameters` is the MCP `inputSchema` minus the `$schema` marker (codai entries carry none).
 */
export interface CodaiToolSpecEntry {
  name: string;
  risk: "READ" | "ACT" | "SENSITIVE";
  description: string;
  parameters: Record<string, unknown>;
}

export interface CodaiToolsSpec {
  version: string;
  description: string;
  tools: CodaiToolSpecEntry[];
}

export function buildCodaiToolsSpec(): CodaiToolsSpec {
  return {
    version: "2.0.0",
    description:
      "AXIOM MCP tools in the shape of codai packages/agent-core/spec/tools-v2.json entries. GENERATED from packages/mcp/src/tools.ts by `pnpm --filter @codai/axiom-mcp build:spec` — do not edit. `risk` is derived from the MCP annotations (readOnlyHint → READ, destructiveHint → SENSITIVE, else ACT). Serve via `npx @codai/axiom-mcp mcp --root <dir>`; see docs/integration/codai.md.",
    tools: buildToolsSpec().map((t) => {
      const { $schema: _, ...parameters } = t.inputSchema;
      return { name: t.name, risk: t.riskClass, description: t.description, parameters };
    }),
  };
}

/** Stable text form of `spec/codai-tools.json`. */
export function renderCodaiToolsSpec(): string {
  return `${JSON.stringify(buildCodaiToolsSpec(), null, 2)}\n`;
}
