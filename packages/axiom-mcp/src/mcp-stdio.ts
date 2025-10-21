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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const MCP_VERSION = packageJson.version;

// Helper to add version metadata to all responses
function addVersionMetadata(result: any): any {
  return {
    ...result,
    _axiom_mcp_version: MCP_VERSION,
    _axiom_engine_version: packageJson.dependencies?.["@codai/axiom-engine"] || "unknown"
  };
}

const server = new Server(
  {
    name: "axiom-mcp",
    version: MCP_VERSION, // Use dynamic version from package.json
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
              text: JSON.stringify(addVersionMetadata({ ir, diagnostics }), null, 2),
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
                  addVersionMetadata({ ok: false, diagnostics: parse.error.issues }),
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
              text: JSON.stringify(addVersionMetadata(result), null, 2),
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
        // DEBUG: Log artifact paths to stderr for debugging
        console.error("[MCP DEBUG] artifacts from generate():", JSON.stringify(artifacts.map(a => a.path)));
        console.error("[MCP DEBUG] manifest.artifacts:", JSON.stringify(manifest.artifacts.map(a => a.path)));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(addVersionMetadata({ artifacts, manifest }), null, 2),
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
              text: JSON.stringify(addVersionMetadata(result), null, 2),
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
              text: JSON.stringify(addVersionMetadata({ ir, diagnostics: [] }), null, 2),
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
        const patch = await diff(oldParse.data, newParse.data);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(addVersionMetadata({ patch }), null, 2),
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
              text: JSON.stringify(addVersionMetadata(result), null, 2),
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
  console.error("[AXIOM MCP] Starting server initialization...");
  console.error(`[AXIOM MCP] Process: Node ${process.version}, PID ${process.pid}`);
  console.error(`[AXIOM MCP] Working directory: ${process.cwd()}`);

  // CRITICAL: Give VS Code time to attach stdio pipes
  // Without this delay, VS Code may miss early stderr output
  await new Promise(resolve => setTimeout(resolve, 100));
  console.error("[AXIOM MCP] Stdio pipes ready, proceeding with initialization...");

  try {
    const transport = new StdioServerTransport();
    console.error("[AXIOM MCP] Transport created, connecting...");

    await server.connect(transport);
    console.error("[AXIOM MCP] Server connected successfully");
    console.error(`[AXIOM MCP] Version ${MCP_VERSION}, Engine ${packageJson.dependencies?.["@codai/axiom-engine"]}`);
    console.error("[AXIOM MCP] Ready to receive requests via stdio");
    console.error("[AXIOM MCP] Waiting for initialize request from client...");

    // Keep process alive - MCP SDK handles stdin/stdout
    // No explicit exit - let MCP SDK manage lifecycle
  } catch (error: any) {
    console.error("[AXIOM MCP] FATAL - Initialization failed:", error.message || String(error));
    console.error("[AXIOM MCP] Stack trace:", error.stack);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[AXIOM MCP] FATAL - Uncaught error in main():", error);
  process.exit(1);
});
