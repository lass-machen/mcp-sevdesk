import { z } from "zod";
import type { SevdeskClient } from "../client.js";

export const tagTools = {
  list_tags: {
    description: "List all tags from sevdesk",
    inputSchema: z.object({
      id: z.number().int().positive().optional().describe("Filter by tag ID"),
      name: z.string().optional().describe("Filter by tag name"),
    }),
    handler: async (client: SevdeskClient, params: {
      id?: number;
      name?: string;
    }) => {
      const { data, error } = await client.GET("/Tag", {
        params: {
          query: {
            id: params.id,
            name: params.name,
          } as any,
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_tag: {
    description: "Get a specific tag by ID",
    inputSchema: z.object({
      tagId: z.number().int().positive().describe("The ID of the tag to retrieve"),
    }),
    handler: async (client: SevdeskClient, params: { tagId: number }) => {
      const { data, error } = await client.GET("/Tag/{tagId}", {
        params: {
          path: { tagId: params.tagId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  create_tag: {
    description: "Create a new tag and attach it to a document (Invoice, Voucher, Order, or CreditNote)",
    inputSchema: z.object({
      name: z.string().describe("Name of the tag"),
      objectId: z.number().int().positive().describe("ID of the document to tag"),
      objectName: z.enum(["Invoice", "Voucher", "Order", "CreditNote"]).describe("Type of document to tag"),
    }),
    handler: async (client: SevdeskClient, params: {
      name: string;
      objectId: number;
      objectName: "Invoice" | "Voucher" | "Order" | "CreditNote";
    }) => {
      const { data, error } = await client.POST("/Tag/Factory/create", {
        body: {
          name: params.name,
          object: {
            id: params.objectId,
            objectName: params.objectName,
          },
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  update_tag: {
    description: "Update an existing tag's name",
    inputSchema: z.object({
      tagId: z.number().int().positive().describe("The ID of the tag to update"),
      name: z.string().describe("New name for the tag"),
    }),
    handler: async (client: SevdeskClient, params: {
      tagId: number;
      name: string;
    }) => {
      const { data, error } = await client.PUT("/Tag/{tagId}", {
        params: {
          path: { tagId: params.tagId },
        },
        body: {
          name: params.name,
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  delete_tag: {
    description: "Delete a tag from sevdesk",
    inputSchema: z.object({
      tagId: z.number().int().positive().describe("The ID of the tag to delete"),
    }),
    handler: async (client: SevdeskClient, params: { tagId: number }) => {
      const { data, error } = await client.DELETE("/Tag/{tagId}", {
        params: {
          path: { tagId: params.tagId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data ?? { success: true };
    },
  },

  list_tag_relations: {
    description: "List all tag relations (shows which documents have which tags)",
    inputSchema: z.object({}),
    handler: async (client: SevdeskClient, _params: {}) => {
      const { data, error } = await client.GET("/TagRelation", {});
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },
};
