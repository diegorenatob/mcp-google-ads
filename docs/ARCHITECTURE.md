# Architecture

## Overview

```
Claude (claude.ai / Desktop / mobile / Claude Code)
   │  HTTPS, egress 160.79.104.0/21
   ▼
Cloudflare (proxied, Full strict SSL)
   ▼
Traefik v2 (TLS via Let's Encrypt, Host rule = MCP_DOMAIN)
   ▼
mcp-google-ads container (Node 24, Express 5, port 8080)
   ├── OAuth 2.1 Authorization Server  (/.well-known/*, /authorize, /token, /register, /revoke, /login)
   ├── MCP endpoint, Streamable HTTP    (/mcp, protected by Bearer JWT)
   ├── Health                           (/health, public, no secrets)
   └── Google Ads client
          ├── googleads.googleapis.com/v23  (OAuth refresh token, server-side)
          └── suggestqueries.google.com     (autocomplete, unofficial)
   ▼
./data volume  (registered OAuth clients, hashed refresh tokens, daily ops counter)
```

## Two separate OAuth layers

Keeping these apart is the most important design idea.

| Layer | Who authenticates | Against what | Where secrets live |
|---|---|---|---|
| **A. Claude → MCP server** | The person using Claude | This server's own login page (access key) | `MCP_ACCESS_KEY`, `MCP_JWT_SECRET` |
| **B. MCP server → Google Ads** | The server itself | Google OAuth (refresh token) | `GOOGLE_ADS_*` |

Claude never sees Google credentials. Google never sees Claude's tokens.
The server is **single-tenant**: one Google Ads setup, one owner access key.

## Layer A: built-in OAuth 2.1 (what Claude web needs)

Implemented with the official SDK pieces from `@modelcontextprotocol/sdk/server/auth`:
`mcpAuthRouter` (metadata, DCR, authorize, token, revoke) + a custom `OAuthServerProvider`
+ `requireBearerAuth` on `/mcp`. Authorization server and resource server are the same host.

### Discovery

1. Claude calls `POST /mcp` without a token.
2. Server answers **401** with
   `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`.
3. `/.well-known/oauth-protected-resource[/mcp]` returns
   `{ "resource": "<PUBLIC_URL>/mcp", "authorization_servers": ["<PUBLIC_URL>"] }`.
   `resource` must match **exactly** the URL the user enters in Claude.
4. `/.well-known/oauth-authorization-server` returns RFC 8414 metadata
   (`registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, …).

### Registration (DCR, RFC 7591)

- `POST /register` creates a client. Only redirect URIs on the allowlist are accepted:
  - `https://claude.ai/api/mcp/auth_callback` (claude.ai, Desktop, mobile)
  - `http://localhost:<any>/callback` and `http://127.0.0.1:<any>/callback` (Claude Code)
  - extra values from `MCP_ALLOWED_REDIRECT_URIS`
- Clients persist in `data/oauth.json` so a container restart doesn't break the connector.
- Registration is rate-limited and capped (max 50 clients; oldest unused are pruned).

### Authorization (login)

1. `GET /authorize` → provider stores a *pending request* (client, redirect URI, state,
   PKCE challenge, scopes) under a random id (TTL 10 min) and renders the login page.
2. `POST /login` → constant-time access-key check, **rate-limited** (5 failures / 15 min
   per client IP, read from `CF-Connecting-IP` behind Cloudflare), CSRF-safe because the
   pending id is single-use and unguessable.
3. On success: one-time authorization code (32 random bytes, TTL 5 min) and redirect to
   `redirect_uri?code=…&state=…`.

### Tokens

- Access token: **JWT HS256** signed with `MCP_JWT_SECRET`; claims `iss`, `aud=<PUBLIC_URL>/mcp`,
  `sub=owner`, `scope=ads.read`, `exp` (`MCP_ACCESS_TOKEN_TTL_SECONDS`, default 1 h).
- Refresh token: opaque random value; only its **SHA-256 hash** is stored; rotated on every use;
  TTL `MCP_REFRESH_TOKEN_TTL_DAYS` (default 30).
- PKCE S256 is mandatory (validated by the SDK).
- Kill switches: rotate `MCP_JWT_SECRET` (kills access tokens) and delete `data/oauth.json`
  (kills refresh tokens and clients) → everyone must log in again.

## Layer B: Google Ads client

- Thin REST client over `fetch` (no heavy SDK): exchanges the refresh token for an access
  token, caches it until ~60 s before expiry.
- Headers: `Authorization`, `login-customer-id`, `developer-token` only if set.
- Error mapper turns Google error payloads into the user messages listed in `TOOLS.md`.
- **Ops budget**: a per-day counter in `data/` rejects calls locally once
  `GOOGLE_ADS_DAILY_OPS_BUDGET` is reached (Explorer allows 2,880 production ops/day).
- **Cache**: in-memory `(tool, args)` → result, TTL `CACHE_TTL_HOURS`; suggestions change slowly. GAQL and status calls are never cached.
- **Feature gating**: Keyword Planner tools are registered only when
  `GOOGLE_ADS_ACCESS_LEVEL=basic`.

## MCP transport

- Streamable HTTP, **stateless** (new `McpServer` + transport per request, no session
  affinity), JSON responses enabled. Works behind any proxy and survives restarts.
- `/mcp` handles `POST`; `GET`/`DELETE` return 405 (no server-initiated streams needed).

## Source layout

```
src/
  index.ts                 # boot: config, wiring, listen, graceful shutdown
  config.ts                # env parsing + validation (zod); errors name variables, never values
  http/app.ts              # express: trust proxy, /health, auth router, /login, /mcp
  auth/provider.ts         # OAuthServerProvider: clients, key login, JWT + refresh rotation
  auth/store.ts            # JSON-file persistence (clients, refresh-token hashes)
  auth/redirects.ts        # redirect URI allowlist (Claude callbacks)
  auth/login-page.ts       # minimal HTML login form, strict CSP
  auth/rate-limit.ts       # in-memory failure counter per IP
  mcp/server.ts            # McpServer factory; registers tools by access level
  mcp/context.ts           # shared helpers: result format, cache wrapper, account checks
  mcp/tools/research.ts    # suggest_keywords, autocomplete_keywords, research_keywords, search_locations
  mcp/tools/accounts.ts    # list_accounts, run_gaql_query, search_terms_report, api_status
  mcp/tools/planner.ts     # keyword_ideas, keyword_metrics, keyword_forecast (Basic only)
  ads/client.ts            # Google Ads REST client, token cache, error mapping
  ads/errors.ts, budget.ts, gaql.ts, constants.ts
  sources/autocomplete.ts  # Google Autocomplete (unofficial)
  util/cache.ts, logger.ts, json-file.ts
scripts/
  google-auth.ts           # Google OAuth paste-the-URL flow → writes refresh token to .env
  google-check.ts          # diagnostics (no secrets)
  scan-secrets.sh          # gitleaks + .env values + Google patterns
test/
  *.test.ts                # vitest unit tests
  e2e.ts                   # the exact flow Claude performs, against a running server
```

## Technology choices

| Choice | Why |
|---|---|
| TypeScript + `@modelcontextprotocol/sdk` 1.32 | Official SDK ships the OAuth router, DCR and bearer middleware Claude needs |
| Express 5 | Required by the SDK auth router |
| zod 4 | Supported by the SDK (`^3.25 \|\| ^4.0`) |
| TypeScript **5.9.x** (pinned) | TS 7 was installed by default but is too new; pin for stability |
| `jose` | Standards-compliant JWT signing/verification |
| JSON file store (no DB) | Single tenant, tiny data; nothing extra to run or back up |
| REST over `fetch` instead of a Google Ads SDK | Few endpoints, smaller image, fewer dependencies |
| Node 24 slim image, non-root user | Small attack surface |
