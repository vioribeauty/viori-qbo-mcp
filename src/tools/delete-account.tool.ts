import { deleteQuickbooksAccount } from "../handlers/delete-quickbooks-account.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "delete_account";
const toolDescription = "Delete (make inactive) an account in the QuickBooks Online chart of accounts. QBO cannot hard-delete accounts.";
const toolSchema = z.object({
  account_id: z.string().describe("ID of the account to make inactive"),
});

const toolHandler = async ({ params }: any) => {
  const response = await deleteQuickbooksAccount(params.account_id);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error deleting account: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Account made inactive:` }, { type: "text" as const, text: JSON.stringify(response.result) }] };
};

export const DeleteAccountTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
