import express, { type NextFunction, type Request, type Response } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpResourceUrl, type Config } from '../config.js';
import { SCOPE, type McpOAuthProvider } from '../auth/provider.js';
import type { ToolContext } from '../mcp/context.js';
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from '../mcp/server.js';
import type { Logger } from '../util/logger.js';

export function createApp(deps: { config: Config; provider: McpOAuthProvider; toolContext: ToolContext; logger: Logger }) {
  const { config, provider, toolContext, logger } = deps;
  const resourceUrl = mcpResourceUrl(config);
  const app = express();

  app.disable('x-powered-by');
  // Cloudflare -> Traefik -> app. Real client IP is also read from CF-Connecting-IP for the login limiter.
  app.set('trust proxy', 2);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVER_NAME, version: SERVER_VERSION });
  });

  // Discovery (/.well-known/*), dynamic client registration, /authorize, /token, /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.PUBLIC_URL),
      resourceServerUrl: resourceUrl,
      scopesSupported: [SCOPE],
      resourceName: 'Google Ads MCP',
    }),
  );

  // Access-key login page posts here (see auth/provider.ts).
  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), provider.handleLogin);

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  // Stateless Streamable HTTP: a fresh server + transport per request.
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const server = createMcpServer(toolContext);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('mcp request failed', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  // No server-initiated streams or sessions; unauthenticated callers still get 401 first.
  app.all('/mcp', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled error', { error: String(err) });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
