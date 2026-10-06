/**
 * End-to-end check of the exact flow Claude performs, against a running server.
 *   npm run test:e2e -- --url https://mcp.example.com [--tool suggest_keywords]
 * Reads MCP_ACCESS_KEY from the environment (.env). Prints no tokens or keys.
 */
import { createHash, randomBytes } from 'node:crypto';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const base = (arg('url') ?? process.env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const key = process.env.MCP_ACCESS_KEY;
const tool = arg('tool') ?? 'api_status';
const REDIRECT = 'http://localhost:3118/callback';
if (!key) throw new Error('MCP_ACCESS_KEY not set');

let failures = 0;
const check = (ok: boolean, label: string, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const mcpUrl = `${base}/mcp`;
const rpc = (token: string, body: unknown) =>
  fetch(mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

// 1. Unauthenticated → 401 with resource_metadata
const unauth = await fetch(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const www = unauth.headers.get('www-authenticate') ?? '';
const rmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
check(unauth.status === 401 && !!rmUrl, 'POST /mcp without token → 401 + resource_metadata', `status ${unauth.status}`);

// 2. Discovery
const prm = (await (await fetch(rmUrl!)).json()) as { resource: string; authorization_servers: string[] };
check(prm.resource === mcpUrl, 'protected resource metadata', `resource=${prm.resource}`);
const asMeta = (await (await fetch(`${prm.authorization_servers[0]!.replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
check(!!asMeta.registration_endpoint && !!asMeta.token_endpoint, 'authorization server metadata (DCR advertised)');

// 3. Dynamic client registration
const reg = await fetch(asMeta.registration_endpoint!, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'e2e-test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
});
const client = (await reg.json()) as { client_id: string };
check(reg.status === 201 && !!client.client_id, 'client registration', `status ${reg.status}`);
const evil = await fetch(asMeta.registration_endpoint!, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
});
check(evil.status === 400, 'foreign redirect URI rejected', `status ${evil.status}`);

// 4. Authorize with PKCE → login page
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const auth = new URL(asMeta.authorization_endpoint!);
auth.search = new URLSearchParams({
  response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
  code_challenge_method: 'S256', state: 'e2e-state', scope: 'ads.read', resource: mcpUrl,
}).toString();
const page = await fetch(auth, { redirect: 'manual' });
const pending = /name="pending" value="([^"]+)"/.exec(await page.text())?.[1];
check(page.status === 200 && !!pending, 'authorize → login page');

// 5. Wrong key, then right key
const login = (k: string) =>
  fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending: pending!, key: k }) });
check((await login('definitely-wrong-key')).status === 401, 'wrong access key → 401');
const ok = await login(key);
const loc = new URL(ok.headers.get('location') ?? 'http://x/');
const code = loc.searchParams.get('code');
check(ok.status === 302 && !!code && loc.searchParams.get('state') === 'e2e-state', 'correct key → redirect with code + state');

// 6. Token exchange
const tokenRes = await fetch(asMeta.token_endpoint!, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: mcpUrl }),
});
const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
check(tokenRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token, 'code → access + refresh token', `expires_in ${tokens.expires_in}`);

// 7. MCP calls
const parse = async (r: Response) => {
  const t = await r.text();
  const json = t.startsWith('{') ? t : (t.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  return JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
};
const init = await parse(await rpc(tokens.access_token!, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } }));
check(!!init.result, 'initialize', String((init.result?.serverInfo as { name?: string })?.name ?? ''));
const list = await parse(await rpc(tokens.access_token!, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
const names = ((list.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
check(names.length > 0, 'tools/list', names.join(', '));
const toolArgs: Record<string, unknown> = arg('args')
  ? (JSON.parse(arg('args')!) as Record<string, unknown>)
  : tool === 'suggest_keywords' ? { query: 'horas extras' } : tool === 'research_keywords' ? { seeds: ['horas extras'] } : {};
const call = await parse(await rpc(tokens.access_token!, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: toolArgs } }));
const content = (call.result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? JSON.stringify(call.error);
check(!!call.result && !call.result.isError, `tools/call ${tool}`, content.split('\n')[0]);

// 8. Refresh
const refresh = await fetch(asMeta.token_endpoint!, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: client.client_id, resource: mcpUrl }),
});
check(refresh.status === 200, 'refresh token grant', `status ${refresh.status}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
