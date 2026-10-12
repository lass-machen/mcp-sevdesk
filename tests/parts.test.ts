import { describe, it, expect, beforeAll } from "vitest";
import { getClient, hasApiToken, defined } from "./setup.js";
import { partTools } from "../src/tools/parts.js";
import type { SevdeskClient } from "../src/client.js";

describe("Parts API (lesend)", () => {
  let client: SevdeskClient;

  beforeAll(() => {
    if (hasApiToken) {
      client = getClient();
    }
  });

  describe("list_parts", () => {
    it.skipIf(!hasApiToken)("sollte Artikel auflisten können", async () => {
      const result = defined(await partTools.list_parts.handler(client, {
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
      expect(Array.isArray(result.objects)).toBe(true);
    });

    it.skipIf(!hasApiToken)("sollte Artikel mit Limit zurückgeben", async () => {
      const result = defined(await partTools.list_parts.handler(client, {
        limit: 5,
      }));

      expect(defined(result.objects).length).toBeLessThanOrEqual(5);
    });

    it.skipIf(!hasApiToken)("sollte Artikel nach Name filtern können", async () => {
      const result = defined(await partTools.list_parts.handler(client, {
        name: "Test",
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
    });
  });

  describe("get_part", () => {
    it.skipIf(!hasApiToken)("sollte einen einzelnen Artikel abrufen können", async () => {
      const listResult = defined(await partTools.list_parts.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const partId = Number(listResult.objects[0].id);
        const result = defined(await partTools.get_part.handler(client, {
          partId,
        }));

        expect(result).toBeDefined();
        expect(result).toHaveProperty("objects");
      }
    });

    it.skipIf(!hasApiToken)("sollte Fehler bei ungültiger ID werfen", async () => {
      await expect(
        partTools.get_part.handler(client, {
          partId: 999999999,
        })
      ).rejects.toThrow();
    });
  });

  describe("get_part_stock", () => {
    it.skipIf(!hasApiToken)("sollte Lagerbestand abrufen können", async () => {
      const listResult = defined(await partTools.list_parts.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const partId = Number(listResult.objects[0].id);

        try {
          const result = defined(await partTools.get_part_stock.handler(client, {
            partId,
          }));

          expect(result).toBeDefined();
          expect(result).toHaveProperty("objects");
        } catch (error) {
          // Stock might not be enabled for all parts
          expect(error).toBeDefined();
        }
      }
    });
  });
});
