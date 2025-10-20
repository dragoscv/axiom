
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mcpDir = path.join(os.homedir(), ".mcp", "servers");
fs.mkdirSync(mcpDir, { recursive: true });

const mcpConfig = {
  command: "npx",
  args: ["@codai/axiom-mcp"],
  env: {
    AXIOM_MCP_PORT: "3411"
  },
  description: "AXIOM - AI-native intention language with deterministic manifest generation",
  endpoints: [
    "/parse - Parse .axm source to IR",
    "/validate - Validate IR semantics",
    "/generate - Generate artifacts from IR",
    "/check - Run policy checks",
    "/reverse - Reverse engineer IR from repo",
    "/diff - Generate IR diff patches",
    "/apply - Apply patches to filesystem"
  ]
};

fs.writeFileSync(
  path.join(mcpDir, "axiom.json"),
  JSON.stringify(mcpConfig, null, 2)
);

console.log("✅ AXIOM MCP config installed at ~/.mcp/servers/axiom.json");
console.log("   Start server: npx axiom-mcp");
console.log("   Default port: 3411");
