import { describe, expect, it } from 'vitest';
import { McpOAuthProvider } from '../src/auth/provider.js';
import { CLAUDE_HOSTED_CALLBACK, isAllowedRedirectUri } from '../src/auth/redirects.js';
import { OAuthStore } from '../src/auth/store.js';
import { mcpResourceUrl } from '../src/config.js';
import { createLogger } from '../src/util/logger.js';
import { TEST_KEY, fakeReq, fakeRes, testConfig } from './helpers.js';

describe('redirect allowlist', () => {
  it('accepts Claude hosted callback and port-agnostic loopback', () => {
    expect(isAllowedRedirectUri(CLAUDE_HOSTED_CALLBACK)).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:3118/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:50000/callback')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isAllowedRedirectUri('https://evil.example/api/mcp/auth_callback')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost:3118/other')).toBe(false);
    expect(isAllowedRedirectUri('https://localhost/callback')).toBe(false);
    expect(isAllowedRedirectUri('http://user:pw@localhost:1/callback')).toBe(false);
    expect(isAllowedRedirectUri('not a url')).toBe(false);
  });
  it('accepts configured extras', () => {
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback', ['http://localhost:6274/oauth/callback'])).toBe(true);
  });
});

function setup() {
  const config = testConfig();
  const store = new OAuthStore(config.DATA_DIR);
  const provider = new McpOAuthProvider(config, store, mcpResourceUrl(config), createLogger('error'));
  const client = provider.clientsStore.registerClient!({
    client_id: 'client-1',
    client_id_issued_at: 0,
    redirect_uris: [CLAUDE_HOSTED_CALLBACK],
    token_endpoint_auth_method: 'none',
    client_name: 'Claude',
  } as never) as never as Parameters<McpOAuthProvider['authorize']>[0];
  return { config, store, provider, client };
}

async function startAuthorization(ctx: ReturnType<typeof setup>) {
  const res = fakeRes();
  await ctx.provider.authorize(
    ctx.client,
    { redirectUri: CLAUDE_HOSTED_CALLBACK, codeChallenge: 'challenge-abc', state: 'st4te', scopes: [] },
    res as never,
  );
  const pending = /name="pending" value="([^"]+)"/.exec(res.body)?.[1];
  expect(pending).toBeTruthy();
  return pending!;
}

describe('OAuth provider', () => {
  it('rejects registration with a foreign redirect URI', () => {
    const { provider } = setup();
    expect(() =>
      provider.clientsStore.registerClient!({ redirect_uris: ['https://evil.example/cb'] } as never),
    ).toThrow(/redirect_uri not allowed/);
  });

  it('full flow: login → code → tokens → verify → refresh rotation', async () => {
    const ctx = setup();
    const pending = await startAuthorization(ctx);

    const res = fakeRes();
    ctx.provider.handleLogin(fakeReq({ pending, key: TEST_KEY }), res as never);
    expect(res.statusCode).toBe(302);
    const redirect = new URL(res.location);
    expect(redirect.origin + redirect.pathname).toBe(CLAUDE_HOSTED_CALLBACK);
    expect(redirect.searchParams.get('state')).toBe('st4te');
    const code = redirect.searchParams.get('code')!;

    expect(await ctx.provider.challengeForAuthorizationCode(ctx.client, code)).toBe('challenge-abc');
    const tokens = await ctx.provider.exchangeAuthorizationCode(ctx.client, code, undefined, CLAUDE_HOSTED_CALLBACK);
    expect(tokens.token_type).toBe('bearer');

    // code is single-use
    await expect(ctx.provider.exchangeAuthorizationCode(ctx.client, code)).rejects.toThrow(/authorization code/);

    const info = await ctx.provider.verifyAccessToken(tokens.access_token);
    expect(info.scopes).toEqual(['ads.read']);
    expect(info.clientId).toBe('client-1');

    const refreshed = await ctx.provider.exchangeRefreshToken(ctx.client, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    // old refresh token was rotated out
    await expect(ctx.provider.exchangeRefreshToken(ctx.client, tokens.refresh_token!)).rejects.toThrow(/refresh token/);
  });

  it('wrong key → 401, then rate-limited after 5 failures', async () => {
    const ctx = setup();
    const pending = await startAuthorization(ctx);
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      ctx.provider.handleLogin(fakeReq({ pending, key: 'wrong' }), res as never);
      expect(res.statusCode).toBe(401);
    }
    const res = fakeRes();
    ctx.provider.handleLogin(fakeReq({ pending, key: TEST_KEY }), res as never);
    expect(res.statusCode).toBe(429);
  });

  it('rejects a redirect_uri mismatch at token exchange', async () => {
    const ctx = setup();
    const pending = await startAuthorization(ctx);
    const res = fakeRes();
    ctx.provider.handleLogin(fakeReq({ pending, key: TEST_KEY }), res as never);
    const code = new URL(res.location).searchParams.get('code')!;
    await expect(
      ctx.provider.exchangeAuthorizationCode(ctx.client, code, undefined, 'http://localhost:1/callback'),
    ).rejects.toThrow(/redirect_uri/);
  });

  it('rejects tampered or foreign tokens', async () => {
    const { provider } = setup();
    await expect(provider.verifyAccessToken('not.a.jwt')).rejects.toThrow(/Invalid or expired/);
  });

  it('persists clients across restarts', () => {
    const ctx = setup();
    const again = new OAuthStore(ctx.config.DATA_DIR);
    expect(again.getClient('client-1')?.client_name).toBe('Claude');
  });
});
