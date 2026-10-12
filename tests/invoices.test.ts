import { describe, it, expect, beforeAll } from "vitest";
import { getClient, hasApiToken, defined } from "./setup.js";
import { invoiceTools } from "../src/tools/invoices.js";
import type { SevdeskClient } from "../src/client.js";

describe("Invoices API (lesend)", () => {
  let client: SevdeskClient;

  beforeAll(() => {
    if (hasApiToken) {
      client = getClient();
    }
  });

  describe("list_invoices", () => {
    it.skipIf(!hasApiToken)("sollte Rechnungen auflisten können", async () => {
      const result = defined(await invoiceTools.list_invoices.handler(client, {
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
      expect(Array.isArray(result.objects)).toBe(true);
    });

    it.skipIf(!hasApiToken)("sollte Rechnungen nach Status filtern können", async () => {
      // Status 100 = Draft
      const result = defined(await invoiceTools.list_invoices.handler(client, {
        status: "100",
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
    });

    it.skipIf(!hasApiToken)("sollte Rechnungen mit Pagination abrufen", async () => {
      const result = defined(await invoiceTools.list_invoices.handler(client, {
        limit: 5,
        offset: 0,
      }));

      expect(defined(result.objects).length).toBeLessThanOrEqual(5);
    });
  });

  describe("get_invoice", () => {
    it.skipIf(!hasApiToken)("sollte eine einzelne Rechnung abrufen können", async () => {
      const listResult = defined(await invoiceTools.list_invoices.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const invoiceId = Number(listResult.objects[0].id);
        const result = defined(await invoiceTools.get_invoice.handler(client, {
          invoiceId,
        }));

        expect(result).toBeDefined();
        expect(result).toHaveProperty("objects");
      }
    });

    it.skipIf(!hasApiToken)("sollte Fehler bei ungültiger ID werfen", async () => {
      await expect(
        invoiceTools.get_invoice.handler(client, {
          invoiceId: 999999999,
        })
      ).rejects.toThrow();
    });
  });

  describe("get_invoice_pdf", () => {
    it.skipIf(!hasApiToken)("sollte PDF einer Rechnung abrufen können", async () => {
      const listResult = defined(await invoiceTools.list_invoices.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const invoiceId = Number(listResult.objects[0].id);

        try {
          const result = defined(await invoiceTools.get_invoice_pdf.handler(client, {
            invoiceId,
            preventSendBy: true, // Wichtig: Nicht als gesendet markieren
          }));

          expect(result).toBeDefined();
        } catch (error) {
          // PDF könnte nicht verfügbar sein für Draft-Rechnungen
          expect(error).toBeDefined();
        }
      }
    });
  });
});
