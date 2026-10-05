#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { registerAllTools } from "./tools/register-all.js";

// Local stdio entry point (kept for debugging). The deployed service uses src/http-server.ts.
const main = async () => {
  const server = QuickbooksMCPServer.GetServer();
  registerAllTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
