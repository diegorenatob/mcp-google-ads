import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import type { OpsBudget } from './budget.js';
import { AdsError, mapGoogleAdsError } from './errors.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://googleads.googleapis.com';
const TIMEOUT_MS = 30_000;

type Row = Record<string, unknown>;

/**
 * Minimal Google Ads REST client: refresh-token OAuth, access-token cache,
 * ops budget, and safe error mapping. Read-only methods only.
 */
export class GoogleAdsClient {
  private accessToken?: { value: string; expiresAt: number };

  constructor(
    private readonly config: Config,
    private readonly budget: OpsBudget,
    private readonly logger: Logger,
  ) {}

  get customerId(): string {
    return this.config.GOOGLE_ADS_CUSTOMER_ID;
  }

  get loginCustomerId(): string {
    return this.config.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  /** Exchanges the refresh token for an access token, cached until ~60 s before expiry. */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.GOOGLE_ADS_CLIENT_ID,
        client_secret: this.config.GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: this.config.GOOGLE_ADS_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        throw new AdsError(
          'GOOGLE_AUTH_EXPIRED',
          'The Google refresh token expired or was revoked (tokens expire after 7 days while the OAuth consent screen is in Testing). Renew it on the server with `npm run google:auth`.',
        );
      }
      throw new AdsError('GOOGLE_AUTH_FAILED', `Google OAuth token request failed (${body.error ?? res.status}).`);
    }
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** Low-level call. `path` is relative to /{version}/. Counts one operation. */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, loginCustomerId = this.loginCustomerId): Promise<T> {
    this.budget.consume(1);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      'Content-Type': 'application/json',
    };
    if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
    if (this.config.GOOGLE_ADS_DEVELOPER_TOKEN) headers['developer-token'] = this.config.GOOGLE_ADS_DEVELOPER_TOKEN;

    const url = `${API_BASE}/${this.config.GOOGLE_ADS_API_VERSION}/${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      this.logger.warn('google ads non-json response', { status: res.status, path });
      throw new AdsError(`HTTP_${res.status}`, `Google Ads API returned a non-JSON response (HTTP ${res.status}) for ${path.split(':')[1] ?? path}.`);
    }
    if (!res.ok) {
      const err = mapGoogleAdsError(res.status, json);
      this.logger.warn('google ads error', { status: res.status, code: err.code, path });
      throw err;
    }
    return json as T;
  }

  /** GoogleAdsService.Search. Follows pages until `maxRows`. */
  async search(customerId: string, query: string, maxRows = 1000): Promise<Row[]> {
    const rows: Row[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.call<{ results?: Row[]; nextPageToken?: string }>(
        'POST',
        `customers/${customerId}/googleAds:search`,
        pageToken ? { query, pageToken } : { query },
      );
      rows.push(...(page.results ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && rows.length < maxRows);
    return rows.slice(0, maxRows);
  }

  async listAccessibleCustomers(): Promise<string[]> {
    const res = await this.call<{ resourceNames?: string[] }>('GET', 'customers:listAccessibleCustomers', undefined, '');
    return (res.resourceNames ?? []).map((r) => r.replace('customers/', ''));
  }
}
