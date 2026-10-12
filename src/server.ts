import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { SevdeskRequestError, type SevdeskClient } from "./client.js";
import {
  contactTools,
  invoiceTools,
  voucherTools,
  accountTools,
  partTools,
  tagTools,
} from "./tools/index.js";

interface ToolDefinition {
  description: string;
  inputSchema: z.ZodObject;
  handler: (client: SevdeskClient, params: any) => Promise<unknown>;
}

// Combine all tools
export const allTools: Record<string, ToolDefinition> = {
  ...contactTools,
  ...invoiceTools,
  ...voucherTools,
  ...accountTools,
  ...partTools,
  ...tagTools,
};

export const SERVER_INFO = {
  name: "mcp-sevdesk",
  version: "1.0.0",
} as const;

/**
 * Creates an MCP server with all sevdesk tools registered.
 *
 * Input validation, JSON schema generation and error reporting are handled by
 * the SDK: invalid arguments and handler errors are returned as tool results
 * with `isError: true`.
 */
export function createServer(client: SevdeskClient): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  for (const [name, tool] of Object.entries(allTools)) {
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown): Promise<CallToolResult> => {
        let result: unknown;
        try {
          result = await tool.handler(client, args);
        } catch (error) {
          // openapi-fetch parses the response body as JSON after the client middleware has run
          if (error instanceof SyntaxError) {
            const message = `sevdesk API returned a response that is not valid JSON: ${error.message}`;
            throw new SevdeskRequestError(message, { cause: error });
          }
          throw error;
        }
        // An empty API response would otherwise yield an undefined text field
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result ?? null, null, 2),
            },
          ],
        };
      }
    );
  }

  // registerTool() announces listChanged: true, but the tool set is static and
  // a stateless HTTP server could not deliver change notifications anyway
  server.server.registerCapabilities({ tools: { listChanged: false } });

  return server;
}
