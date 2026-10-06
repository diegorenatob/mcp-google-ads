# Google Ads API access: what works and what doesn't

This document records **real tests** run against the API, not assumptions.
Test date: **2026-10-06**. API version: **v23**.

## Context: the access model changed (2026)

- Google removed the need for a **developer token**. A call without the
  `developer-token` header returned exactly the same as a call with it.
- The **access level** now belongs to the **Google Cloud project**, not to a token.
  It is managed in the Cloud console: *APIs & Services → Google Ads API → Overview*.
- The Google Ads "API Center" page now only serves the
  *App Conversion Tracking & Remarketing API* (not relevant to this project).

## Access levels

| Level | Test accounts | Production accounts | Requirement |
|---|---|---|---|
| Test | 15,000 ops/day | ❌ | none |
| **Explorer** (current) | 15,000 ops/day | **2,880 ops/day** | granted on request |
| Basic | yes | more ops/day | **brand verification** in Google Cloud |
| Standard | yes | practically unlimited | additional review |

## Method matrix tested with Explorer access

| Method | Result | Use |
|---|---|---|
| `KeywordPlanIdeaService.GenerateKeywordIdeas` | ❌ `DEVELOPER_TOKEN_NOT_APPROVED` | Ideas with volume and CPC |
| `KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics` | ❌ blocked | Historical volume |
| `KeywordPlanIdeaService.GenerateKeywordForecastMetrics` | ❌ blocked | Click/cost forecast |
| `KeywordPlanIdeaService.GenerateAdGroupThemes` | ❌ blocked | Keyword grouping |
| `KeywordThemeConstantService.SuggestKeywordThemeConstants` | ✅ | Keyword suggestions **without volume** |
| `GeoTargetConstantService.SuggestGeoTargetConstants` | ✅ | Location lookup |
| `GoogleAdsService.Search` (GAQL) | ✅ | Reports, account structure |
| `CustomerService.ListAccessibleCustomers` | ✅ | List accounts |
| `KeywordPlanService` (saved plans) | ⚠️ not tested | Needs creating a plan (a write) |

Exact blocking message:

> This method is not allowed for use with explorer access. Please apply for basic or standard access.

External sources (outside the Google Ads API), tested from the server:

| Source | Result | Notes |
|---|---|---|
| Google Autocomplete (`suggestqueries.google.com`) | ✅ | Free, no volume, unofficial (may change or rate-limit) |
| Google Trends | ⚠️ inconclusive | Unofficial API; the test request was invalid |

## Design consequences

1. **Phase 1** (Explorer): suggestion, location, GAQL reporting and account tools.
   **No search volume.**
2. **Phase 2** (Basic): Keyword Planner tools with volume, CPC and forecast are enabled
   with `GOOGLE_ADS_ACCESS_LEVEL=basic`. The code ships from day one but stays off.

## Configuration state (non-secret)

- Cloud project: the one holding the OAuth client (Google Ads API enabled).
- Manager account (MCC): enabled, production.
- Advertiser account: enabled, billing `APPROVED`, linked to the MCC.
- Real IDs live only in the server's `.env`, **never** in this repository.

## Moving to Basic

1. Google Cloud → access level → **start brand verification**.
2. Usual requirements: public home page, privacy policy on the same domain, domain
   verified in Search Console, app name and support email.
3. Request **Basic** on the same screen.
4. On the server: `GOOGLE_ADS_ACCESS_LEVEL=basic` and restart.
