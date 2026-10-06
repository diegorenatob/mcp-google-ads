# Deployment

Generic guide for any server with Docker + Traefik v2. Server-specific values (IP,
Cloudflare zone, real domain) live in the git-ignored `DEPLOY.local.md`.

## Prerequisites

- Docker + Docker Compose v2.
- Traefik v2 with a Docker provider, an external network (default `proxy`), an HTTPS
  entrypoint and an ACME cert resolver.
- A DNS record for `MCP_DOMAIN` pointing at the server.
- Google Ads setup finished (`GOOGLE_ADS_SETUP.md`).

## Steps

> **Order matters: create DNS first.** Traefik requests the Let's Encrypt certificate the
> moment the container starts. If the DNS record doesn't exist yet, ACME fails with
> `NXDOMAIN`, Cloudflare then shows **526**, and you have to restart the container to retry.

```bash
# 1. DNS: A record MCP_DOMAIN → server IP (Cloudflare: proxied, SSL mode Full (strict)).
#    Wait until it resolves:
dig +short $MCP_DOMAIN @1.1.1.1

# 2. Configure
cp .env.example .env && chmod 600 .env
#    fill PUBLIC_URL, MCP_DOMAIN, MCP_ACCESS_KEY, MCP_JWT_SECRET, GOOGLE_ADS_*, TRAEFIK_*
npm ci && npm run google:auth   # writes GOOGLE_ADS_REFRESH_TOKEN (see GOOGLE_ADS_SETUP.md)

# 3. Build and start (the container runs as uid 1000 with a read-only filesystem)
mkdir -p data && chown 1000:1000 data && chmod 700 data
docker compose up -d --build

# 4. Verify
curl -s https://$MCP_DOMAIN/health                       # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$MCP_DOMAIN/mcp   # 401
curl -s https://$MCP_DOMAIN/.well-known/oauth-protected-resource/mcp
curl -s https://$MCP_DOMAIN/.well-known/oauth-authorization-server
npm run test:e2e -- --url https://$MCP_DOMAIN             # full OAuth + tools/list
```

Then connect from Claude (`CLAUDE_WEB.md`).

## docker-compose.yml

```yaml
services:
  mcp-google-ads:
    build: .
    container_name: mcp-google-ads
    restart: unless-stopped
    env_file: .env
    environment: { DATA_DIR: /app/data }
    volumes: ["./data:/app/data"]
    read_only: true
    tmpfs: ["/tmp"]
    security_opt: ["no-new-privileges:true"]
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.docker.network=${TRAEFIK_NETWORK:-proxy}
      - traefik.http.routers.mcp-google-ads.rule=Host(`${MCP_DOMAIN}`)
      - traefik.http.routers.mcp-google-ads.entrypoints=${TRAEFIK_ENTRYPOINT:-websecure}
      - traefik.http.routers.mcp-google-ads.tls.certresolver=${TRAEFIK_CERTRESOLVER:-letsencrypt}
      - traefik.http.services.mcp-google-ads.loadbalancer.server.port=8080
networks:
  proxy: { external: true, name: "${TRAEFIK_NETWORK:-proxy}" }
```

The healthcheck lives in the `Dockerfile`. No Traefik basic-auth middleware: Claude web cannot send basic auth; the server's own OAuth
protects `/mcp`. No host ports are published.

## Operations

| Task | Command |
|---|---|
| Logs | `docker logs mcp-google-ads --tail=100` |
| Update | `git pull && docker compose up -d --build` |
| Renew Google refresh token | `npm run google:auth && docker compose up -d --force-recreate` |
| Force everyone to log in again | rotate `MCP_JWT_SECRET`, `rm data/oauth.json`, recreate |
| Switch to Basic tools | `GOOGLE_ADS_ACCESS_LEVEL=basic`, recreate |
| Backup | `data/` only (everything else is in git or `.env`) |

`.env` changes need `--force-recreate`; a plain `restart` keeps the old environment.
