import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * "Delete" an account. The QBO API cannot hard-delete accounts; the UI's delete
 * is Active=false, which is what this does.
 */
export async function deleteQuickbooksAccount(accountId: string): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();
    return new Promise((resolve) => {
      (quickbooks as any).getAccount(accountId, (getErr: any, account: any) => {
        if (getErr) {
          resolve({ result: null, isError: true, error: formatError(getErr) });
          return;
        }
        (quickbooks as any).updateAccount(
          { Id: account.Id, SyncToken: account.SyncToken, Name: account.Name, sparse: true, Active: false },
          (err: any, updated: any) => {
            if (err) resolve({ result: null, isError: true, error: formatError(err) });
            else resolve({ result: updated, isError: false, error: null });
          }
        );
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
