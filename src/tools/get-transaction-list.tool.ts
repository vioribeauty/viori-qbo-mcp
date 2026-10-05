import { getQuickbooksTransactionList } from "../handlers/get-quickbooks-transaction-list.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "get_transaction_list";
const toolDescription = "Generate a Transaction List report from QuickBooks Online (every transaction in a period, filterable by type, account, name, class or department).";
const toolSchema = z.object({
  start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
  date_macro: z.string().optional().describe("Predefined range instead of dates, e.g. 'Last Month', 'This Fiscal Year-to-date'"),
  accounting_method: z.enum(["Cash", "Accrual"]).optional().describe("Accounting method"),
  transaction_type: z.string().optional().describe("Comma-separated types, e.g. 'JournalEntry,Bill,Deposit'"),
  source_account: z.string().optional().describe("Comma-separated account IDs"),
  source_account_type: z.string().optional().describe("Account type filter, e.g. 'Bank'"),
  vendor: z.string().optional().describe("Comma-separated vendor IDs"),
  customer: z.string().optional().describe("Comma-separated customer IDs"),
  department: z.string().optional().describe("Comma-separated department IDs"),
  class: z.string().optional().describe("Comma-separated class IDs"),
  memo: z.string().optional().describe("Comma-separated memo IDs"),
  columns: z.string().optional().describe("Comma-separated columns, e.g. 'tx_date,txn_type,doc_num,name,memo,account_name,subt_nat_amount'"),
  sort_by: z.string().optional().describe("Column to sort by"),
  sort_order: z.enum(["ascend", "descend"]).optional().describe("Sort order"),
  group_by: z.string().optional().describe("Group rows, e.g. 'Account', 'Name', 'Transaction Type'"),
});

const toolHandler = async ({ params }: any) => {
  const response = await getQuickbooksTransactionList(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Transaction List Report:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const GetTransactionListTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
