import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface TransactionListOptions {
  start_date?: string;
  end_date?: string;
  date_macro?: string;
  accounting_method?: "Cash" | "Accrual";
  transaction_type?: string;
  source_account?: string;
  source_account_type?: string;
  vendor?: string;
  customer?: string;
  department?: string;
  class?: string;
  memo?: string;
  columns?: string;
  sort_by?: string;
  sort_order?: "ascend" | "descend";
  group_by?: string;
}

const PASSTHROUGH: (keyof TransactionListOptions)[] = [
  "start_date", "end_date", "date_macro", "accounting_method", "transaction_type", "source_account",
  "source_account_type", "vendor", "customer", "department", "class", "memo", "columns", "sort_by",
  "sort_order", "group_by",
];

export async function getQuickbooksTransactionList(options: TransactionListOptions): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();
    const params: Record<string, any> = {};
    for (const key of PASSTHROUGH) {
      if (options[key] !== undefined && options[key] !== "") params[key] = options[key];
    }

    return new Promise((resolve) => {
      (quickbooks as any).reportTransactionList(params, (err: any, report: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: report, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
