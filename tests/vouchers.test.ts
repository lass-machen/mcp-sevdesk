import { describe, it, expect, beforeAll } from "vitest";
import { getClient, hasApiToken, defined } from "./setup.js";
import { voucherTools } from "../src/tools/vouchers.js";
import type { SevdeskClient } from "../src/client.js";

describe("Vouchers API (lesend)", () => {
  let client: SevdeskClient;

  beforeAll(() => {
    if (hasApiToken) {
      client = getClient();
    }
  });

  describe("list_vouchers", () => {
    it.skipIf(!hasApiToken)("sollte Belege auflisten können", async () => {
      const result = defined(await voucherTools.list_vouchers.handler(client, {
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
      expect(Array.isArray(result.objects)).toBe(true);
    });

    it.skipIf(!hasApiToken)("sollte Belege nach Status filtern können", async () => {
      // Status 100 = Unpaid
      const result = defined(await voucherTools.list_vouchers.handler(client, {
        status: "100",
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
    });

    it.skipIf(!hasApiToken)("sollte Belege nach Credit/Debit filtern können", async () => {
      // D = Debit (Ausgaben)
      const result = defined(await voucherTools.list_vouchers.handler(client, {
        creditDebit: "D",
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
    });
  });

  describe("get_voucher", () => {
    it.skipIf(!hasApiToken)("sollte einen einzelnen Beleg abrufen können", async () => {
      const listResult = defined(await voucherTools.list_vouchers.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const voucherId = Number(listResult.objects[0].id);
        const result = defined(await voucherTools.get_voucher.handler(client, {
          voucherId,
        }));

        expect(result).toBeDefined();
        expect(result).toHaveProperty("objects");
      }
    });

    it.skipIf(!hasApiToken)("sollte Fehler bei ungültiger ID werfen", async () => {
      await expect(
        voucherTools.get_voucher.handler(client, {
          voucherId: 999999999,
        })
      ).rejects.toThrow();
    });
  });

  describe("get_voucher_positions", () => {
    it.skipIf(!hasApiToken)("sollte Belegpositionen abrufen können", async () => {
      const listResult = defined(await voucherTools.list_vouchers.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const voucherId = Number(listResult.objects[0].id);
        const result = defined(await voucherTools.get_voucher_positions.handler(client, {
          voucherId,
        }));

        expect(result).toBeDefined();
        expect(result).toHaveProperty("objects");
        expect(Array.isArray(result.objects)).toBe(true);
      }
    });
  });
});
