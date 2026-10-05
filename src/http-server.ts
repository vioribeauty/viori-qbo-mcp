import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { PgOAuthProvider, bearerMatches, loginRouter } from "./auth.js";
import { dbHealthy, migrate } from "./db.js";
import {
  buildAuthorizeUrl,
  completeAuthorization,
  connectionStatus,
  consumeState,
  currentRealmId,
  disconnect,
  intuitConfig,
} from "./clients/intuit-oauth.js";
import { registerAllTools } from "./tools/register-all.js";

// Hosted entry point: Streamable HTTP MCP at /mcp plus the Intuit OAuth routes
// (GET / launch, GET /callback, GET+POST /disconnect). Boots and serves /health
// before QuickBooks keys exist.

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = (
  process.env.PUBLIC_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)
).replace(/\/$/, "");
const MCP_URL = new URL("/mcp", PUBLIC_URL);

let dbReady = false;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200, res?: express.Response) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f6f4; color: #1a1a1a; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
  main { background: #fff; padding: 28px; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.08); width: 100%; max-width: 420px; }
  h1 { font-size: 18px; margin: 0 0 10px; } p { font-size: 14px; color: #444; line-height: 1.5; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 14px; width: 100%; padding: 10px; font-size: 15px; border: 0; border-radius: 6px; background: #1a1a1a; color: #fff; cursor: pointer; }
  .err { color: #b00020; } .ok { color: #1d6b3a; } code { font-size: 13px; }
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  res?.status(status).setHeader("Cache-Control", "no-store");
  res?.type("html").send(html);
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "Viori QuickBooks Online", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server);
  return server;
}

async function initDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      dbReady = true;
      console.log("database migrations applied");
      return;
    } catch (err) {
      console.error(`database init attempt ${attempt} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, Math.min(30000, 3000 * attempt)));
    }
  }
}

function main() {
  const provider = new PgOAuthProvider();
  const app = express();
  // Railway adds two X-Forwarded-For hops (client, edge node).
  app.set("trust proxy", 2);

  app.get("/health", async (_req, res) => {
    const db = dbReady && (await dbHealthy());
    let qbo: { configured: boolean; connected: boolean } = { configured: intuitConfig() !== null, connected: false };
    if (db) {
      try {
        const s = await connectionStatus();
        qbo = { configured: s.configured, connected: s.connected };
      } catch {
        /* reported as not connected */
      }
    }
    res.json({ ok: true, db, qbo });
  });

  const requireDb: express.RequestHandler = (_req, res, next) => {
    if (!dbReady) {
      page("Starting up", "<p>The database is not ready yet. Try again in a moment.</p>", 503, res);
      return;
    }
    next();
  };

  // ── Intuit OAuth ─────────────────────────────────────────────────────────

  // Launch URL: starts the QuickBooks authorization.
  app.get("/", requireDb, async (_req, res) => {
    if (!intuitConfig()) {
      page(
        "Viori QuickBooks connector",
        "<p>QuickBooks keys are not configured yet. Set <code>QBO_CLIENT_ID</code>, <code>QBO_CLIENT_SECRET</code> and <code>QBO_REDIRECT_URI</code> in Railway, then reload.</p>",
        503,
        res
      );
      return;
    }
    try {
      res.redirect(302, await buildAuthorizeUrl());
    } catch (err) {
      console.error("launch failed:", (err as Error).message);
      page("Could not start authorization", "<p class=err>Unexpected error. Check the service logs.</p>", 500, res);
    }
  });

  app.get("/callback", requireDb, async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.error) {
      page("Authorization cancelled", `<p class=err>QuickBooks returned: ${escapeHtml(q.error)}</p>`, 400, res);
      return;
    }
    if (!q.code || !q.state || !q.realmId) {
      page("Invalid callback", "<p class=err>Missing code, state or realmId.</p>", 400, res);
      return;
    }
    if (!(await consumeState(q.state))) {
      page("Invalid callback", "<p class=err>This authorization link expired or was already used. Start again from the launch URL.</p>", 400, res);
      return;
    }
    // Never let a different company silently replace the connected one.
    const pinned = process.env.QBO_REALM_ID?.trim();
    const existing = await currentRealmId();
    if ((pinned && q.realmId !== pinned) || (existing && existing !== q.realmId)) {
      page(
        "Different company",
        "<p class=err>This connector is bound to a different QuickBooks company. Disconnect it first (/disconnect) if you really mean to switch.</p>",
        409,
        res
      );
      return;
    }
    try {
      await completeAuthorization(q.code, q.realmId);
      console.log(`QuickBooks connected (realm ${q.realmId})`);
      page("Connected to QuickBooks", `<p class=ok>Viori's QuickBooks company (realm ${escapeHtml(q.realmId)}) is connected. You can close this window.</p>`, 200, res);
    } catch (err) {
      console.error("token exchange failed:", (err as Error).message);
      page("Connection failed", "<p class=err>QuickBooks rejected the token exchange. Check the service logs and try again.</p>", 502, res);
    }
  });

  // Disconnect URL. Revoking is destructive, so GET shows a confirmation form and
  // POST (with the bearer token) performs the revoke. Intuit also lands users
  // here after they disconnect the app from inside QuickBooks.
  const disconnectPage = (res: express.Response, msg = "", status = 200) =>
    page(
      "Disconnect QuickBooks",
      `${msg}<p>This revokes the connector's QuickBooks tokens at Intuit and deletes them from the database. Claude will lose QuickBooks access until someone reconnects via the launch URL.</p>
       <form method="post" action="/disconnect">
         <input type="password" name="token" autocomplete="off" required aria-label="Bearer token" placeholder="MCP bearer token">
         <button type="submit">Revoke and disconnect</button>
       </form>`,
      status,
      res
    );

  app.get("/disconnect", requireDb, async (_req, res) => {
    const s = await connectionStatus().catch(() => null);
    if (s && !s.connected) {
      page("Disconnected", "<p>QuickBooks is not connected (or has already been disconnected).</p>", 200, res);
      return;
    }
    disconnectPage(res);
  });

  app.post(
    "/disconnect",
    requireDb,
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (!bearerMatches(String((req.body as Record<string, unknown>)?.token ?? ""))) {
        disconnectPage(res, "<p class=err>Wrong token.</p>", 401);
        return;
      }
      try {
        const r = await disconnect();
        console.log(`QuickBooks disconnected (revoked at Intuit: ${r.revoked})`);
        page(
          "Disconnected",
          r.hadConnection
            ? `<p class=ok>Tokens deleted${r.revoked ? " and revoked at Intuit" : " (Intuit no longer recognised them)"}.</p>`
            : "<p>Nothing was connected.</p>",
          200,
          res
        );
      } catch (err) {
        console.error("disconnect failed:", (err as Error).message);
        page("Disconnect failed", "<p class=err>Unexpected error. Check the service logs.</p>", 500, res);
      }
    }
  );

  // ── MCP (OAuth for claude.ai connectors, or the static bearer token) ─────

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(PUBLIC_URL),
      resourceServerUrl: MCP_URL,
      resourceName: "Viori QuickBooks",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    })
  );
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: MCP_URL.href, authorization_servers: [new URL(PUBLIC_URL).href], resource_name: "Viori QuickBooks" });
  });
  app.use("/login", loginRouter());

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL),
  });

  // Stateless Streamable HTTP: a fresh server + transport per request.
  app.post("/mcp", requireDb, bearer, express.json({ limit: "25mb" }), async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp error:", (err as Error).message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  app.all("/mcp", bearer, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  // Listen first so /health answers even while the database is still coming up.
  app.listen(PORT, () => console.log(`viori-qbo-mcp listening on ${PORT} (${MCP_URL.href})`));
  void initDatabase();
}

main();
