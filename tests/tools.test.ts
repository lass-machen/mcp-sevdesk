import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSevdeskClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { accountTools, todayInBerlin } from "../src/tools/accounts.js";
import { invoiceTools } from "../src/tools/invoices.js";
import { voucherTools } from "../src/tools/vouchers.js";

// Offline client that records the requests it would send to sevdesk
function recordingClient() {
  const requests: Request[] = [];
  const client = createSevdeskClient("test-token", {
    fetch: async (request) => {
      requests.push(request.clone());
      return new Response(JSON.stringify({ objects: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { client, requests };
}

async function connect() {
  const { client: sevdesk, requests } = recordingClient();
  const server = createServer(sevdesk);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    requests,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("sevdesk-Tools", () => {
  it("sollte limit und offset bei list_check_accounts weitergeben", async () => {
    const { client, requests } = recordingClient();
    await accountTools.list_check_accounts.handler(client, { limit: 10, offset: 20 });

    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/api/v1/CheckAccount");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("20");
  });

  it("sollte für den Kontostand standardmäßig das heutige Datum in Deutschland verwenden", async () => {
    const { client, requests } = recordingClient();
    await accountTools.get_check_account_balance.handler(client, { checkAccountId: 5 });

    expect(new URL(requests[0].url).searchParams.get("date")).toBe(todayInBerlin());
  });

  it.each([
    ["2026-10-11T21:59:59Z", "2026-10-11"],
    ["2026-10-11T22:30:00Z", "2026-10-12"],
    ["2026-01-31T23:30:00Z", "2026-02-01"],
  ])("sollte %s als Berliner Datum %s melden", (instant, expected) => {
    expect(todayInBerlin(new Date(instant))).toBe(expected);
  });

  it("sollte Datumsfilter bei list_transactions als ISO-Text weitergeben", async () => {
    const { client, requests } = recordingClient();
    await accountTools.list_transactions.handler(client, {
      checkAccountId: 5,
      startDate: "2026-01-01",
      endDate: "2026-01-31T23:59:59+01:00",
    });

    const params = new URL(requests[0].url).searchParams;
    expect(params.get("startDate")).toBe("2026-01-01");
    expect(params.get("endDate")).toBe("2026-01-31T23:59:59+01:00");
  });

  it("sollte Zeitstempel bei list_invoices als Zahl weitergeben", async () => {
    const { client, requests } = recordingClient();
    await invoiceTools.list_invoices.handler(client, { startDate: 1767225600, endDate: 1769903999 });

    const params = new URL(requests[0].url).searchParams;
    expect(params.get("startDate")).toBe("1767225600");
    expect(params.get("endDate")).toBe("1769903999");
  });

  it("sollte mark_invoice_as_sent mit JSON-Body statt Query senden", async () => {
    const { client, requests } = recordingClient();
    await invoiceTools.mark_invoice_as_sent.handler(client, { invoiceId: 42, sendType: "VPDF" });

    const request = requests[0];
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/api/v1/Invoice/42/sendBy");
    expect(new URL(request.url).search).toBe("");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ sendType: "VPDF", sendDraft: false });
  });

  it("sollte Belegdateien als multipart/form-data hochladen", async () => {
    const { client, requests } = recordingClient();
    const content = Buffer.from("%PDF-1.7 Testbeleg");
    await voucherTools.upload_voucher_file.handler(client, {
      fileName: "beleg.pdf",
      base64Content: content.toString("base64"),
    });

    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/v1/Voucher/Factory/uploadTempFile");
    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = await request.formData();
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("beleg.pdf");
    expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(content);
    expect([...form.keys()]).toEqual(["file"]);
  });

  it("sollte bei GET-Anfragen keinen Content-Type senden", async () => {
    const { client, requests } = recordingClient();
    await accountTools.get_check_account.handler(client, { checkAccountId: 5 });

    expect(requests[0].headers.get("content-type")).toBeNull();
    expect(requests[0].headers.get("accept")).toBe("application/json");
    expect(requests[0].headers.get("authorization")).toBe("test-token");
  });
});

describe("Eingabeprüfung über MCP", () => {
  it.each([
    ["get_voucher", { voucherId: 1.5 }],
    ["get_voucher", { voucherId: 0 }],
    ["list_contacts", { limit: 0 }],
    ["list_contacts", { offset: -1 }],
    ["list_invoices", { startDate: "1767225600" }],
    ["list_transactions", { checkAccountId: 5, startDate: "31.01.2026" }],
    ["get_check_account_balance", { checkAccountId: 5, date: "1767225600" }],
    ["mark_invoice_as_sent", { invoiceId: 1 }],
    ["upload_voucher_file", { fileName: "beleg.pdf", base64Content: "data:application/pdf;base64,JVBERg==" }],
    ["upload_voucher_file", { fileName: "beleg.pdf", base64Content: "" }],
  ])("sollte %s mit %j ablehnen, ohne sevdesk aufzurufen", async (name, args) => {
    const { client, requests, close } = await connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Input validation error");
      expect(requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("sollte die Ganzzahl-Typen im JSON-Schema ausweisen", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const schema = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as any;

      expect(schema("get_voucher").properties.voucherId.type).toBe("integer");
      expect(schema("list_contacts").properties.offset).toMatchObject({ type: "integer", minimum: 0 });
      expect(schema("mark_invoice_as_sent").required).toEqual(["invoiceId", "sendType"]);
      expect(Object.keys(schema("upload_voucher_file").properties).sort()).toEqual(["base64Content", "fileName"]);
    } finally {
      await close();
    }
  });
});
