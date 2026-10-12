import { z } from "zod";
import type { SevdeskClient } from "../client.js";

export const invoiceTools = {
  list_invoices: {
    description: "List all invoices from sevdesk. Supports filtering and pagination.",
    inputSchema: z.object({
      status: z.enum(["100", "200", "1000"]).optional().describe("Invoice status: 100=Draft, 200=Open, 1000=Paid"),
      invoiceNumber: z.string().optional().describe("Filter by invoice number"),
      startDate: z.number().int().nonnegative().optional().describe("Filter by start date (Unix timestamp in seconds)"),
      endDate: z.number().int().nonnegative().optional().describe("Filter by end date (Unix timestamp in seconds)"),
      limit: z.number().int().positive().optional().describe("Limit the number of results"),
      offset: z.number().int().nonnegative().optional().describe("Skip a number of results"),
    }),
    handler: async (client: SevdeskClient, params: {
      status?: "100" | "200" | "1000";
      invoiceNumber?: string;
      startDate?: number;
      endDate?: number;
      limit?: number;
      offset?: number;
    }) => {
      const { data, error } = await client.GET("/Invoice", {
        params: {
          query: {
            status: params.status ? Number(params.status) : undefined,
            invoiceNumber: params.invoiceNumber,
            startDate: params.startDate,
            endDate: params.endDate,
            limit: params.limit,
            offset: params.offset,
          } as any,
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_invoice: {
    description: "Get a specific invoice by ID from sevdesk",
    inputSchema: z.object({
      invoiceId: z.number().int().positive().describe("The ID of the invoice to retrieve"),
    }),
    handler: async (client: SevdeskClient, params: { invoiceId: number }) => {
      const { data, error } = await client.GET("/Invoice/{invoiceId}", {
        params: {
          path: { invoiceId: params.invoiceId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_invoice_pdf: {
    description:
      "Get the PDF of an invoice as base64 encoded string. Sends preventSendBy=true so that the " +
      "invoice is not marked as sent; use mark_invoice_as_sent for that.",
    inputSchema: z.object({
      invoiceId: z.number().int().positive().describe("The ID of the invoice"),
      download: z.boolean().optional().describe("Whether to download the PDF"),
    }),
    handler: async (client: SevdeskClient, params: {
      invoiceId: number;
      download?: boolean;
    }) => {
      const { data, error } = await client.GET("/Invoice/{invoiceId}/getPdf", {
        params: {
          path: { invoiceId: params.invoiceId },
          query: {
            download: params.download,
            // Reading a PDF must not change data. The spec only says "Defines if u want to send the
            // invoice"; the upstream tests set it so the invoice is not marked as sent (not verified live)
            preventSendBy: true,
          },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  send_invoice_by_email: {
    description: "Send an invoice via email",
    inputSchema: z.object({
      invoiceId: z.number().int().positive().describe("The ID of the invoice to send"),
      toEmail: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      text: z.string().describe("Email body text"),
      copy: z.boolean().optional().describe("Send a copy to your own email"),
      additionalAttachments: z.string().optional().describe("Additional attachment IDs, comma-separated"),
      ccEmail: z.string().optional().describe("CC email address"),
      bccEmail: z.string().optional().describe("BCC email address"),
    }),
    handler: async (client: SevdeskClient, params: {
      invoiceId: number;
      toEmail: string;
      subject: string;
      text: string;
      copy?: boolean;
      additionalAttachments?: string;
      ccEmail?: string;
      bccEmail?: string;
    }) => {
      const { data, error } = await client.POST("/Invoice/{invoiceId}/sendViaEmail", {
        params: {
          path: { invoiceId: params.invoiceId },
        },
        body: {
          toEmail: params.toEmail,
          subject: params.subject,
          text: params.text,
          copy: params.copy,
          additionalAttachments: params.additionalAttachments,
          ccEmail: params.ccEmail,
          bccEmail: params.bccEmail,
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  mark_invoice_as_sent: {
    description: "Mark an invoice as sent",
    inputSchema: z.object({
      invoiceId: z.number().int().positive().describe("The ID of the invoice"),
      sendType: z.enum(["VPR", "VPDF", "VM", "VP"]).describe("How the invoice was sent: VPR=Print, VPDF=PDF, VM=Email, VP=Post"),
      sendDraft: z.boolean().optional().describe("Only create a draft of the send action. Default: false"),
    }),
    handler: async (client: SevdeskClient, params: {
      invoiceId: number;
      sendType: "VPR" | "VPDF" | "VM" | "VP";
      sendDraft?: boolean;
    }) => {
      // The API expects both fields in the JSON body, not as query parameters
      const { data, error } = await client.PUT("/Invoice/{invoiceId}/sendBy", {
        params: {
          path: { invoiceId: params.invoiceId },
        },
        body: {
          sendType: params.sendType,
          sendDraft: params.sendDraft ?? false,
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  book_invoice: {
    description: "Book an invoice (mark it as paid)",
    inputSchema: z.object({
      invoiceId: z.number().int().positive().describe("The ID of the invoice to book"),
      amount: z.number().describe("Amount to book"),
      date: z.number().int().nonnegative().describe("Booking date (Unix timestamp in seconds)"),
      type: z
        .enum(["FULL_PAYMENT", "N", "CB", "CF", "O", "OF", "MTC"])
        .describe(
          "Booking type: FULL_PAYMENT=normal booking, N=partial booking, CB=reduced by cash discount (Skonto), " +
            "CF=currency fluctuation (deprecated), O=reduced or higher for other reasons, " +
            "OF=higher due to reminder charges, MTC=reduced by monetary traffic costs"
        ),
      checkAccountId: z.number().int().positive().describe("ID of the check account"),
      checkAccountTransactionId: z.number().int().positive().optional().describe("ID of an existing transaction to link"),
      createFeed: z.boolean().optional().describe("Create a feed entry"),
    }),
    handler: async (client: SevdeskClient, params: {
      invoiceId: number;
      amount: number;
      date: number;
      type: "FULL_PAYMENT" | "N" | "CB" | "CF" | "O" | "OF" | "MTC";
      checkAccountId: number;
      checkAccountTransactionId?: number;
      createFeed?: boolean;
    }) => {
      const { data, error } = await client.PUT("/Invoice/{invoiceId}/bookAmount", {
        params: {
          path: { invoiceId: params.invoiceId },
        },
        body: {
          amount: params.amount,
          date: params.date,
          type: params.type,
          checkAccount: {
            id: params.checkAccountId,
            objectName: "CheckAccount",
          },
          checkAccountTransaction: params.checkAccountTransactionId
            ? {
                id: params.checkAccountTransactionId,
                objectName: "CheckAccountTransaction",
              }
            : undefined,
          createFeed: params.createFeed,
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  cancel_invoice: {
    description: "Cancel an invoice (creates a cancellation invoice)",
    inputSchema: z.object({
      invoiceId: z.number().int().positive().describe("The ID of the invoice to cancel"),
    }),
    handler: async (client: SevdeskClient, params: { invoiceId: number }) => {
      const { data, error } = await client.POST("/Invoice/{invoiceId}/cancelInvoice", {
        params: {
          path: { invoiceId: params.invoiceId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },
};
