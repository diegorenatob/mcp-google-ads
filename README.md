# mcp-google-ads

**A Google Ads MCP server that works with _Explorer_ API access.**

> **Status: v0.1.0 — Explorer tools live and tested against a real Google Ads account.** Roadmap: [docs/PLAN.md](docs/PLAN.md).

## Why this one is different

Most Google Ads / Keyword Planner MCP servers are built on `KeywordPlanIdeaService`.
Google only allows those methods from **Basic** access upward, and Basic now requires
**brand verification** of your Google Cloud project. With a freshly approved **Explorer**
access they fail with:

```
This method is not allowed for use with explorer access. Please apply for basic or standard access.
```

**This server is designed for Explorer access from day one.** It only uses methods we
verified to work on Explorer (see [docs/API_ACCESS.md](docs/API_ACCESS.md)), combined
with Google Autocomplete, so you get useful keyword research today. When you get Basic
access, flip one variable and the volume/CPC/forecast tools appear.

| | Typical Keyword Planner MCP | mcp-google-ads |
|---|---|---|
| Works on Explorer access | ❌ | ✅ |
| Keyword suggestions | Basic only | ✅ Explorer (Ads keyword themes + Autocomplete) |
| Question-style keywords | — | ✅ |
| Local intent (city / state) without a geo filter | — | ✅ place-biased variants |
| Location lookup | — | ✅ |
| Read-only GAQL reports / search terms | — | ✅ |
| Search volume, CPC, forecast | Basic | ✅ with Basic (`GOOGLE_ADS_ACCESS_LEVEL=basic`) |
| Claude web login (OAuth, no config files) | Usually stdio only | ✅ |
| Developer token required | Yes | No (2026 access model) |

## Features

- **Remote MCP** over Streamable HTTP, ready for Claude web, Desktop, mobile and Claude Code.
- **Built-in OAuth 2.1** with dynamic client registration: add the URL in Claude, click
  Connect, paste your access key. No tokens to copy.
- **Read-only by design**: never modifies your Google Ads accounts.
- **Quota-aware**: daily operations budget and response cache for Explorer's 2,880 ops/day.
- **Dockerized**, non-root, read-only filesystem, Traefik-ready.

## Tools

| Tool | Access level | What it does |
|---|---|---|
| `suggest_keywords` | Explorer | Keyword suggestions from Google Ads |
| `autocomplete_keywords` | none | Real searches from Google Autocomplete (A–Z, questions, places) |
| `research_keywords` | Explorer | Both sources merged, ranked by agreement; optional `locations` for local intent |
| `search_locations` | Explorer | Location IDs for targeting |
| `list_accounts` | Explorer | Accounts under your manager account |
| `run_gaql_query` | Explorer | Read-only GAQL queries |
| `search_terms_report` | Explorer | Real search terms from your campaigns |
| `api_status` | Explorer | Diagnostics, quota used, token health |
| `keyword_ideas` | **Basic** | Ideas with volume, competition, bids |
| `keyword_metrics` | **Basic** | 12-month search volume |
| `keyword_forecast` | **Basic** | Impressions, clicks, cost |

Full specs: [docs/TOOLS.md](docs/TOOLS.md).

## Quick start

```bash
git clone https://github.com/diegorenatob/mcp-google-ads && cd mcp-google-ads
cp .env.example .env && chmod 600 .env     # fill in the values (see docs/GOOGLE_ADS_SETUP.md)
npm ci && npm run google:auth              # one-time Google sign-in
mkdir -p data && sudo chown 1000:1000 data # container runs as non-root
docker compose up -d --build
npm run test:e2e -- --url https://<your-domain>   # runs the exact OAuth flow Claude uses
```

Then in Claude: **Customize → Connectors → Add custom connector** →
`https://<your-domain>/mcp` → **Connect** → enter your access key (`MCP_ACCESS_KEY`).
Details: [docs/CLAUDE_WEB.md](docs/CLAUDE_WEB.md).

## Documentation

| Doc | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Phases, acceptance criteria, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, OAuth flow, source layout |
| [docs/TOOLS.md](docs/TOOLS.md) | Tool inputs/outputs and error messages |
| [docs/API_ACCESS.md](docs/API_ACCESS.md) | Tested Explorer vs Basic capability matrix |
| [docs/GOOGLE_ADS_SETUP.md](docs/GOOGLE_ADS_SETUP.md) | Cloud project, accounts, refresh token |
| [docs/CLAUDE_WEB.md](docs/CLAUDE_WEB.md) | Connecting from Claude web / Code |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Docker + Traefik deployment |
| [docs/SECURITY.md](docs/SECURITY.md) | Secret handling for a public repo, runtime security |

## Security

Secrets live only in `.env` on your server; the repository ships `.env.example` with
placeholders. See [docs/SECURITY.md](docs/SECURITY.md).

## License

MIT
