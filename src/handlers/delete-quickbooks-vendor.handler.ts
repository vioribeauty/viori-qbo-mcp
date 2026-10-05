import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * "Delete" a vendor. QuickBooks Online does not hard-delete list entities;
 * the API equivalent of the UI's delete is setting Active=false. (Upstream
 * called quickbooks.deleteVendor, which node-quickbooks does not provide.)
 */
export async function deleteQuickbooksVendor(vendor: any): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    return new Promise((resolve) => {
      quickbooks.updateVendor(
        { Id: vendor.Id, SyncToken: vendor.SyncToken, sparse: true, Active: false },
        (err: any, updatedVendor: any) => {
          if (err) {
            resolve({ result: null, isError: true, error: formatError(err) });
          } else {
            resolve({ result: updatedVendor, isError: false, error: null });
          }
        }
      );
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
