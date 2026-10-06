import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';

export const TEST_KEY = 'test-access-key-1234567890';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    PUBLIC_URL: 'http://localhost:8080',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'mga-test-')),
    MCP_ACCESS_KEY: TEST_KEY,
    MCP_JWT_SECRET: 'x'.repeat(64),
    GOOGLE_ADS_CLIENT_ID: 'client-id',
    GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: '0987654321',
    ...overrides,
  });
}

/** Minimal chainable stand-in for an Express Response. */
export function fakeRes() {
  const res = {
    statusCode: 200,
    body: '',
    location: '',
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(h: Record<string, string>) {
      Object.assign(res.headers, h);
      return res;
    },
    type() {
      return res;
    },
    send(b: string) {
      res.body = b;
      return res;
    },
    redirect(code: number, url: string) {
      res.statusCode = code;
      res.location = url;
      return res;
    },
  };
  return res;
}

export function fakeReq(body: Record<string, string>, ip = '203.0.113.7') {
  return { body, ip, get: (_h: string) => undefined } as never;
}
