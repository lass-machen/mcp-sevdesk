import { describe, it, expect } from "vitest";
import type { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, allTools, type ServerOptions } from "../src/server.js";
import { toolAnnotations } from "../src/tool-annotations.js";
import { parseBooleanEnv, ConfigError } from "../src/config.js";
import type { SevdeskClient } from "../src/client.js";

interface RecordedCall {
  method: string;
  path: string;
}

// Records which API method a handler uses, without talking to sevdesk
function recordingClient(calls: RecordedCall[]): SevdeskClient {
  const record = (method: string) => async (path: string) => {
    calls.push({ method, path });
    return { data: { objects: [] }, error: undefined };
  };
  return {
    GET: record("GET"),
    POST: record("POST"),
    PUT: record("PUT"),
    DELETE: record("DELETE"),
  } as unknown as SevdeskClient;
}

// Minimal argument values per Zod type; the handlers are called directly, without validation
function sampleArguments(schema: z.ZodObject): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let def = (field as z.ZodType).def as { type: string; innerType?: z.ZodType; entries?: object };
    while (def.type === "optional" && def.innerType) {
      def = def.innerType.def as typeof def;
    }
    switch (def.type) {
      case "number":
        args[key] = 1;
        break;
      case "boolean":
        args[key] = true;
        break;
      case "enum":
        args[key] = Object.values(def.entries ?? {})[0];
        break;
      case "array":
        args[key] = [];
        break;
      default:
        args[key] = key === "base64Content" ? "dGVzdA==" : "2026-01-31";
    }
  }
  return args;
}

async function connect(options?: ServerOptions) {
  const server = createServer(recordingClient([]), options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const readOnlyTools = Object.keys(allTools).filter((name) => toolAnnotations[name]?.readOnlyHint === true);

describe("Tool-Annotations", () => {
  it("sollte für jedes Tool genau einen Eintrag haben", () => {
    expect(Object.keys(toolAnnotations).sort()).toEqual(Object.keys(allTools).sort());
  });

  it.each(Object.keys(allTools))("sollte %s passend zur HTTP-Methode einordnen", async (name) => {
    const calls: RecordedCall[] = [];
    const tool = allTools[name];
    await tool.handler(recordingClient(calls), sampleArguments(tool.inputSchema));

    expect(calls).toHaveLength(1);
    const annotations = toolAnnotations[name];
    if (calls[0].method === "GET") {
      expect(annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    } else {
      expect(annotations.readOnlyHint).toBe(false);
      expect(typeof annotations.destructiveHint).toBe("boolean");
      expect(typeof annotations.idempotentHint).toBe("boolean");
      expect(typeof annotations.openWorldHint).toBe("boolean");
    }
    if (calls[0].method === "DELETE") {
      expect(annotations.destructiveHint).toBe(true);
    }
  });

  // Same lists as in the README section "Lesende und schreibende Tools"
  const createTools = ["create_contact", "create_part", "create_tag", "create_transaction", "upload_voucher_file"];
  const destructiveTools = [
    "book_invoice",
    "book_voucher",
    "cancel_invoice",
    "delete_contact",
    "delete_tag",
    "mark_invoice_as_sent",
    "send_invoice_by_email",
    "update_contact",
    "update_part",
    "update_tag",
  ];
  const idempotentWriteTools = [
    "delete_contact",
    "delete_tag",
    "mark_invoice_as_sent",
    "update_contact",
    "update_part",
    "update_tag",
  ];

  it("sollte genau die dokumentierten Tools als anlegend, destruktiv und idempotent einordnen", () => {
    const names = Object.keys(toolAnnotations);
    const select = (predicate: (name: string) => boolean) => names.filter(predicate).sort();
    const isWrite = (name: string) => toolAnnotations[name].readOnlyHint === false;
    expect(select((name) => isWrite(name) && toolAnnotations[name].destructiveHint === false)).toEqual(createTools);
    expect(select((name) => toolAnnotations[name].destructiveHint === true)).toEqual(destructiveTools);
    expect(select((name) => isWrite(name) && toolAnnotations[name].idempotentHint === true)).toEqual(idempotentWriteTools);
    expect(select((name) => toolAnnotations[name].openWorldHint === true)).toEqual(["send_invoice_by_email"]);
  });

  it("sollte die Annotations über tools/list ausliefern", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(Object.keys(allTools).length);
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toEqual(toolAnnotations[tool.name]);
      }
    } finally {
      await close();
    }
  });
});

describe("Read-only-Modus", () => {
  it("sollte nur lesende Tools registrieren", async () => {
    const { client, close } = await connect({ readOnly: true });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...readOnlyTools].sort());
      expect(tools.length).toBe(19);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    } finally {
      await close();
    }
  });

  it("sollte schreibende Tools nicht ausführen", async () => {
    const { client, close } = await connect({ readOnly: true });
    try {
      const result = await client.callTool({ name: "delete_contact", arguments: { contactId: 1 } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("delete_contact not found");
    } finally {
      await close();
    }
  });

  it("sollte ohne Option alle Tools registrieren", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("delete_contact");
    } finally {
      await close();
    }
  });
});

describe("parseBooleanEnv", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["false", false],
    ["0", false],
    ["FALSE", false],
    ["true", true],
    ["1", true],
    [" True ", true],
  ])("%j -> %j", (value, expected) => {
    expect(parseBooleanEnv("MCP_READ_ONLY", value)).toBe(expected);
  });

  it.each(["yes", "no", "on", "2", "truee"])("sollte %s ablehnen", (value) => {
    expect(() => parseBooleanEnv("MCP_READ_ONLY", value)).toThrow(ConfigError);
  });
});
