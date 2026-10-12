import { z } from "zod";
import type { SevdeskClient } from "../client.js";

export const contactTools = {
  list_contacts: {
    description: "List all contacts from sevdesk. Supports filtering by various parameters.",
    inputSchema: z.object({
      depth: z.number().optional().describe("Defines depth of sub-objects returned"),
      customerNumber: z.string().optional().describe("Filter by customer number"),
      name: z.string().optional().describe("Filter by contact name"),
      limit: z.number().int().positive().optional().describe("Limit the number of results (max 1000)"),
      offset: z.number().int().nonnegative().optional().describe("Skip a number of results"),
    }),
    handler: async (client: SevdeskClient, params: {
      depth?: number;
      customerNumber?: string;
      name?: string;
      limit?: number;
      offset?: number;
    }) => {
      const { data, error } = await client.GET("/Contact", {
        params: {
          query: {
            depth: params.depth as "0" | "1" | undefined,
            customerNumber: params.customerNumber,
            name: params.name,
            limit: params.limit,
            offset: params.offset,
          },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_contact: {
    description: "Get a specific contact by ID from sevdesk",
    inputSchema: z.object({
      contactId: z.number().int().positive().describe("The ID of the contact to retrieve"),
    }),
    handler: async (client: SevdeskClient, params: { contactId: number }) => {
      const { data, error } = await client.GET("/Contact/{contactId}", {
        params: {
          path: { contactId: params.contactId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  create_contact: {
    description: "Create a new contact in sevdesk",
    inputSchema: z.object({
      name: z.string().optional().describe("The name of the contact (for organizations)"),
      surename: z.string().optional().describe("The surname of the contact person"),
      familyname: z.string().optional().describe("The family name of the contact person"),
      customerNumber: z.string().optional().describe("Customer number"),
      description: z.string().optional().describe("Description of the contact"),
      categoryId: z.number().int().positive().describe("Category ID (3 = customer, 4 = supplier, 28 = partner)"),
    }),
    handler: async (client: SevdeskClient, params: {
      name?: string;
      surename?: string;
      familyname?: string;
      customerNumber?: string;
      description?: string;
      categoryId: number;
    }) => {
      const { data, error } = await client.POST("/Contact", {
        body: {
          name: params.name,
          surename: params.surename,
          familyname: params.familyname,
          customerNumber: params.customerNumber,
          description: params.description,
          category: {
            id: params.categoryId,
            objectName: "Category",
          },
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  update_contact: {
    description: "Update an existing contact in sevdesk",
    inputSchema: z.object({
      contactId: z.number().int().positive().describe("The ID of the contact to update"),
      name: z.string().optional().describe("The name of the contact"),
      surename: z.string().optional().describe("The surname"),
      familyname: z.string().optional().describe("The family name"),
      customerNumber: z.string().optional().describe("Customer number"),
      description: z.string().optional().describe("Description"),
    }),
    handler: async (client: SevdeskClient, params: {
      contactId: number;
      name?: string;
      surename?: string;
      familyname?: string;
      customerNumber?: string;
      description?: string;
    }) => {
      const { contactId, ...updateData } = params;
      const { data, error } = await client.PUT("/Contact/{contactId}", {
        params: {
          path: { contactId },
        },
        body: updateData as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  delete_contact: {
    description: "Delete a contact from sevdesk",
    inputSchema: z.object({
      contactId: z.number().int().positive().describe("The ID of the contact to delete"),
    }),
    handler: async (client: SevdeskClient, params: { contactId: number }) => {
      const { data, error } = await client.DELETE("/Contact/{contactId}", {
        params: {
          path: { contactId: params.contactId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data ?? { success: true };
    },
  },
};
