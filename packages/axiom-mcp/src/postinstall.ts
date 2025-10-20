
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mcpDir = path.join(os.homedir(), ".axiom");
fs.mkdirSync(mcpDir, { recursive: true });
fs.writeFileSync(path.join(mcpDir, "server.json"), JSON.stringify({
  hint: "AXIOM MCP installed. Start with: npx axiom-mcp (or via host client auto-discovery).",
  portEnv: "AXIOM_MCP_PORT",
  defaultPort: 3411
}, null, 2));
