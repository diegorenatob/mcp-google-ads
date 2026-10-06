/**
 * OAuth redirect URI allowlist.
 *
 * Claude's callbacks (https://claude.com/docs/connectors/building/authentication#callback-urls):
 *  - hosted apps (claude.ai, Desktop, mobile): https://claude.ai/api/mcp/auth_callback
 *  - Claude Code: http://localhost:<port>/callback or http://127.0.0.1:<port>/callback, any port
 */
export const CLAUDE_HOSTED_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function parseExtraRedirects(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedRedirectUri(uri: string, extra: readonly string[] = []): boolean {
  if (uri === CLAUDE_HOSTED_CALLBACK || extra.includes(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  // Port-agnostic loopback match used by Claude Code.
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.pathname === '/callback' &&
    url.username === '' &&
    url.password === ''
  );
}
