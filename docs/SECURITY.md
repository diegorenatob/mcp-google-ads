# Security and secret handling

This repository is **public**. The rules below are mandatory for every commit.

## What must never reach GitHub

| Item | Where it lives instead |
|---|---|
| `.env` (all real values) | Server only: `/opt/sites/mcp-google-ads/.env`, `chmod 600` |
| Google OAuth client secret, refresh token, developer token | `.env` |
| `MCP_ACCESS_KEY`, `MCP_JWT_SECRET` | `.env` |
| Real Google Ads customer IDs, MCC IDs, Cloud project number | `.env` (docs use `123-456-7890`) |
| Real domain-specific overrides | `docker-compose.override.yml` (git-ignored) |
| Runtime state (`data/`: OAuth clients, token hashes, cache) | Docker volume on the server |
| Personal email addresses | Commits use the GitHub `noreply` address |

The only env file in the repo is **`.env.example`**, with placeholder values.

## Layers of protection

1. **`.gitignore`** blocks `.env*` (except `.env.example`), `data/`, key/credential files and
   the compose override.
2. **`scripts/scan-secrets.sh`** (run before every push, and in CI):
   - runs [gitleaks](https://github.com/gitleaks/gitleaks) over the working tree **and history**;
   - additionally greps for every *value* found in the server's real `.env` (when present
     locally) — catches project-specific secrets that generic rules miss;
   - fails on Google patterns: `GOCSPX-`, `1//0`, `ya29.`, `AIza`, `.apps.googleusercontent.com`
     with a real numeric prefix.
3. **GitHub Action** `secret-scan.yml`: gitleaks on every push and pull request.
4. **GitHub settings**: enable *Secret scanning* and *Push protection* on the repo.
5. **First push checklist** (see `PLAN.md`, phase 5): inspect `git ls-files` and
   `git log -p` manually before `git push`.

## Runtime security

- **Authentication**: every `/mcp` call needs a valid Bearer JWT issued by the built-in OAuth
  flow. Unauthenticated → `401` with the `resource_metadata` pointer.
- **Login**: access key compared in constant time (SHA-256 digests + `timingSafeEqual`); 5 failures per IP per 15 minutes; generic
  error message; no user enumeration (single owner).
- **Redirect URI allowlist**: only Claude's callbacks (+ explicit extras). Prevents a
  registered rogue client from receiving codes.
- **PKCE S256** mandatory; authorization codes single-use, 5-minute TTL.
- **Refresh tokens** stored only as SHA-256 hashes, rotated on use.
- **Read-only by design**: no tool calls a Google Ads `mutate` endpoint; `run_gaql_query`
  accepts only `SELECT`.
- **Logs** never include tokens, secrets, passwords or full Google error bodies containing
  headers. The logger redacts keys matching `/token|secret|password|authorization|key|code_verifier|cookie/i`.
- **Container**: non-root user, read-only root filesystem except `/app/data`,
  `no-new-privileges`, no published host ports (only reachable through Traefik).
- **Optional network allowlist**: restrict `/mcp` to Anthropic's egress range
  `160.79.104.0/21` (via `CF-Connecting-IP`). Off by default because it would block
  local testing tools such as MCP Inspector.

## Google OAuth token lifetime (operational risk)

While the Google Cloud OAuth consent screen is in **Testing** mode, Google refresh tokens
**expire after 7 days**. Then every tool returns the `invalid_grant` message.
Fix options:
- re-run `npm run google:auth` on the server and update `GOOGLE_ADS_REFRESH_TOKEN`; or
- move the consent screen to **In production** (part of brand verification, which is also
  needed for Basic access).

## Incident response

| Event | Action |
|---|---|
| A secret was committed | Rotate it **first** (Google console / regenerate), then rewrite history (`git filter-repo`) and force-push |
| MCP access key leaked | Change `MCP_ACCESS_KEY`, rotate `MCP_JWT_SECRET`, delete `data/oauth.json`, restart |
| Google refresh token leaked | Revoke at myaccount.google.com/permissions, run `npm run google:auth` |
