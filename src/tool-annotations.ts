import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/*
 * MCP tool annotations for every tool. Clients can use them, for example to
 * ask for confirmation before a destructive call. They are hints, not access
 * control; the read-only mode (MCP_READ_ONLY) registers only tools marked
 * readOnlyHint. The table lives outside the tool definitions so that those
 * stay close to the upstream project, and a test fails for any tool without
 * an entry.
 *
 * - destructiveHint: the call changes or removes existing data (including
 *   status changes such as booking or marking as sent), not only adds new data
 * - idempotentHint: repeating the call with the same arguments has no further effect
 * - openWorldHint: the call reaches beyond sevdesk (e.g. sends an email)
 */

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const DELETE: ToolAnnotations = UPDATE;

// Status changes that cannot simply be repeated, e.g. booking a payment twice
const STATE_CHANGE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const toolAnnotations: Record<string, ToolAnnotations> = {
  // Contacts
  list_contacts: READ,
  get_contact: READ,
  create_contact: CREATE,
  update_contact: UPDATE,
  delete_contact: DELETE,

  // Invoices
  list_invoices: READ,
  get_invoice: READ,
  get_invoice_pdf: READ,
  send_invoice_by_email: { ...STATE_CHANGE, openWorldHint: true },
  mark_invoice_as_sent: UPDATE,
  book_invoice: STATE_CHANGE,
  cancel_invoice: STATE_CHANGE,

  // Vouchers
  list_vouchers: READ,
  get_voucher: READ,
  get_voucher_positions: READ,
  book_voucher: STATE_CHANGE,
  upload_voucher_file: CREATE,

  // Check accounts
  list_check_accounts: READ,
  get_check_account: READ,
  get_check_account_balance: READ,
  list_transactions: READ,
  get_transaction: READ,
  create_transaction: CREATE,

  // Parts
  list_parts: READ,
  get_part: READ,
  get_part_stock: READ,
  create_part: CREATE,
  update_part: UPDATE,

  // Tags
  list_tags: READ,
  get_tag: READ,
  list_tag_relations: READ,
  create_tag: CREATE,
  update_tag: UPDATE,
  delete_tag: DELETE,
};
