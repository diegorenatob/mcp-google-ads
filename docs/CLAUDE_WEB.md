# Connecting from Claude

Sources (read 2026-10-06):
- https://claude.com/docs/connectors/custom/remote-mcp
- https://claude.com/docs/connectors/building/authentication
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

## Requirements Claude imposes (and how this server meets them)

| Claude requirement | This server |
|---|---|
| Publicly reachable over HTTPS (Claude connects from Anthropic's cloud) | Cloudflare + Traefik + Let's Encrypt |
| Transport: HTTP (Streamable HTTP); `/sse` URLs select legacy SSE | Streamable HTTP at `/mcp` |
| Unauthenticated request → **401** with `WWW-Authenticate: Bearer resource_metadata="…"` (Claude ignores it on 200) | `requireBearerAuth` from the SDK |
| `/.well-known/oauth-protected-resource` with `resource` = the URL the user typed | Served by `mcpAuthRouter` |
| RFC 8414 metadata at `/.well-known/oauth-authorization-server` | Served by `mcpAuthRouter` |
| Auth options: authless, DCR ("Register automatically"), CIMD, or your own client ID | **DCR** (default), own client ID also works |
| Callback for claude.ai / Desktop / mobile: `https://claude.ai/api/mcp/auth_callback` | In the redirect allowlist |
| Callback for Claude Code: `http://localhost:<port>/callback`, `http://127.0.0.1:<port>/callback` (port-agnostic) | In the redirect allowlist |
| Discovery/registration/token endpoints answer within 10 s (refresh within 30 s) | Local, no external calls in the auth path |
| Egress range to allowlist if a firewall is used: `160.79.104.0/21` | Optional allowlist (see SECURITY.md) |

Plans: Free (1 custom connector), Pro, Max (unlimited), Team/Enterprise (added by
organization owners in *Organization settings → Connectors*).

## Claude web, Desktop, mobile

1. **Customize → Connectors → Add custom connector**.
2. Name: `Google Ads`. URL: `https://<MCP_DOMAIN>/mcp` (exactly this, including `/mcp`).
3. Leave authentication on **Register automatically** (DCR). Save.
4. Click **Connect** → a login page from this server opens → enter your access key (`MCP_ACCESS_KEY` from the server's `.env`).
5. Back in Claude, enable the connector in a chat ("Search and tools" menu).

Try: *"Use Google Ads to research keywords for 'horas extras' in Brazil."*

## Claude Code

```bash
claude mcp add --transport http google-ads https://<MCP_DOMAIN>/mcp
# then inside Claude Code: /mcp  → select google-ads → Authenticate
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Couldn't reach the server" | DNS/TLS: `curl -I https://<MCP_DOMAIN>/health` must return 200 |
| Connect does nothing / no login page | `/mcp` must return **401** (not 403/200) without a token; check Traefik isn't adding basic auth |
| `invalid redirect_uri` on login | Claude's callback missing from allowlist; check `MCP_ALLOWED_REDIRECT_URIS` |
| Tools listed but every call fails with `invalid_grant` | Google refresh token expired (7-day limit in Testing mode): `npm run google:auth` |
| Tools return "requires Basic access" | Expected on Explorer for Phase 2 tools; they shouldn't even be listed — check `GOOGLE_ADS_ACCESS_LEVEL` |
| Connector stopped working after redeploy | `data/` volume lost → clients/refresh tokens gone: reconnect in Claude |
