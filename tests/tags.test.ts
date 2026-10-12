import { describe, it, expect, beforeAll } from "vitest";
import { getClient, hasApiToken, defined } from "./setup.js";
import { tagTools } from "../src/tools/tags.js";
import { invoiceTools } from "../src/tools/invoices.js";
import { voucherTools } from "../src/tools/vouchers.js";
import type { SevdeskClient } from "../src/client.js";

interface TagRelationResponse {
  objects?: { tag?: { id?: string } };
}

// sevdesk wraps the created tag relation in "objects"; the OpenAPI response schema omits that wrapper
function createdTagRelation(result: unknown): NonNullable<TagRelationResponse["objects"]> {
  return defined((result as TagRelationResponse).objects);
}

describe("Tags API", () => {
  let client: SevdeskClient;

  beforeAll(() => {
    if (hasApiToken) {
      client = getClient();
    }
  });

  describe("list_tags", () => {
    it.skipIf(!hasApiToken)("sollte Tags auflisten können", async () => {
      const result = defined(await tagTools.list_tags.handler(client, {}));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
      expect(Array.isArray(result.objects)).toBe(true);
    });
  });

  describe("list_tag_relations", () => {
    it.skipIf(!hasApiToken)("sollte Tag-Relationen auflisten können", async () => {
      const result = defined(await tagTools.list_tag_relations.handler(client, {}));

      expect(result).toBeDefined();
      expect(result).toHaveProperty("objects");
      expect(Array.isArray(result.objects)).toBe(true);
    });
  });

  describe("Tag erstellen und löschen bei Invoice", () => {
    it.skipIf(!hasApiToken)("sollte einen Tag an einer Rechnung anlegen und wieder entfernen können", async () => {
      // 1. Hole eine existierende Rechnung
      const invoicesResult = defined(await invoiceTools.list_invoices.handler(client, {
        limit: 1,
      }));

      if (!invoicesResult.objects || invoicesResult.objects.length === 0) {
        console.log("Keine Rechnungen vorhanden, Test übersprungen");
        return;
      }

      const invoiceId = Number(invoicesResult.objects[0].id);
      const testTagName = `TestTag_${Date.now()}`;

      // 2. Erstelle einen neuen Tag an der Rechnung
      const createResult = defined(await tagTools.create_tag.handler(client, {
        name: testTagName,
        objectId: invoiceId,
        objectName: "Invoice",
      }));

      expect(createResult).toBeDefined();
      expect(createResult).toHaveProperty("objects");

      // Hole die Tag-ID aus der Response
      const tagId = Number(createdTagRelation(createResult).tag?.id);
      expect(tagId).toBeGreaterThan(0);

      console.log(`Tag "${testTagName}" erstellt mit ID ${tagId}`);

      // 3. Verifiziere, dass der Tag existiert
      const getResult = defined(await tagTools.get_tag.handler(client, { tagId }));
      expect(getResult).toBeDefined();
      expect(getResult.objects).toBeDefined();

      // 4. Lösche den Tag wieder
      const deleteResult = await tagTools.delete_tag.handler(client, { tagId });
      expect(deleteResult).toBeDefined();

      console.log(`Tag "${testTagName}" gelöscht`);

      // 5. Verifiziere, dass der Tag nicht mehr existiert
      await expect(
        tagTools.get_tag.handler(client, { tagId })
      ).rejects.toThrow();

      console.log(`Tag "${testTagName}" erfolgreich entfernt`);
    });
  });

  describe("Tag erstellen und löschen bei Voucher", () => {
    it.skipIf(!hasApiToken)("sollte einen Tag an einem Beleg anlegen und wieder entfernen können", async () => {
      // 1. Hole einen existierenden Beleg
      const vouchersResult = defined(await voucherTools.list_vouchers.handler(client, {
        limit: 1,
      }));

      if (!vouchersResult.objects || vouchersResult.objects.length === 0) {
        console.log("Keine Belege vorhanden, Test übersprungen");
        return;
      }

      const voucherId = Number(vouchersResult.objects[0].id);
      const testTagName = `VoucherTag_${Date.now()}`;

      // 2. Erstelle einen neuen Tag am Beleg
      const createResult = defined(await tagTools.create_tag.handler(client, {
        name: testTagName,
        objectId: voucherId,
        objectName: "Voucher",
      }));

      expect(createResult).toBeDefined();
      expect(createResult).toHaveProperty("objects");

      const tagId = Number(createdTagRelation(createResult).tag?.id);
      expect(tagId).toBeGreaterThan(0);

      console.log(`Tag "${testTagName}" an Beleg erstellt mit ID ${tagId}`);

      // 3. Lösche den Tag wieder
      const deleteResult = await tagTools.delete_tag.handler(client, { tagId });
      expect(deleteResult).toBeDefined();

      console.log(`Tag "${testTagName}" von Beleg gelöscht`);

      // 4. Verifiziere, dass der Tag nicht mehr existiert
      await expect(
        tagTools.get_tag.handler(client, { tagId })
      ).rejects.toThrow();

      console.log(`Tag "${testTagName}" erfolgreich entfernt`);
    });
  });
});
