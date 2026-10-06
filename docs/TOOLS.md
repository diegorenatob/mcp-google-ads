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
| `locations` | string[] (max 8) | no | — |
| `language_code` | string | no | `pt` |
| `country_code` | string | no | `BR` |

- `alphabet`: queries `query + " a"` … `query + " z"`.
- `questions`: prepends per-language modifiers (pt: como, quanto, quando, qual, onde,
  porque, o que, quem, pode, tem direito; en: how, what, when, why, where, can, is).
- `all`: plain + alphabet + questions.
- `locations`: adds place-biased variants on top of the mode: `<query> <place>` and
  `<query> em <place>` (`en` / `in` for es / en). Google Ads keyword themes can only filter by
  country, so this is how local intent (a city or state) is covered on Explorer access.
- Max concurrency 4, pause between batches, de-duplicated and sorted.

Output: `{ query, mode, suggestions: [string], sources: { [variant]: [string] } }`.

### 3. `research_keywords`
Combines 1 and 2 in a single call for the most common use case.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `seeds` | string[] (1-10) | yes | — |
| `country_code`, `language_code` | string | no | BR / pt |
| `include_questions` | bool | no | true |
| `locations` | string[] (max 8) | no | — |

Output: unified list `{ keyword, sources: ["ads_themes"|"autocomplete"|"questions"] }`,
de-duplicated, with a source count per keyword (more sources = stronger signal).

With `locations`, an extra source appears (`autocomplete_local`) and each keyword carries
`matched_locations` (the places its text mentions, accent-insensitive). Google Ads keyword themes
return **nothing** when the query contains a place name (tested), so local variants come only from
Autocomplete and cost no Google Ads operations.

### 4. `search_locations`
Looks up location IDs for targeting (`GeoTargetConstantService.Suggest`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `names` | string[] (1-25) | yes | — |
| `country_code`, `locale` | string | no | BR / pt |

Output: `[{ id, name, canonical_name, target_type, country_code, status }]`.

### 5. `list_accounts`
Accessible accounts and hierarchy under the configured MCC (`customer_client`).

No parameters. Output: `[{ id, name, manager, status, level, currency, time_zone }]`. If
`GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` is set, only those accounts (plus the manager) are listed.

### 6. `run_gaql_query`
Runs a **read-only GAQL** query (`GoogleAdsService.Search`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `query` | string | yes | — |
| `customer_id` | string (digits) | no | `GOOGLE_ADS_CUSTOMER_ID` |
| `max_rows` | int 1-1000 | no | 200 |

Rules: only `SELECT ... FROM ...` is accepted; anything else is rejected. A `LIMIT` is
added if missing. `customer_id` must be in `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` when set, otherwise in the
list of accessible accounts.

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

## Meta (optional) — enabled when `META_ACCESS_TOKEN` is set

Read-only Meta Marketing API tools. The client only issues `GET` requests to an allowlist
of paths (`search`, `me`, `me/adaccounts`, `debug_token`, `act_<id>/delivery_estimate`,
`act_<id>/insights`); anything else is refused before a request is made. Tokens are
scrubbed from errors and paging URLs are dropped. Meta no longer returns cost or result
curves (`daily_outcomes_curve`) through the API, so these tools estimate audience size only.

| Tool | Parameters | Returns |
|---|---|---|
| `meta_status` | — | Token validity, expiry, scopes, visible ad accounts, interest presets |
| `meta_search_locations` | `query`, `location_types` (region, city…), `country_code`, `limit` | Location keys |
| `meta_search_interests` | `query`, `locale` (pt_BR), `limit` | Interest IDs with global audience bounds |
| `meta_audience_size` | `geo` {countries, regions, cities}, `excluded_regions`, `age_min`, `age_max`, `interest_ids` or `interest_preset`, `optimization_goal`, `ad_account_id` | Monthly active audience bounds |
| `meta_audience_matrix` | `geos` [{label, geo, excluded_regions}], `interest_sets` [{label, interest_ids}] (default: presets), `include_no_interest`, ages, goal, account | One row per cell (max 60) + CSV |
| `meta_campaign_insights` | `date_preset` (last_30d), `level` (campaign), `ad_account_id`, `limit` | Spend, impressions, reach, clicks, CTR, CPM, actions, cost per action |

`ad_account_id` must be an account the token can see. Interest IDs in a targeting are ORed.
Interest presets (`job_seekers`, `self_employed`) are verified proxies: Meta has no
interests for labour law or unemployment insurance.
