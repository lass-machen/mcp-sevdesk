import { z } from "zod";
import type { SevdeskClient } from "../client.js";

export const partTools = {
  list_parts: {
    description: "List all parts (products/services) from sevdesk inventory",
    inputSchema: z.object({
      partNumber: z.string().optional().describe("Filter by part number"),
      name: z.string().optional().describe("Filter by part name"),
      limit: z.number().int().positive().optional().describe("Limit the number of results"),
      offset: z.number().int().nonnegative().optional().describe("Skip a number of results"),
    }),
    handler: async (client: SevdeskClient, params: {
      partNumber?: string;
      name?: string;
      limit?: number;
      offset?: number;
    }) => {
      const { data, error } = await client.GET("/Part", {
        params: {
          query: {
            partNumber: params.partNumber,
            name: params.name,
            limit: params.limit,
            offset: params.offset,
          } as any,
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_part: {
    description: "Get a specific part by ID",
    inputSchema: z.object({
      partId: z.number().int().positive().describe("The ID of the part to retrieve"),
    }),
    handler: async (client: SevdeskClient, params: { partId: number }) => {
      const { data, error } = await client.GET("/Part/{partId}", {
        params: {
          path: { partId: params.partId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  create_part: {
    description: "Create a new part (product/service) in sevdesk",
    inputSchema: z.object({
      name: z.string().describe("Name of the part"),
      partNumber: z.string().optional().describe("Part number"),
      stock: z.number().optional().describe("Current stock quantity"),
      stockEnabled: z.boolean().optional().describe("Enable stock tracking"),
      unitId: z.number().int().positive().optional().describe("Unit ID (default: 1 for pieces)"),
      priceGross: z.number().optional().describe("Gross price"),
      priceNet: z.number().optional().describe("Net price"),
      taxRate: z.number().optional().describe("Tax rate in percent (e.g., 19)"),
    }),
    handler: async (client: SevdeskClient, params: {
      name: string;
      partNumber?: string;
      stock?: number;
      stockEnabled?: boolean;
      unitId?: number;
      priceGross?: number;
      priceNet?: number;
      taxRate?: number;
    }) => {
      const { data, error } = await client.POST("/Part", {
        body: {
          name: params.name,
          partNumber: params.partNumber,
          stock: params.stock,
          stockEnabled: params.stockEnabled,
          unity: params.unitId
            ? { id: params.unitId, objectName: "Unity" }
            : { id: 1, objectName: "Unity" },
          priceGross: params.priceGross,
          priceNet: params.priceNet,
          taxRate: params.taxRate,
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  update_part: {
    description: "Update an existing part in sevdesk",
    inputSchema: z.object({
      partId: z.number().int().positive().describe("The ID of the part to update"),
      name: z.string().optional().describe("Name of the part"),
      partNumber: z.string().optional().describe("Part number"),
      stock: z.number().optional().describe("Current stock quantity"),
      stockEnabled: z.boolean().optional().describe("Enable stock tracking"),
      priceGross: z.number().optional().describe("Gross price"),
      priceNet: z.number().optional().describe("Net price"),
      taxRate: z.number().optional().describe("Tax rate in percent"),
    }),
    handler: async (client: SevdeskClient, params: {
      partId: number;
      name?: string;
      partNumber?: string;
      stock?: number;
      stockEnabled?: boolean;
      priceGross?: number;
      priceNet?: number;
      taxRate?: number;
    }) => {
      const { partId, ...updateData } = params;
      const body: Record<string, any> = {};
      if (updateData.name) body.name = updateData.name;
      if (updateData.partNumber) body.partNumber = updateData.partNumber;
      if (updateData.stock !== undefined) body.stock = updateData.stock;
      if (updateData.stockEnabled !== undefined) body.stockEnabled = updateData.stockEnabled;
      if (updateData.priceGross !== undefined) body.priceGross = updateData.priceGross;
      if (updateData.priceNet !== undefined) body.priceNet = updateData.priceNet;
      if (updateData.taxRate !== undefined) body.taxRate = updateData.taxRate;

      const { data, error } = await client.PUT("/Part/{partId}", {
        params: {
          path: { partId },
        },
        body: body as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_part_stock: {
    description: "Get the current stock of a part",
    inputSchema: z.object({
      partId: z.number().int().positive().describe("The ID of the part"),
    }),
    handler: async (client: SevdeskClient, params: { partId: number }) => {
      const { data, error } = await client.GET("/Part/{partId}/getStock", {
        params: {
          path: { partId: params.partId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },
};
