import pg from "pg";

// Lazily created so the stdio entry point (and tests) never need a database.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: url, max: 5 });
  }
  return pool;
}

// Everything lives in its own schema so it can share the Postgres instance with
// other Viori services without colliding.
const MIGRATION = `
CREATE SCHEMA IF NOT EXISTS qbo;

-- Single QuickBooks company connection (id is always 1).
CREATE TABLE IF NOT EXISTS qbo.connection (
  id                  int PRIMARY KEY CHECK (id = 1),
  realm_id            text NOT NULL,
  refresh_token_enc   text NOT NULL,
  refresh_expires_at  timestamptz,
  access_token_enc    text,
  access_expires_at   timestamptz,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One-time OAuth state values for the Intuit authorize round trip.
CREATE TABLE IF NOT EXISTS qbo.oauth_state (
  state       text PRIMARY KEY,
  expires_at  timestamptz NOT NULL
);

-- MCP client OAuth (claude.ai connector) - same shape as viori-memory-mcp.
CREATE TABLE IF NOT EXISTS qbo.mcp_clients (
  client_id   text PRIMARY KEY,
  client_name text,
  info        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS qbo.mcp_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES qbo.mcp_clients(client_id),
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  resource       text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
CREATE TABLE IF NOT EXISTS qbo.mcp_tokens (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id   text NOT NULL REFERENCES qbo.mcp_clients(client_id),
  scopes      text[] NOT NULL DEFAULT '{}',
  resource    text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
`;

export async function migrate(): Promise<void> {
  await getPool().query(MIGRATION);
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
