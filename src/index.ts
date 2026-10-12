#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSevdeskClient } from "./client.js";
import { createServer, type ServerOptions } from "./server.js";
import { loadHttpConfig, startHttpServer } from "./http.js";
import { ConfigError, parseBooleanEnv } from "./config.js";

// Get API token from environment
const API_TOKEN = process.env.SEVDESK_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: SEVDESK_API_TOKEN environment variable is required");
  console.error("Please set it to your sevdesk API token");
  process.exit(1);
}

// Transport selection; stdio stays the default for local MCP clients
const TRANSPORT = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

// Create sevdesk client
const sevdeskClient = createSevdeskClient(API_TOKEN);

// Start server
async function main() {
  const serverOptions: ServerOptions = {
    readOnly: parseBooleanEnv("MCP_READ_ONLY", process.env.MCP_READ_ONLY),
  };
  console.error(
    serverOptions.readOnly
      ? "Read-only mode: only read-only tools are available"
      : "All tools are available, including those that change data (MCP_READ_ONLY=true restricts to read-only tools)"
  );

  switch (TRANSPORT) {
    case "stdio": {
      const server = createServer(sevdeskClient, serverOptions);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("sevdesk MCP server running on stdio");
      break;
    }
    case "http": {
      const config = loadHttpConfig(process.env);
      await startHttpServer(config, () => createServer(sevdeskClient, serverOptions));
      break;
    }
    default:
      throw new ConfigError(`Unknown MCP_TRANSPORT "${TRANSPORT}", expected "stdio" or "http"`);
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
  } else {
    console.error("Fatal error:", error);
  }
  process.exit(1);
});
