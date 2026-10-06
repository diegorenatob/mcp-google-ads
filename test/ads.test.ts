import { describe, expect, it } from 'vitest';
import { mapGoogleAdsError } from '../src/ads/errors.js';
import { guardGaql } from '../src/ads/gaql.js';
import { buildVariants, localVariants, normalizeText } from '../src/sources/autocomplete.js';
import { redact } from '../src/util/logger.js';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

describe('GAQL guard', () => {
  it('adds a LIMIT when missing', () => {
    expect(guardGaql('SELECT campaign.id FROM campaign', 50)).toBe('SELECT campaign.id FROM campaign LIMIT 50');
  });
  it('caps an existing LIMIT', () => {
    expect(guardGaql('SELECT campaign.id FROM campaign LIMIT 5000', 200)).toMatch(/LIMIT 200$/);
    expect(guardGaql('SELECT campaign.id FROM campaign LIMIT 10', 200)).toMatch(/LIMIT 10$/);
  });
  it('keeps PARAMETERS after LIMIT', () => {
    expect(guardGaql('SELECT campaign.id FROM campaign PARAMETERS include_drafts=true', 10)).toBe(
      'SELECT campaign.id FROM campaign LIMIT 10 PARAMETERS include_drafts=true',
    );
  });
  it('rejects non-SELECT and multiple statements', () => {
    expect(() => guardGaql('DELETE FROM campaign', 10)).toThrow(/read-only/);
    expect(() => guardGaql('SELECT a FROM campaign; SELECT b FROM ad_group', 10)).toThrow(/one GAQL/);
  });
});

describe('Google error mapping', () => {
  it('detects Explorer-access blocks', () => {
    const err = mapGoogleAdsError(403, {
      error: {
        status: 'PERMISSION_DENIED',
        details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'This method is not allowed for use with explorer access. Please apply for basic or standard access.' }] }],
      },
    });
    expect(err.code).toBe('BASIC_ACCESS_REQUIRED');
  });
  it('maps CUSTOMER_NOT_ENABLED to a hint', () => {
    const err = mapGoogleAdsError(403, {
      error: { details: [{ errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' }, message: 'x' }] }] },
    });
    expect(err.code).toBe('CUSTOMER_NOT_ENABLED');
    expect(err.message).toMatch(/billing/);
  });
});

describe('autocomplete variants', () => {
  it('builds alphabet and question variants', () => {
    expect(buildVariants('horas extras', 'alphabet', 'pt')).toHaveLength(26);
    expect(buildVariants('horas extras', 'questions', 'pt')[0]).toBe('como horas extras');
    expect(buildVariants('x', 'all', 'en').length).toBe(1 + 26 + 10);
  });
});

describe('local (place) variants', () => {
  it('builds "<q> <place>" and "<q> em <place>" for Portuguese', () => {
    expect(localVariants('advogado trabalhista', ['Porto Alegre'], 'pt')).toEqual([
      'advogado trabalhista Porto Alegre',
      'advogado trabalhista em Porto Alegre',
    ]);
  });
  it('uses the right preposition per language and skips unknown ones', () => {
    expect(localVariants('lawyer', ['Austin'], 'en')).toContain('lawyer in Austin');
    expect(localVariants('abogado', ['Lima'], 'es')).toContain('abogado en Lima');
    expect(localVariants('x', ['Y'], 'ja')).toEqual(['x Y']);
  });
  it('is added on top of the selected mode and de-duplicated', () => {
    const v = buildVariants('x', 'plain', 'pt', ['Rio', 'Rio', ' ']);
    expect(v).toEqual(['x', 'x Rio', 'x em Rio']);
  });
  it('matches place names ignoring accents and case', () => {
    expect(normalizeText('Capão da Canoa')).toBe('capao da canoa');
    expect(normalizeText('advogado em CAPAO DA CANOA').includes(normalizeText('Capão da Canoa'))).toBe(true);
  });
});

describe('logger redaction', () => {
  it('hides sensitive keys at any depth', () => {
    expect(redact({ a: 1, refresh_token: 'r', nested: { Authorization: 'b', ok: 2 } })).toEqual({
      a: 1,
      refresh_token: '[redacted]',
      nested: { Authorization: '[redacted]', ok: 2 },
    });
  });
});

describe('account allowlist', () => {
  it('parses a comma-separated list, with or without dashes', () => {
    const c = testConfig({ GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '123-456-7890, 1111111111' });
    expect(c.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS).toEqual(['1234567890', '1111111111']);
  });
  it('defaults to empty (discovery) and rejects malformed IDs', () => {
    expect(testConfig().GOOGLE_ADS_ALLOWED_CUSTOMER_IDS).toEqual([]);
    expect(() => testConfig({ GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '12345' })).toThrow(/GOOGLE_ADS_ALLOWED_CUSTOMER_IDS/);
  });
});

describe('config', () => {
  it('normalises IDs and URL', () => {
    const c = testConfig({ PUBLIC_URL: 'https://mcp.example.com/' });
    expect(c.GOOGLE_ADS_CUSTOMER_ID).toBe('1234567890');
    expect(c.PUBLIC_URL).toBe('https://mcp.example.com');
  });
  it('reports variable names, never values', () => {
    expect(() => loadConfig({ MCP_ACCESS_KEY: 'tiny-secret' })).toThrow(/MCP_ACCESS_KEY/);
    try {
      loadConfig({ MCP_ACCESS_KEY: 'tiny-secret' });
    } catch (e) {
      expect((e as Error).message).not.toContain('tiny-secret');
    }
  });
});
