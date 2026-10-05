import { randomBytes } from "node:crypto";
import type pg from "pg";
import { getPool } from "../db.js";
import { decrypt, encrypt } from "../helpers/token-crypto.js";

// Intuit OAuth 2.0 for a single QuickBooks Online company. Tokens live in
// Postgres (qbo.connection), encrypted with TOKEN_ENCRYPTION_KEY. Intuit
// rotates the refresh token on refresh, so every refresh persists the new one.

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

// Refresh this long before the access token's real expiry.
const ACCESS_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const STATE_TTL_S = 15 * 60;

export interface IntuitConfig {
  clientId: string;
  clientSecret: string;
  environment: "production" | "sandbox";
  redirectUri: string;
}

/** Returns the config, or null when any credential is still unset (pre-keys boot). */
export function intuitConfig(): IntuitConfig | null {
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.QBO_REDIRECT_URI?.trim();
  const environment = process.env.QBO_ENVIRONMENT?.trim() === "sandbox" ? "sandbox" : "production";
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, environment, redirectUri };
}

function requireConfig(): IntuitConfig {
  const cfg = intuitConfig();
  if (!cfg) {
    throw new Error(
      "QuickBooks keys are not configured yet (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI)."
    );
  }
  return cfg;
}

export class NotConnectedError extends Error {
  constructor(message = "QuickBooks is not connected. Open the connector's launch URL (GET /) to authorize.") {
    super(message);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const cfg = requireConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    // Body is an OAuth error object ({error, error_description}); it never contains tokens.
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(": ");
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(`Intuit token endpoint returned HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
    (err as Error & { status?: number; oauthError?: string }).status = res.status;
    (err as Error & { status?: number; oauthError?: string }).oauthError = detail;
    throw err;
  }
  return (await res.json()) as TokenResponse;
}

// ── Authorize / callback ───────────────────────────────────────────────────

export async function buildAuthorizeUrl(): Promise<string> {
  const cfg = requireConfig();
  const state = randomBytes(24).toString("base64url");
  const pool = getPool();
  await pool.query("DELETE FROM qbo.oauth_state WHERE expires_at < now()");
  await pool.query(
    "INSERT INTO qbo.oauth_state (state, expires_at) VALUES ($1, now() + make_interval(secs => $2))",
    [state, STATE_TTL_S]
  );
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.href;
}

/** Consumes a state value; true only the first time a valid, unexpired state is presented. */
export async function consumeState(state: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "DELETE FROM qbo.oauth_state WHERE state = $1 AND expires_at > now()",
    [state]
  );
  return rowCount === 1;
}

export async function currentRealmId(): Promise<string | null> {
  const { rows } = await getPool().query("SELECT realm_id FROM qbo.connection WHERE id = 1");
  return rows[0]?.realm_id ?? null;
}

/** Exchanges the authorization code and stores the connection. */
export async function completeAuthorization(code: string, realmId: string): Promise<void> {
  const cfg = requireConfig();
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
  await saveTokens(realmId, t);
}

async function saveTokens(realmId: string, t: TokenResponse, client: pg.Pool | pg.PoolClient = getPool()): Promise<void> {
  await client.query(
    `INSERT INTO qbo.connection (id, realm_id, refresh_token_enc, refresh_expires_at, access_token_enc, access_expires_at, connected_at, updated_at)
     VALUES (1, $1, $2, now() + make_interval(secs => $3), $4, now() + make_interval(secs => $5), now(), now())
     ON CONFLICT (id) DO UPDATE SET
       realm_id = EXCLUDED.realm_id,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       access_token_enc = EXCLUDED.access_token_enc,
       access_expires_at = EXCLUDED.access_expires_at,
       updated_at = now()`,
    [realmId, encrypt(t.refresh_token), t.x_refresh_token_expires_in ?? 100 * 86400, encrypt(t.access_token), t.expires_in ?? 3600]
  );
}

// ── Access tokens ──────────────────────────────────────────────────────────

let cached: { accessToken: string; realmId: string; expiresAt: number } | undefined;
let inFlight: Promise<{ accessToken: string; realmId: string }> | undefined;

/**
 * Returns a valid access token, refreshing (and persisting the rotated refresh
 * token) when it is within 5 minutes of expiry. The row lock makes the refresh
 * safe even if more than one replica is running.
 */
export async function getAccessToken(): Promise<{ accessToken: string; realmId: string }> {
  if (cached && cached.expiresAt - ACCESS_REFRESH_BUFFER_MS > Date.now()) {
    return { accessToken: cached.accessToken, realmId: cached.realmId };
  }
  if (!inFlight) {
    inFlight = refreshUnderLock().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

async function refreshUnderLock(): Promise<{ accessToken: string; realmId: string }> {
  requireConfig();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT realm_id, refresh_token_enc, access_token_enc, access_expires_at FROM qbo.connection WHERE id = 1 FOR UPDATE"
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new NotConnectedError();
    }

    // Another process may have refreshed while we waited for the lock.
    const storedExpiry = row.access_expires_at ? new Date(row.access_expires_at).getTime() : 0;
    if (row.access_token_enc && storedExpiry - ACCESS_REFRESH_BUFFER_MS > Date.now()) {
      await client.query("COMMIT");
      cached = { accessToken: decrypt(row.access_token_enc), realmId: row.realm_id, expiresAt: storedExpiry };
      return { accessToken: cached.accessToken, realmId: cached.realmId };
    }

    let t: TokenResponse;
    try {
      t = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_token_enc) });
    } catch (err) {
      await client.query("ROLLBACK");
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 401) {
        throw new NotConnectedError(
          `QuickBooks authorization was rejected (${(err as Error).message}). Re-authorize via the launch URL (GET /).`
        );
      }
      throw err;
    }
    await saveTokens(row.realm_id, t, client);
    await client.query("COMMIT");
    console.log("[qbo-oauth] access token refreshed; rotated refresh token persisted");
    cached = { accessToken: t.access_token, realmId: row.realm_id, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
    return { accessToken: cached.accessToken, realmId: cached.realmId };
  } finally {
    client.release();
  }
}

// ── Disconnect ─────────────────────────────────────────────────────────────

/** Revokes the refresh token at Intuit (which also kills its access tokens) and deletes the stored connection. */
export async function disconnect(): Promise<{ revoked: boolean; hadConnection: boolean }> {
  const { rows } = await getPool().query("SELECT refresh_token_enc FROM qbo.connection WHERE id = 1");
  cached = undefined;
  if (!rows[0]) return { revoked: false, hadConnection: false };
  const cfg = requireConfig();
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: decrypt(rows[0].refresh_token_enc) }),
  });
  // Delete locally either way; a token Intuit no longer recognises is already dead.
  await getPool().query("DELETE FROM qbo.connection WHERE id = 1");
  return { revoked: res.ok, hadConnection: true };
}

export async function connectionStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  realmId?: string;
  connectedAt?: string;
  refreshExpiresAt?: string;
}> {
  const configured = intuitConfig() !== null;
  const { rows } = await getPool().query(
    "SELECT realm_id, connected_at, refresh_expires_at FROM qbo.connection WHERE id = 1"
  );
  if (!rows[0]) return { configured, connected: false };
  return {
    configured,
    connected: true,
    realmId: rows[0].realm_id,
    connectedAt: new Date(rows[0].connected_at).toISOString(),
    refreshExpiresAt: rows[0].refresh_expires_at ? new Date(rows[0].refresh_expires_at).toISOString() : undefined,
  };
}
