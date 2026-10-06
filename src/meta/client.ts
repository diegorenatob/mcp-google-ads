import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { AdsError } from '../ads/errors.js';

const API_BASE = 'https://graph.facebook.com';
const TIMEOUT_MS = 30_000;

/**
 * Graph API paths this server may read. Everything else is refused before any
 * request is made, so the Meta token can never be used to write.
 */
const ALLOWED_PATHS = [
  /^search$/,
  /^me$/,
  /^me\/adaccounts$/,
  /^debug_token$/,
  /^act_\d{1,20}\/delivery_estimate$/,
  /^act_\d{1,20}\/insights$/,
];

const HINTS: Record<number, string> = {
  190: 'The Meta access token is invalid or expired. Replace META_ACCESS_TOKEN (a System User token with ads_read does not expire).',
  200: 'The token lacks permission for this ad account. Grant ads_read on it to the token\'s user or System User.',
  100: 'Invalid parameter in the Meta request.',
  17: 'Meta rate limit reached. Try again later.',
  4: 'Meta rate limit reached. Try again later.',
};

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Removes any access_token value from text (Graph error messages and paging URLs can echo it). */
export function scrubToken(text: string): string {
  return text.replace(/access_token=[^&"'\s]+/gi, 'access_token=[redacted]').replace(/EAA[A-Za-z0-9]{20,}/g, '[redacted]');
}

/** Converts a Graph API error payload into an AdsError with a safe message. */
export function mapMetaError(httpStatus: number, body: unknown): AdsError {
  const err = (body as GraphErrorBody)?.error;
  const code = err?.code ?? httpStatus;
  const detail = scrubToken(err?.message ?? `HTTP ${httpStatus}`).slice(0, 300);
  const hint = HINTS[code];
  return new AdsError(`META_${code}`, hint ? `${hint} Meta said: ${detail}` : `Meta API error (${code}): ${detail}`);
}

/** Normalizes "act_123", "123" or "act-123" to digits; returns '' when empty. */
export function normalizeAdAccountId(input: string): string {
  const id = input.trim().replace(/^act[_-]?/i, '');
  if (id && !/^\d{1,20}$/.test(id)) throw new AdsError('BAD_AD_ACCOUNT_ID', 'ad_account_id must be digits, optionally prefixed with act_.');
  return id;
}

/** Minimal read-only Meta Marketing API client (GET on an allowlist of paths). */
export class MetaClient {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.META_ACCESS_TOKEN.length > 0;
  }

  get defaultAdAccountId(): string {
    return this.config.META_AD_ACCOUNT_ID;
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.enabled) throw new AdsError('META_DISABLED', 'Meta tools are disabled: META_ACCESS_TOKEN is not set.');
    if (!ALLOWED_PATHS.some((re) => re.test(path))) {
      throw new AdsError('META_PATH_NOT_ALLOWED', `Path "${path}" is not on the read-only allowlist.`);
    }
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      query.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    query.set('access_token', this.config.META_ACCESS_TOKEN);
    const url = `${API_BASE}/${this.config.META_API_VERSION}/${path}?${query}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new AdsError('META_NETWORK', `Could not reach the Meta API: ${scrubToken(String((err as Error).message))}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    if (!res.ok || (json as GraphErrorBody).error) {
      const mapped = mapMetaError(res.status, json);
      this.logger.warn('meta api error', { path, code: mapped.code });
      throw mapped;
    }
    // Paging URLs embed the token; never pass them on.
    if (json && typeof json === 'object' && 'paging' in json) delete (json as Record<string, unknown>).paging;
    return json as T;
  }
}
