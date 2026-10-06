# Google Ads setup (one time)

What you need before the server can call Google Ads. The order matters.

## 1. Google Cloud project

1. Create (or reuse) a project. Enable **Google Ads API**:
   `https://console.cloud.google.com/apis/library/googleads.googleapis.com`
2. **OAuth consent screen** (Google Auth Platform):
   - User type: **External**.
   - Publishing status: **Testing** at first. Add your Google account under **Test users**,
     otherwise Google shows *"Access blocked: … has not completed the Google verification
     process"*.
   - Note: in Testing mode Google refresh tokens **expire after 7 days**.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**.
   Copy the client ID and client secret into `.env`.

## 2. API access level (per Cloud project)

Google Cloud console → *APIs & Services → Google Ads API → Overview → access level*.

- **Test → Explorer**: request it; it was granted immediately in our case.
  Explorer = 2,880 production ops/day, Keyword Planner volume methods blocked.
- **Explorer → Basic**: requires **brand verification** first. See `API_ACCESS.md`.

A developer token is no longer required (2026 change). The old "API Center" in Google Ads
only serves the App Conversion Tracking API — do not use its application form.

## 3. Google Ads accounts

- A **manager account (MCC)** → `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
- An **advertiser account** (not a manager) **under that MCC, with billing** →
  `GOOGLE_ADS_CUSTOMER_ID`. Create it from the MCC: *Accounts → + → Create new account →
  Google Ads account*, then add a payment method. No ads need to run.

How to recognise the wrong account (from real errors we hit):

| API answer | Meaning |
|---|---|
| `manager: true` | It's a manager account; can't be the advertiser account |
| `CUSTOMER_NOT_ENABLED` | Setup/billing not finished, or account closed |
| `testAccount: true` | Test account; works only with test-level data |
| `ACTION_NOT_PERMITTED … only approved for use with test accounts` | Cloud project still at Test level |

## 4. Refresh token

On the server, with `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET` in `.env`:

```bash
npm run google:auth
```

The script prints an authorization URL. Open it **in your own browser**, sign in with the
account that has access to the MCC, accept. The browser then fails to load
`http://localhost:9876/?code=…` — that's expected (it's *your* localhost, not the server).
**Copy the full URL from the address bar and paste it into the script.** It exchanges the
code and writes `GOOGLE_ADS_REFRESH_TOKEN` into `.env` (never printed to the terminal).

The code expires within minutes and is single-use.

## 5. Verify

```bash
npm run google:check   # lists accessible accounts and the access-level probe, no secrets
```
