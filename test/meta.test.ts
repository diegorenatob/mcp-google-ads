import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaClient, mapMetaError, normalizeAdAccountId, scrubToken } from '../src/meta/client.js';
import { buildTargeting } from '../src/mcp/tools/meta.js';
import { createLogger } from '../src/util/logger.js';
import { testConfig } from './helpers.js';

const FAKE_TOKEN = 'EAAFAKE' + 'x'.repeat(40);

describe('Meta config', () => {
  it('is disabled by default and strips the act_ prefix', () => {
    expect(testConfig().META_ACCESS_TOKEN).toBe('');
    expect(testConfig({ META_AD_ACCOUNT_ID: 'act_123456' }).META_AD_ACCOUNT_ID).toBe('123456');
    expect(() => testConfig({ META_AD_ACCOUNT_ID: 'abc' })).toThrow(/META_AD_ACCOUNT_ID/);
  });
});

describe('Meta client safety', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses paths outside the read-only allowlist without a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new MetaClient(testConfig({ META_ACCESS_TOKEN: FAKE_TOKEN }), createLogger('error'));
    await expect(client.get('act_1/campaigns')).rejects.toThrow(/allowlist/);
    await expect(client.get('act_1/adsets')).rejects.toThrow(/allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only issues GET and drops paging URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], paging: { next: `https://x?access_token=${FAKE_TOKEN}` } })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MetaClient(testConfig({ META_ACCESS_TOKEN: FAKE_TOKEN }), createLogger('error'));
    const res = await client.get<Record<string, unknown>>('search', { type: 'adinterest', q: 'x' });
    expect(res.paging).toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'GET' });
  });

  it('never leaks the token in errors', () => {
    const err = mapMetaError(400, { error: { code: 190, message: `bad token access_token=${FAKE_TOKEN}` } });
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.message).toMatch(/expired/);
    expect(scrubToken(`token ${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN);
  });

  it('normalizes ad account IDs', () => {
    expect(normalizeAdAccountId('act_42')).toBe('42');
    expect(normalizeAdAccountId('')).toBe('');
    expect(() => normalizeAdAccountId('act_x1')).toThrow();
  });
});

describe('Meta targeting', () => {
  it('builds geo, exclusions, ages and ORed interests', () => {
    expect(buildTargeting({ geo: { countries: ['br'] }, excludedRegions: ['460'], ageMin: 22, ageMax: 55, interestIds: ['1', '2'] })).toEqual({
      geo_locations: { countries: ['BR'] },
      age_min: 22,
      age_max: 55,
      excluded_geo_locations: { regions: [{ key: '460' }] },
      flexible_spec: [{ interests: [{ id: '1' }, { id: '2' }] }],
    });
  });
  it('rejects an empty geo and inverted ages', () => {
    expect(() => buildTargeting({ geo: {} })).toThrow(/geo/);
    expect(() => buildTargeting({ geo: { countries: ['BR'] }, ageMin: 40, ageMax: 30 })).toThrow(/age_min/);
  });
});
