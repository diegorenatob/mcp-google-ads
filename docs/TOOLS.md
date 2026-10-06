# MCP tool specification

Every tool is **read-only**: none creates, modifies or deletes anything in Google Ads.
Each declares `annotations.readOnlyHint = true`.

Conventions:
- Inputs validated with zod. Validation errors return a readable message.
- Output: text `content` (one-line summary + the JSON) and the same JSON as `structuredContent`.
- Default language/country: `DEFAULT_LANGUAGE_CODE` / `DEFAULT_COUNTRY_CODE` (pt / BR).
- Google Ads calls count against the daily budget (`GOOGLE_ADS_DAILY_OPS_BUDGET`).
- Responses are cached in memory for `CACHE_TTL_HOURS` hours, keyed by tool + arguments (except `run_gaql_query` and `api_status`).

---

## Phase 1 — available with Explorer access

### 1. `suggest_keywords`
Keyword suggestions from Google Ads (`KeywordThemeConstantService.Suggest`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `query` | string (1-80) | yes | — |
| `country_code` | ISO-3166 alpha-2 | no | `BR` |
| `language_code` | ISO-639-1 | no | `pt` |
| `limit` | int 1-100 | no | 25 |

Output: `{ query, suggestions: [{ text, resource_name }] }`. No volume.

### 2. `autocomplete_keywords`
Real searches suggested by Google Autocomplete (unofficial source).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `query` | string | yes | — |
| `mode` | `plain` \| `alphabet` \| `questions` \| `all` | no | `plain` |
| `language_code` | string | no | `pt` |
| `country_code` | string | no | `BR` |

- `alphabet`: queries `query + " a"` … `query + " z"`.
- `questions`: prepends per-language modifiers (pt: como, quanto, quando, qual, onde,
  porque, o que, quem, pode, tem direito; en: how, what, when, why, where, can, is).
- `all`: plain + alphabet + questions.
- Max concurrency 4, pause between batches, de-duplicated and sorted.

Output: `{ query, mode, suggestions: [string], sources: { [variant]: [string] } }`.

### 3. `research_keywords`
Combines 1 and 2 in a single call for the most common use case.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `seeds` | string[] (1-10) | yes | — |
| `country_code`, `language_code` | string | no | BR / pt |
| `include_questions` | bool | no | true |

Output: unified list `{ keyword, sources: ["ads_themes"|"autocomplete"|"questions"] }`,
de-duplicated, with a source count per keyword (more sources = stronger signal).

### 4. `search_locations`
Looks up location IDs for targeting (`GeoTargetConstantService.Suggest`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `names` | string[] (1-25) | yes | — |
| `country_code`, `locale` | string | no | BR / pt |

Output: `[{ id, name, canonical_name, target_type, country_code, status }]`.

### 5. `list_accounts`
Accessible accounts and hierarchy under the configured MCC (`customer_client`).

No parameters. Output: `[{ id, name, manager, status, level, currency, time_zone }]`.

### 6. `run_gaql_query`
Runs a **read-only GAQL** query (`GoogleAdsService.Search`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `query` | string | yes | — |
| `customer_id` | string (digits) | no | `GOOGLE_ADS_CUSTOMER_ID` |
| `max_rows` | int 1-1000 | no | 200 |

Rules: only `SELECT ... FROM ...` is accepted; anything else is rejected. A `LIMIT` is
added if missing. `customer_id` must be in the list of accessible accounts.

### 7. `search_terms_report`
Real search terms from your campaigns (`search_term_view`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `days` | int 1-90 | no | 30 |
| `customer_id` | string | no | `GOOGLE_ADS_CUSTOMER_ID` |
| `min_impressions` | int | no | 1 |

Output: `[{ search_term, impressions, clicks, cost, conversions, ctr }]`.
Useful once campaigns are spending: it gives **real** volume from your own ads.

### 8. `api_status`
Diagnostics: configured access level, ops budget used today, valid accounts and a cheap
connectivity check. No parameters. No secrets in the output.

---

## Phase 2 — require Basic access (`GOOGLE_ADS_ACCESS_LEVEL=basic`)

With Explorer access these tools are **not registered** (Claude doesn't see them), so
the server never offers tools that always fail.

### 9. `keyword_ideas`
`KeywordPlanIdeaService.GenerateKeywordIdeas`.
Parameters: `seeds` (string[]), `url` (optional), `country_code`, `language_code`,
`limit`. Output: `[{ keyword, avg_monthly_searches, competition, competition_index,
low_top_of_page_bid, high_top_of_page_bid }]` (amounts in currency, not micros).

### 10. `keyword_metrics`
`GenerateKeywordHistoricalMetrics`. Parameters: `keywords` (string[] 1-50).
Output: metrics + `monthly_search_volumes` (12 months).

> Phase-2 request shapes follow the v23 REST reference but could not be verified live while the
> project had Explorer access. Verify them when Basic is granted (`PLAN.md`, phase 8).

### 11. `keyword_forecast`
`GenerateKeywordForecastMetrics`. Parameters: `keywords`, `max_cpc` (currency),
`start_date`, `end_date`, `match_type`. Output: impressions, clicks, cost, CTR.

---

## Errors (common format)

Google errors are translated into actionable messages, never leaking tokens or headers:

| Google code | Message to the user |
|---|---|
| `DEVELOPER_TOKEN_NOT_APPROVED` / "explorer access" | Requires Basic access (see docs/API_ACCESS.md) |
| `CUSTOMER_NOT_ENABLED` | Account not enabled (billing/setup) |
| `USER_PERMISSION_DENIED` | `GOOGLE_ADS_LOGIN_CUSTOMER_ID` missing or wrong |
| `invalid_grant` (OAuth) | Google refresh token expired: run `npm run google:auth` |
| Daily budget exhausted | Rejected locally before calling Google |
