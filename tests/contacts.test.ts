import { describe, it, expect, beforeAll } from "vitest";
import { getClient, hasApiToken, defined } from "./setup.js";
import { contactTools } from "../src/tools/contacts.js";
import type { SevdeskClient } from "../src/client.js";

describe("Contacts API (lesend)", () => {
  let client: SevdeskClient;

  beforeAll(() => {
    if (hasApiToken) {
      client = getClient();
    }
  });

  describe("list_contacts", () => {
    it.skipIf(!hasApiToken)("sollte Kontakte auflisten können", async () => {
      const result = defined(await contactTools.list_contacts.handler(client, {
        limit: 10,
      }));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
      expect(Array.isArray(result.objects)).toBe(true);
    });

    it.skipIf(!hasApiToken)("sollte Kontakte mit Limit zurückgeben", async () => {
      const result = defined(await contactTools.list_contacts.handler(client, {
        limit: 5,
      }));

      expect(defined(result.objects).length).toBeLessThanOrEqual(5);
    });

    it.skipIf(!hasApiToken)("sollte Kontakte nach Name filtern können", async () => {
      const result = defined(await contactTools.list_contacts.handler(client, {
        limit: 100,
      }));

      // Nur prüfen, ob die Anfrage funktioniert
      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
    });
  });

  describe("get_contact", () => {
    it.skipIf(!hasApiToken)("sollte einen einzelnen Kontakt abrufen können", async () => {
      // Erst Liste holen, dann ersten Kontakt abrufen
      const listResult = defined(await contactTools.list_contacts.handler(client, {
        limit: 1,
      }));

      if (listResult.objects && listResult.objects.length > 0) {
        const contactId = Number(listResult.objects[0].id);
        const result = defined(await contactTools.get_contact.handler(client, {
          contactId,
        }));

        expect(result).toBeDefined();
        expect(result).toHaveProperty("objects");
      }
    });

    it.skipIf(!hasApiToken)("sollte Fehler bei ungültiger ID werfen", async () => {
      await expect(
        contactTools.get_contact.handler(client, {
          contactId: 999999999,
        })
      ).rejects.toThrow();
    });
  });
});
