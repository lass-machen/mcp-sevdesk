#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSevdeskClient } from "./client.js";
import { createServer } from "./server.js";

// Get API token from environment
const API_TOKEN = process.env.SEVDESK_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: SEVDESK_API_TOKEN environment variable is required");
  console.error("Please set it to your sevdesk API token");
  process.exit(1);
}

// Create sevdesk client
const sevdeskClient = createSevdeskClient(API_TOKEN);

// Start server
async function main() {
  const server = createServer(sevdeskClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sevdesk MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
