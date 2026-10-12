import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSevdeskClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { accountTools, todayInBerlin } from "../src/tools/accounts.js";
import { invoiceTools } from "../src/tools/invoices.js";
import { voucherTools } from "../src/tools/vouchers.js";
import { contactTools } from "../src/tools/contacts.js";
import { partTools } from "../src/tools/parts.js";

afterEach(() => {
  vi.useRealTimers();
});

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
    // 00:30 in Berlin, but still the previous day in UTC
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T22:30:00Z"));
    const { client, requests } = recordingClient();
    await accountTools.get_check_account_balance.handler(client, { checkAccountId: 5 });

    expect(new URL(requests[0].url).searchParams.get("date")).toBe("2026-10-12");
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
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-31T23:59:59+01:00",
    });

    const params = new URL(requests[0].url).searchParams;
    expect(params.get("startDate")).toBe("2026-01-01T00:00:00Z");
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

  it("sollte beim Abruf des Rechnungs-PDFs die Rechnung nicht als versendet markieren", async () => {
    const { client, requests } = recordingClient();
    await invoiceTools.get_invoice_pdf.handler(client, { invoiceId: 42 });
    await invoiceTools.get_invoice_pdf.handler(client, { invoiceId: 42, download: true });

    expect([...new URL(requests[0].url).searchParams]).toEqual([["preventSendBy", "true"]]);
    expect([...new URL(requests[1].url).searchParams].sort()).toEqual([
      ["download", "true"],
      ["preventSendBy", "true"],
    ]);
  });

  it("sollte Buchungen mit den Typen und Datumsformaten der Spec senden", async () => {
    const { client, requests } = recordingClient();
    await invoiceTools.book_invoice.handler(client, {
      invoiceId: 42,
      amount: 119,
      date: 1767225600,
      type: "FULL_PAYMENT",
      checkAccountId: 5,
    });
    await voucherTools.book_voucher.handler(client, {
      voucherId: 43,
      amount: 59.5,
      date: "2026-01-01T00:00:00+01:00",
      type: "MTC",
      checkAccountId: 5,
    });

    expect(await requests[0].json()).toMatchObject({ amount: 119, date: 1767225600, type: "FULL_PAYMENT" });
    expect(await requests[1].json()).toMatchObject({ amount: 59.5, date: "2026-01-01T00:00:00+01:00", type: "MTC" });
  });

  it("sollte bei create_transaction den Pflichtstatus mitsenden", async () => {
    const { client, requests } = recordingClient();
    await accountTools.create_transaction.handler(client, {
      checkAccountId: 5,
      amount: -12.5,
      valueDate: "2026-01-31T00:00:00+01:00",
      payeePayerName: "Bäckerei Müller",
    });

    expect(await requests[0].json()).toMatchObject({
      checkAccount: { id: 5, objectName: "CheckAccount" },
      amount: -12.5,
      valueDate: "2026-01-31T00:00:00+01:00",
      payeePayerName: "Bäckerei Müller",
      status: 100,
    });
  });

  it("sollte einen übergebenen Transaktionsstatus weitergeben", async () => {
    const { client, requests } = recordingClient();
    await accountTools.create_transaction.handler(client, {
      checkAccountId: 5,
      amount: 10,
      valueDate: "2026-01-31T00:00:00+01:00",
      payeePayerName: "X",
      status: 300,
    });

    expect((await requests[0].json()).status).toBe(300);
  });

  it("sollte Artikelpreise als Zahlen senden", async () => {
    const { client, requests } = recordingClient();
    await partTools.create_part.handler(client, {
      name: "Beratung",
      partNumber: "B-1",
      stock: 0,
      priceNet: 100,
      priceGross: 119,
      taxRate: 19,
    });
    await partTools.update_part.handler(client, { partId: 7, priceNet: 200, taxRate: 7 });

    expect(await requests[0].json()).toMatchObject({ priceNet: 100, priceGross: 119, taxRate: 19 });
    expect(await requests[1].json()).toEqual({ priceNet: 200, taxRate: 7 });
  });

  it("sollte depth bei list_contacts als Text weitergeben", async () => {
    const { client, requests } = recordingClient();
    await contactTools.list_contacts.handler(client, { depth: "1" });

    expect(new URL(requests[0].url).searchParams.get("depth")).toBe("1");
  });

  it("sollte base64 mit Zeilenumbrüchen korrekt dekodieren", async () => {
    const { client, requests } = recordingClient();
    await voucherTools.upload_voucher_file.handler(client, { fileName: "a.txt", base64Content: "QUJD\r\nRA==\n" });

    const file = (await requests[0].formData()).get("file") as File;
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("ABCD");
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
    ["upload_voucher_file", { fileName: "beleg.pdf", base64Content: "QUJD\u202fRA==" }],
    ["list_transactions", { checkAccountId: 5, startDate: "2026-01-31" }],
    ["get_check_account_balance", { checkAccountId: 5, date: "2026-13-45" }],
    ["book_invoice", { invoiceId: 1, amount: 1, date: 1767225600, type: "MF", checkAccountId: 5 }],
    ["book_voucher", { voucherId: 1, amount: 1, date: "1767225600", type: "N", checkAccountId: 5 }],
    ["create_transaction", { checkAccountId: 5, amount: 1, valueDate: "2026-01-31T00:00:00Z" }],
    ["list_contacts", { depth: "2" }],
    ["book_invoice", { invoiceId: 1, amount: 1, date: "1767225600", type: "N", checkAccountId: 5 }],
    ["create_transaction", { checkAccountId: 5, amount: 1, valueDate: "2026-01-31T00:00:00Z", payeePayerName: "X", status: 500 }],
    ["create_transaction", { checkAccountId: 5, amount: 1, valueDate: "2026-01-31", payeePayerName: "X" }],
    ["create_part", { name: "Beratung", stock: 0, taxRate: 19 }],
    ["create_part", { name: "Beratung", partNumber: "B-1", taxRate: 19 }],
    ["create_part", { name: "Beratung", partNumber: "B-1", stock: 0 }],
    ["create_part", { name: "Beratung", partNumber: "", stock: 0, taxRate: 19 }],
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

  it.each([
    ["list_transactions", { checkAccountId: 5, startDate: "2026-01-31T00:00:00Z", endDate: "2026-01-31T23:59:59+01:00" }],
    ["list_transactions", { checkAccountId: 5, startDate: "2026-01-31T00:00:00+01:00" }],
    ["get_check_account_balance", { checkAccountId: 5, date: "2026-02-28" }],
    ["book_invoice", { invoiceId: 1, amount: 119, date: 1767225600, type: "FULL_PAYMENT", checkAccountId: 5 }],
    ["book_invoice", { invoiceId: 1, amount: 5, date: 1767225600, type: "MTC", checkAccountId: 5 }],
    ["book_voucher", { voucherId: 1, amount: 1, date: "2026-01-31T00:00:00+01:00", type: "FULL_PAYMENT", checkAccountId: 5 }],
    ["book_voucher", { voucherId: 1, amount: 1, date: "2026-01-31T00:00:00Z", type: "MTC", checkAccountId: 5 }],
    [
      "create_transaction",
      {
        checkAccountId: 5,
        amount: 1,
        valueDate: "2026-01-31T00:00:00+01:00",
        entryDate: "2026-01-31T08:00:00+01:00",
        payeePayerName: "X",
        status: 400,
      },
    ],
    ["create_part", { name: "Beratung", partNumber: "B-1", stock: 0, taxRate: 19 }],
  ])("sollte %s mit gültigen Angaben %j annehmen", async (name, args) => {
    const { client, requests, close } = await connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      expect(requests).toHaveLength(1);
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
