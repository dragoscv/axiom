#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { parseAxiomSource } from "@codai/axiom-core/dist/parser.js";
import { validateIR } from "@codai/axiom-core/dist/validator.js";
import { AxiomIR } from "@codai/axiom-core/dist/ir.js";
import { generate } from "@codai/axiom-engine/dist/generate.js";
import { check } from "@codai/axiom-engine/dist/check.js";
import { reverseIR } from "@codai/axiom-engine/dist/reverse-ir.js";
import { diff } from "@codai/axiom-engine/dist/axpatch.js";
import { apply } from "@codai/axiom-engine/dist/apply.js";

const server = new Server(
  {
    name: "axiom-mcp",
    version: "1.0.2",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "axiom_parse",
        description: "Parse .axm source code to IR (Intermediate Representation)",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "AXIOM source code (.axm)",
            },
          },
          required: ["source"],
        },
      },
      {
        name: "axiom_validate",
        description: "Validate IR semantics and constraints",
        inputSchema: {
          type: "object",
          properties: {
            ir: {
              type: "object",
              description: "AXIOM IR object",
            },
          },
          required: ["ir"],
        },
      },
      {
        name: "axiom_generate",
        description: "Generate artifacts and manifest from IR",
        inputSchema: {
          type: "object",
          properties: {
            ir: {
              type: "object",
              description: "AXIOM IR object",
            },
            profile: {
              type: "string",
              description: "Profile name (e.g., 'edge', 'budget')",
            },
          },
          required: ["ir"],
        },
      },
      {
        name: "axiom_check",
        description: "Run policy checks on manifest",
        inputSchema: {
          type: "object",
          properties: {
            manifest: {
              type: "object",
              description: "Generated manifest",
            },
            ir: {
              type: "object",
              description: "Optional IR for context",
            },
          },
          required: ["manifest"],
        },
      },
      {
        name: "axiom_reverse",
        description: "Reverse engineer IR from existing repository",
        inputSchema: {
          type: "object",
          properties: {
            repoPath: {
              type: "string",
              description: "Path to repository",
            },
            outDir: {
              type: "string",
              description: "Output directory to scan",
              default: "out",
            },
          },
        },
      },
      {
        name: "axiom_diff",
        description: "Generate diff patches between two IR versions",
        inputSchema: {
          type: "object",
          properties: {
            oldIr: {
              type: "object",
              description: "Old IR version",
            },
            newIr: {
              type: "object",
              description: "New IR version",
            },
          },
          required: ["oldIr", "newIr"],
        },
      },
      {
        name: "axiom_apply",
        description: "Apply manifest changes to filesystem",
        inputSchema: {
          type: "object",
          properties: {
            manifest: {
              type: "object",
              description: "Manifest to apply",
            },
            mode: {
              type: "string",
              enum: ["fs", "pr"],
              description: "Application mode: 'fs' for direct filesystem, 'pr' for pull request",
              default: "fs",
            },
            repoPath: {
              type: "string",
              description: "Repository path",
            },
            branchName: {
              type: "string",
              description: "Branch name for PR mode",
            },
            commitMessage: {
              type: "string",
              description: "Commit message for PR mode",
            },
          },
          required: ["manifest"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "axiom_parse": {
        const { source } = args as { source: string };
        const { ir, diagnostics } = parseAxiomSource(source);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ir, diagnostics }, null, 2),
            },
          ],
        };
      }

      case "axiom_validate": {
        const { ir } = args as { ir: any };
        const parse = AxiomIR.safeParse(ir);
        if (!parse.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: false, diagnostics: parse.error.issues },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const result = validateIR(parse.data);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "axiom_generate": {
        const { ir, profile } = args as { ir: any; profile?: string };
        const parse = AxiomIR.safeParse(ir);
        if (!parse.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: parse.error.issues }, null, 2),
              },
            ],
            isError: true,
          };
        }
        const { artifacts, manifest } = await generate(
          parse.data,
          process.cwd(),
          profile
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ artifacts, manifest }, null, 2),
            },
          ],
        };
      }

      case "axiom_check": {
        const { manifest, ir } = args as { manifest: any; ir?: any };
        const irParsed = ir ? AxiomIR.safeParse(ir) : null;
        const result = await check(
          manifest,
          irParsed?.success ? irParsed.data : undefined,
          process.cwd()
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "axiom_reverse": {
        const { repoPath, outDir } = args as {
          repoPath?: string;
          outDir?: string;
        };
        const ir = await reverseIR({
          repoPath: repoPath || process.cwd(),
          outDir: outDir || "out",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ir, diagnostics: [] }, null, 2),
            },
          ],
        };
      }

      case "axiom_diff": {
        const { oldIr, newIr } = args as { oldIr: any; newIr: any };
        const oldParse = AxiomIR.safeParse(oldIr);
        const newParse = AxiomIR.safeParse(newIr);
        if (!oldParse.success || !newParse.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "Invalid IR",
                    oldIr: oldParse.success ? null : oldParse.error.issues,
                    newIr: newParse.success ? null : newParse.error.issues,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        const patch = diff(oldParse.data, newParse.data);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ patch }, null, 2),
            },
          ],
        };
      }

      case "axiom_apply": {
        const { manifest, mode, repoPath, branchName, commitMessage } = args as {
          manifest: any;
          mode?: string;
          repoPath?: string;
          branchName?: string;
          commitMessage?: string;
        };
        const result = await apply({
          manifest,
          mode: (mode as "fs" | "pr") || "fs",
          repoPath: repoPath || process.cwd(),
          branchName,
          commitMessage,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message || String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AXIOM MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
