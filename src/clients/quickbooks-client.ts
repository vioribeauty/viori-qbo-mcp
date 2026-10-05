import QuickBooks from "node-quickbooks";
import { getAccessToken, intuitConfig } from "./intuit-oauth.js";
import { guardWrites } from "../helpers/write-guard.js";

// Hosted (Railway) client. Tokens come from Postgres via intuit-oauth.ts rather
// than a local .env file, and every QuickBooks instance handed to a handler is
// wrapped by the write guard (dry_run + "[Claude]" memo stamping).
//
// The public surface (QuickbooksClient.getInstance / getAuthCredentials and the
// quickbooksClient singleton) is unchanged so the upstream handlers work as-is.

export class QuickbooksClient {
  static async getInstance(): Promise<QuickBooks> {
    return quickbooksClient.authenticate();
  }

  // Raw credentials for handlers that call QBO endpoints node-quickbooks does
  // not wrap (e.g. POST /upload for binary attachments).
  static async getAuthCredentials(): Promise<{ accessToken: string; realmId: string; isSandbox: boolean }> {
    const { accessToken, realmId } = await getAccessToken();
    return { accessToken, realmId, isSandbox: environment() === "sandbox" };
  }

  async authenticate(): Promise<QuickBooks> {
    const cfg = intuitConfig();
    if (!cfg) {
      throw new Error("QuickBooks keys are not configured yet (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI).");
    }
    const { accessToken, realmId } = await getAccessToken();
    const qb = new QuickBooks(
      cfg.clientId,
      cfg.clientSecret,
      accessToken,
      false, // no token secret for OAuth 2.0
      realmId,
      cfg.environment === "sandbox",
      false, // debug
      null, // minor version (library default)
      "2.0",
      undefined // refresh handled by intuit-oauth.ts, never by node-quickbooks
    );
    return guardWrites(qb);
  }
}

function environment(): "production" | "sandbox" {
  return process.env.QBO_ENVIRONMENT?.trim() === "sandbox" ? "sandbox" : "production";
}

export const quickbooksClient = new QuickbooksClient();
