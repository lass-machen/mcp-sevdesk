import { describe, it, expect, vi, afterEach } from "vitest";
import { createSevdeskClient, SevdeskApiError, SevdeskRequestError } from "../src/client.js";
import { contactTools } from "../src/tools/contacts.js";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

interface RecordedCall {
  request: Request;
  init?: RequestInit;
}

// Offline client whose fetch always answers with the given response
function clientWithResponse(response: () => Response) {
  const calls: RecordedCall[] = [];
  const client = createSevdeskClient("test-token", {
    fetch: async (request, init) => {
      calls.push({ request, init });
      return response();
    },
  });
  return { client, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sevdesk-Client", () => {
  it("sollte erfolgreiche Antworten durchreichen und den Token senden", async () => {
    const { client, calls } = clientWithResponse(
      () => new Response(JSON.stringify({ objects: [{ id: "7" }] }), { status: 200 })
    );
    const result = await contactTools.get_contact.handler(client, { contactId: 7 });

    expect(result).toEqual({ objects: [{ id: "7" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].request.url).toBe("https://my.sevdesk.de/api/v1/Contact/7");
    expect(calls[0].request.headers.get("authorization")).toBe("test-token");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sollte Fehlerstatus ohne Body als Fehler werfen", async () => {
    const { client } = clientWithResponse(() => new Response(null, { status: 500 }));
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe("sevdesk API request failed with status 500");
  });

  it("sollte Fehlerstatus mit Content-Length 0 als Fehler werfen", async () => {
    const { client } = clientWithResponse(
      () => new Response("", { status: 401, headers: { "Content-Length": "0" } })
    );
    await expect(contactTools.get_contact.handler(client, { contactId: 7 })).rejects.toMatchObject({
      status: 401,
    });
  });

  it.each([301, 302, 304, 404, 429])("sollte Status %i als Fehler werfen", async (status) => {
    const { client } = clientWithResponse(() => new Response(null, { status }));
    await expect(contactTools.get_contact.handler(client, { contactId: 7 })).rejects.toMatchObject({ status });
  });

  it("sollte 201 mit Body als Erfolg behandeln", async () => {
    const { client } = clientWithResponse(() => new Response(JSON.stringify({ objects: { id: "9" } }), { status: 201 }));
    await expect(contactTools.get_contact.handler(client, { contactId: 9 })).resolves.toEqual({ objects: { id: "9" } });
  });

  it("sollte 204 ohne Body als Erfolg behandeln", async () => {
    const { client } = clientWithResponse(() => new Response(null, { status: 204 }));
    await expect(contactTools.delete_contact.handler(client, { contactId: 7 })).resolves.toEqual({ success: true });
  });

  it("sollte hängende Anfragen nach dem Timeout abbrechen", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = createSevdeskClient("test-token", {
      timeoutMs: 50,
      fetch: (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const started = Date.now();
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskRequestError);
    expect(error.message).toBe("sevdesk API request timed out after 50 ms");
    expect(observedSignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("sollte einen Timeout beim Lesen des Bodys als Timeout melden", async () => {
    const client = createSevdeskClient("test-token", {
      timeoutMs: 50,
      fetch: async (_request, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
            },
          }),
          { status: 200 }
        ),
    });
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskRequestError);
    expect(error.message).toBe("sevdesk API request timed out after 50 ms");
  });

  it("sollte einen Verbindungsabbruch beim Lesen des Bodys melden", async () => {
    const client = createSevdeskClient("test-token", {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"objects":'));
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 }
        ),
    });
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskRequestError);
    expect(error.message).toBe("sevdesk API request failed: terminated");
  });

  it("sollte Antworten mit ungewöhnlicher Statuszeile unverändert durchreichen", async () => {
    // fetch accepts reason phrases that the Response constructor rejects
    const { client } = clientWithResponse(() => {
      const response = new Response(JSON.stringify({ objects: [{ id: "3" }] }), { status: 200 });
      Object.defineProperty(response, "statusText", { value: "OK\u007f" });
      return response;
    });
    await expect(contactTools.get_contact.handler(client, { contactId: 3 })).resolves.toEqual({
      objects: [{ id: "3" }],
    });
  });

  it("sollte einen Abbruch über das eigene Signal der Anfrage nicht als Timeout melden", async () => {
    const controller = new AbortController();
    const client = createSevdeskClient("test-token", {
      fetch: (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const pending = client.GET("/Contact/{contactId}", {
      params: { path: { contactId: 7 } },
      signal: controller.signal,
    });
    controller.abort();
    const error = await pending.catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskRequestError);
    expect(error.message).toBe("sevdesk API request failed: This operation was aborted");
  });

  it("sollte standardmäßig nach 30 Sekunden abbrechen", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { client } = clientWithResponse(() => new Response(JSON.stringify({ objects: [] }), { status: 200 }));
    await contactTools.get_contact.handler(client, { contactId: 7 });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("sollte fremde Timeouts nicht als eigenen Timeout ausgeben", async () => {
    const client = createSevdeskClient("test-token", {
      fetch: async () => {
        throw new DOMException("upstream proxy timeout", "TimeoutError");
      },
    });
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskRequestError);
    expect(error.message).toBe("sevdesk API request failed: upstream proxy timeout");
  });

  it("sollte Netzwerkfehler mit Ursache melden", async () => {
    const client = createSevdeskClient("test-token", {
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
      },
    });
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskRequestError);
    expect(error.message).toBe("sevdesk API request failed: fetch failed (ENOTFOUND)");
  });

  it("sollte fehlgeschlagenes Löschen nicht als Erfolg melden", async () => {
    const { client } = clientWithResponse(() => new Response(null, { status: 500 }));
    await expect(contactTools.delete_contact.handler(client, { contactId: 7 })).rejects.toBeInstanceOf(
      SevdeskApiError
    );
  });

  it("sollte den Fehler-Body in die Meldung übernehmen und kürzen", async () => {
    const longBody = JSON.stringify({ error: { message: "x".repeat(5000) } });
    const { client } = clientWithResponse(() => new Response(longBody, { status: 400 }));
    const error = await contactTools.get_contact.handler(client, { contactId: 7 }).catch((e) => e);

    expect(error).toBeInstanceOf(SevdeskApiError);
    expect(error.body.length).toBeLessThan(2100);
    expect(error.body).toMatch(/^\{"error":\{"message":"x+\.\.\. \(truncated\)$/);
  });

  it("sollte API-Fehler als Tool-Fehler über MCP melden", async () => {
    const { client } = clientWithResponse(() => new Response(null, { status: 503 }));
    const server = createServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "vitest", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const result = await mcpClient.callTool({ name: "get_contact", arguments: { contactId: 7 } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "sevdesk API request failed with status 503" }]);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it("sollte leere Erfolgsantworten über MCP als null melden", async () => {
    const { client } = clientWithResponse(() => new Response(null, { status: 204 }));
    const server = createServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "vitest", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const result = await mcpClient.callTool({ name: "get_contact", arguments: { contactId: 7 } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "null" }]);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it("sollte Antworten ohne gültiges JSON über MCP verständlich melden", async () => {
    const { client } = clientWithResponse(
      () => new Response("<html>Wartung</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    );
    const server = createServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "vitest", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const result = await mcpClient.callTool({ name: "get_contact", arguments: { contactId: 7 } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("sevdesk API returned a response that is not valid JSON");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
