import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getPool } from './db.js';

const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 90 * 24 * 60 * 60; // 90 days
const CODE_TTL_S = 10 * 60;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');

// The connector password IS the MCP bearer token: one secret, usable either as a
// static "Authorization: Bearer" header or typed into the OAuth sign-in page.
export function bearerMatches(input: string): boolean {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) return false;
  // Hash both sides so the compare is constant-time regardless of length.
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

class PgClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await getPool().query('SELECT info FROM qbo.mcp_clients WHERE client_id = $1', [clientId]);
    return rows[0]?.info;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await getPool().query('INSERT INTO qbo.mcp_clients (client_id, client_name, info) VALUES ($1, $2, $3)', [
      client.client_id,
      client.client_name ?? null,
      client,
    ]);
    return client;
  }
}

export class PgOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new PgClientsStore();

  // Renders the password form; the form posts to /login, which issues the code.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      loginPage({
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        state: params.state ?? '',
        scope: (params.scopes ?? []).join(' '),
        resource: params.resource?.href ?? '',
      }, client.client_name),
    );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const { rows } = await getPool().query(
      'SELECT code_challenge FROM qbo.mcp_codes WHERE code_hash = $1 AND client_id = $2',
      [sha256(code), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError('Invalid authorization code');
    return rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // Single-use: mark used atomically.
    const { rows } = await getPool().query(
      `UPDATE qbo.mcp_codes SET used_at = now()
       WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING redirect_uri, scopes, resource`,
      [sha256(code), client.client_id],
    );
    const row = rows[0];
    if (!row) throw new InvalidGrantError('Authorization code is invalid, expired or already used');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issueTokens(client.client_id, row.scopes, row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    // Rotate: revoke the presented refresh token and issue a new pair.
    const { rows } = await getPool().query(
      `UPDATE qbo.mcp_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()
       RETURNING scopes, resource`,
      [sha256(refreshToken), client.client_id],
    );
    const row = rows[0];
    if (!row) throw new InvalidGrantError('Refresh token is invalid, expired or revoked');
    const granted: string[] = row.scopes;
    if (scopes?.some((s) => !granted.includes(s))) throw new InvalidGrantError('Requested scope exceeds original grant');
    return this.issueTokens(client.client_id, scopes?.length ? scopes : granted, row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (bearerMatches(token)) {
      // The SDK middleware requires an expiry; the static token itself never expires, so report a rolling hour.
      return {
        token,
        clientId: 'static-bearer',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TTL_S,
        extra: { clientName: 'static bearer token' },
      };
    }
    const { rows } = await getPool().query(
      `SELECT t.client_id, t.scopes, t.resource, t.expires_at, c.client_name
       FROM qbo.mcp_tokens t JOIN qbo.mcp_clients c USING (client_id)
       WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { clientName: row.client_name ?? row.client_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    await getPool().query('UPDATE qbo.mcp_tokens SET revoked_at = now() WHERE token_hash = $1 AND client_id = $2', [
      sha256(request.token),
      client.client_id,
    ]);
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
    const access = newSecret();
    const refresh = newSecret();
    await getPool().query(
      `INSERT INTO qbo.mcp_tokens (token_hash, kind, client_id, scopes, resource, expires_at) VALUES
       ($1, 'access', $3, $4, $5, now() + make_interval(secs => $6)),
       ($2, 'refresh', $3, $4, $5, now() + make_interval(secs => $7))`,
      [sha256(access), sha256(refresh), clientId, scopes, resource, ACCESS_TTL_S, REFRESH_TTL_S],
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    };
  }
}

// POST /login: checks the password, then issues an authorization code and redirects back to the client.
export function loginRouter(): express.Router {
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 5,
      skipSuccessfulRequests: true, // only failed password attempts count toward the limit
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many login attempts. Try again in 15 minutes.',
    }),
  );
  router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const f = req.body as Record<string, string | undefined>;
    const fields = {
      client_id: f.client_id ?? '',
      redirect_uri: f.redirect_uri ?? '',
      code_challenge: f.code_challenge ?? '',
      state: f.state ?? '',
      scope: f.scope ?? '',
      resource: f.resource ?? '',
    };

    // Re-validate what the authorize handler already checked; the form is client-controlled.
    const { rows } = await getPool().query('SELECT info FROM qbo.mcp_clients WHERE client_id = $1', [fields.client_id]);
    const client: OAuthClientInformationFull | undefined = rows[0]?.info;
    if (!client || !client.redirect_uris.includes(fields.redirect_uri) || !fields.code_challenge) {
      res.status(400).type('text').send('Invalid authorization request');
      return;
    }

    if (!bearerMatches(f.password ?? '')) {
      res.status(401).type('html').send(loginPage(fields, client.client_name, 'Wrong password.'));
      return;
    }

    const code = newSecret();
    await getPool().query(
      `INSERT INTO qbo.mcp_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
      [
        sha256(code),
        client.client_id,
        fields.redirect_uri,
        fields.code_challenge,
        fields.scope ? fields.scope.split(' ') : [],
        fields.resource || null,
        CODE_TTL_S,
      ],
    );
    const target = new URL(fields.redirect_uri);
    target.searchParams.set('code', code);
    if (fields.state) target.searchParams.set('state', fields.state);
    res.redirect(302, target.href);
  });
  return router;
}

function loginPage(fields: Record<string, string>, clientName?: string, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Viori QuickBooks sign in</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f6f6f4; color: #1a1a1a; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    form { background: #fff; padding: 28px; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.08); width: 100%; max-width: 340px; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    p { font-size: 14px; color: #555; margin: 0 0 18px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px; }
    button { margin-top: 14px; width: 100%; padding: 10px; font-size: 15px; border: 0; border-radius: 6px; background: #1a1a1a; color: #fff; cursor: pointer; }
    .err { color: #b00020; font-size: 14px; margin: 0 0 12px; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Viori QuickBooks</h1>
    <p>${escapeHtml(clientName ?? 'An application')} wants access to Viori's QuickBooks. Enter the connector bearer token (Railway variable MCP_BEARER_TOKEN).</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
      ${hidden}
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}
