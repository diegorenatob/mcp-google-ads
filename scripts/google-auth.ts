/**
 * One-time Google OAuth flow that writes GOOGLE_ADS_REFRESH_TOKEN into .env.
 *
 *   npm run google:auth                 # interactive: prints a URL, asks you to paste the redirect URL
 *   npm run google:auth -- --code-url "http://localhost:9876/?code=..."   # non-interactive
 *
 * The refresh token is never printed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const REDIRECT_URI = 'http://localhost:9876';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const ENV_FILE = process.env.ENV_FILE ?? '.env';

const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'select_account consent',
}).toString();

const argIdx = process.argv.indexOf('--code-url');
let pasted = argIdx > -1 ? process.argv[argIdx + 1] : undefined;

if (!pasted) {
  console.log('\n1. Open this URL in YOUR browser and sign in with the account that manages Google Ads:\n');
  console.log(`   ${authUrl.href}\n`);
  console.log('2. After accepting, the browser fails to load http://localhost:9876/?code=... — that is expected.');
  console.log('3. Copy the FULL URL from the address bar and paste it here.\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  pasted = (await rl.question('Redirect URL: ')).trim();
  rl.close();
}

let code: string | null;
try {
  code = new URL(pasted!).searchParams.get('code');
} catch {
  code = pasted?.startsWith('4/') ? pasted : null;
}
if (!code) {
  console.error('No "code" found in what you pasted.');
  process.exit(1);
}

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  }),
});
const body = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
if (!body.refresh_token) {
  console.error(`Token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ''}`);
  console.error('Codes expire within minutes and are single-use: run the command again.');
  process.exit(1);
}

const line = `GOOGLE_ADS_REFRESH_TOKEN=${body.refresh_token}`;
const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
const next = /^GOOGLE_ADS_REFRESH_TOKEN=.*$/m.test(current)
  ? current.replace(/^GOOGLE_ADS_REFRESH_TOKEN=.*$/m, line)
  : `${current.replace(/\n?$/, '\n')}${line}\n`;
writeFileSync(ENV_FILE, next, { mode: 0o600 });

console.log(`\nSaved GOOGLE_ADS_REFRESH_TOKEN to ${ENV_FILE} (${body.refresh_token.length} chars, not shown).`);
console.log('Apply it with: docker compose up -d --force-recreate');
