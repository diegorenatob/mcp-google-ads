/**
 * Diagnostics for the Google Ads side. Prints no secrets.
 *   npm run google:check
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAdsClient } from '../src/ads/client.js';
import { OpsBudget } from '../src/ads/budget.js';
import { AdsError } from '../src/ads/errors.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/util/logger.js';

const config = loadConfig();
const budget = new OpsBudget(mkdtempSync(join(tmpdir(), 'kwcheck-')), 100);
const ads = new GoogleAdsClient(config, budget, createLogger('error'));

const step = async (name: string, fn: () => Promise<string>) => {
  try {
    console.log(`✅ ${name}: ${await fn()}`);
  } catch (err) {
    console.log(`❌ ${name}: ${err instanceof AdsError ? `[${err.code}] ${err.message}` : (err as Error).message}`);
  }
};

await step('Google OAuth (refresh token)', async () => (await ads.getAccessToken(), 'ok'));
await step('Accessible accounts', async () => `${(await ads.listAccessibleCustomers()).length} account(s)`);
await step('Advertiser account', async () => {
  const [row] = await ads.search(config.GOOGLE_ADS_CUSTOMER_ID, 'SELECT customer.descriptive_name, customer.manager, customer.status FROM customer', 1);
  const c = (row?.customer ?? {}) as Record<string, unknown>;
  if (c.manager) throw new Error('GOOGLE_ADS_CUSTOMER_ID is a manager account; use an advertiser account.');
  return `${c.descriptiveName} (${c.status})`;
});
await step('Keyword themes (Explorer)', async () => {
  const r = await ads.call<{ keywordThemeConstants?: unknown[] }>('POST', 'keywordThemeConstants:suggest', {
    queryText: 'test', countryCode: config.DEFAULT_COUNTRY_CODE, languageCode: config.DEFAULT_LANGUAGE_CODE,
  });
  return `${r.keywordThemeConstants?.length ?? 0} suggestions`;
});
await step('Keyword Planner (Basic)', async () => {
  try {
    await ads.call('POST', `customers/${config.GOOGLE_ADS_CUSTOMER_ID}:generateKeywordHistoricalMetrics`, { keywords: ['test'] });
    return 'allowed → you can set GOOGLE_ADS_ACCESS_LEVEL=basic';
  } catch (err) {
    if (err instanceof AdsError && err.code === 'BASIC_ACCESS_REQUIRED') return 'not allowed (Explorer access) — expected until Basic is approved';
    throw err;
  }
});
console.log(`\nConfigured GOOGLE_ADS_ACCESS_LEVEL=${config.GOOGLE_ADS_ACCESS_LEVEL}`);
