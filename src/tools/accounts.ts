import { z } from "zod";
import type { SevdeskClient } from "../client.js";

// sevdesk is a German service, so "today" means the calendar date in Germany, not in UTC
export function todayInBerlin(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export const accountTools = {
  list_check_accounts: {
    description: "List all check accounts (bank accounts) from sevdesk",
    inputSchema: z.object({
      limit: z.number().int().positive().optional().describe("Limit the number of results"),
      offset: z.number().int().nonnegative().optional().describe("Skip a number of results"),
    }),
    handler: async (client: SevdeskClient, params: {
      limit?: number;
      offset?: number;
    }) => {
      const { data, error } = await client.GET("/CheckAccount", {
        params: {
          query: {
            limit: params.limit,
            offset: params.offset,
          } as any,
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_check_account: {
    description: "Get a specific check account by ID",
    inputSchema: z.object({
      checkAccountId: z.number().int().positive().describe("The ID of the check account"),
    }),
    handler: async (client: SevdeskClient, params: { checkAccountId: number }) => {
      const { data, error } = await client.GET("/CheckAccount/{checkAccountId}", {
        params: {
          path: { checkAccountId: params.checkAccountId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_check_account_balance: {
    description: "Get the current balance of a check account",
    inputSchema: z.object({
      checkAccountId: z.number().int().positive().describe("The ID of the check account"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in the format YYYY-MM-DD")
        .optional()
        .describe("Only consider transactions up to this date (YYYY-MM-DD). Default: today (Europe/Berlin)"),
    }),
    handler: async (client: SevdeskClient, params: {
      checkAccountId: number;
      date?: string;
    }) => {
      const { data, error } = await client.GET("/CheckAccount/{checkAccountId}/getBalanceAtDate", {
        params: {
          path: { checkAccountId: params.checkAccountId },
          query: {
            date: params.date ?? todayInBerlin(),
          },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  list_transactions: {
    description: "List all transactions of a check account",
    inputSchema: z.object({
      checkAccountId: z.number().int().positive().describe("The ID of the check account"),
      startDate: z
        .union([z.iso.date(), z.iso.datetime({ offset: true })])
        .optional()
        .describe("Only transactions from this point on (ISO 8601 date or date-time, e.g. 2026-01-31)"),
      endDate: z
        .union([z.iso.date(), z.iso.datetime({ offset: true })])
        .optional()
        .describe("Only transactions up to this point (ISO 8601 date or date-time, e.g. 2026-01-31)"),
      paymtPurpose: z.string().optional().describe("Filter by payment purpose"),
      isBooked: z.boolean().optional().describe("Filter by booked status"),
      limit: z.number().int().positive().optional().describe("Limit the number of results"),
      offset: z.number().int().nonnegative().optional().describe("Skip a number of results"),
    }),
    handler: async (client: SevdeskClient, params: {
      checkAccountId: number;
      startDate?: string;
      endDate?: string;
      paymtPurpose?: string;
      isBooked?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const { data, error } = await client.GET("/CheckAccountTransaction", {
        params: {
          query: {
            "checkAccount[id]": params.checkAccountId,
            "checkAccount[objectName]": "CheckAccount",
            startDate: params.startDate,
            endDate: params.endDate,
            paymtPurpose: params.paymtPurpose,
            isBooked: params.isBooked,
            limit: params.limit,
            offset: params.offset,
          } as any,
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  get_transaction: {
    description: "Get a specific transaction by ID",
    inputSchema: z.object({
      transactionId: z.number().int().positive().describe("The ID of the transaction"),
    }),
    handler: async (client: SevdeskClient, params: { transactionId: number }) => {
      const { data, error } = await client.GET("/CheckAccountTransaction/{checkAccountTransactionId}", {
        params: {
          path: { checkAccountTransactionId: params.transactionId },
        },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },

  create_transaction: {
    description: "Create a new transaction in a check account",
    inputSchema: z.object({
      checkAccountId: z.number().int().positive().describe("The ID of the check account"),
      amount: z.number().describe("Transaction amount (positive for credit, negative for debit)"),
      valueDate: z.string().describe("Value date (ISO date string YYYY-MM-DD)"),
      entryDate: z.string().optional().describe("Entry date (ISO date string YYYY-MM-DD)"),
      paymtPurpose: z.string().optional().describe("Payment purpose/description"),
      payeePayerName: z.string().optional().describe("Name of payee or payer"),
      payeePayerAcctNo: z.string().optional().describe("Account number of payee/payer"),
      payeePayerBankCode: z.string().optional().describe("Bank code of payee/payer"),
    }),
    handler: async (client: SevdeskClient, params: {
      checkAccountId: number;
      amount: number;
      valueDate: string;
      entryDate?: string;
      paymtPurpose?: string;
      payeePayerName?: string;
      payeePayerAcctNo?: string;
      payeePayerBankCode?: string;
    }) => {
      const { data, error } = await client.POST("/CheckAccountTransaction", {
        body: {
          checkAccount: {
            id: params.checkAccountId,
            objectName: "CheckAccount",
          },
          amount: params.amount,
          valueDate: params.valueDate,
          entryDate: params.entryDate,
          paymtPurpose: params.paymtPurpose,
          payeePayerName: params.payeePayerName,
          payeePayerAcctNo: params.payeePayerAcctNo,
          payeePayerBankCode: params.payeePayerBankCode,
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
  },
};
