# CLAUDE.md — instructions for agents working on this repo

## Non-negotiable rules
- **Public repository.** Never commit `.env`, `data/`, `*.local.md`, credentials, real
  Google Ads customer/MCC IDs, the Cloud project number, IPs or personal emails.
  Only `.env.example` with placeholders.
- Run `npm run scan:secrets` before every push. If anything is found: stop, rotate the
  secret first, then clean history.
- Never print secret values in terminal output, logs, tests or docs. Refer to variable names.
- All code, comments, docs and commit messages in **English**.
- Tools are **read-only**: never call Google Ads `mutate` endpoints.
- Commit with the GitHub noreply identity.

## Where things are
- Plan and status: `docs/PLAN.md` (update the checkboxes as phases complete).
- Specs: `docs/TOOLS.md`, `docs/ARCHITECTURE.md`. Tested API limits: `docs/API_ACCESS.md`.
- Server-specific notes (git-ignored): `DEPLOY.local.md`.

## Commands (once Phase 1 exists)
- `npm run build`, `npm test`, `npm run lint`, `npm run test:e2e -- --url <url>`
- `npm run google:auth` (renew Google refresh token), `npm run google:check`
- Deploy: `docker compose up -d --build`; after `.env` edits use `--force-recreate`.

## Gotchas learned
- Explorer access blocks every `KeywordPlanIdeaService` method; don't "fix" that in code.
- Create DNS before starting the container, or Let's Encrypt fails (Cloudflare 526).
- Claude web needs a **401** (not 403) with `resource_metadata` to start OAuth.
- Google refresh tokens expire after 7 days while the consent screen is in Testing.
