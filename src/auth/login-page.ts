const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * CSP for the login page. No `form-action`: Chrome applies it to the redirect
 * that follows the POST, which would block the hop back to Claude.
 */
export const LOGIN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

export function renderLoginPage(opts: { pendingId: string; clientName?: string; error?: string }): string {
  const client = escapeHtml(opts.clientName || 'An MCP client');
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect to Google Ads MCP</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(92vw, 380px); padding: 28px; border: 1px solid #8884; border-radius: 12px; }
  h1 { font-size: 1.15rem; margin: 0 0 6px; }
  p { margin: 0 0 18px; opacity: .8; line-height: 1.4; }
  label { display: block; font-size: .9rem; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px; font: inherit; border-radius: 8px; border: 1px solid #8888; }
  button { margin-top: 14px; width: 100%; padding: 10px; font: inherit; border: 0; border-radius: 8px; background: #1a73e8; color: #fff; cursor: pointer; }
  .error { color: #d93025; opacity: 1; }
</style></head>
<body><main>
  <h1>Google Ads MCP</h1>
  <p><strong>${client}</strong> wants read-only access to this Google Ads MCP server.</p>
  ${error}
  <form method="post" action="/login" autocomplete="off">
    <input type="hidden" name="pending" value="${escapeHtml(opts.pendingId)}">
    <label for="key">Access key</label>
    <input id="key" name="key" type="password" required autofocus>
    <button type="submit">Connect</button>
  </form>
</main></body></html>`;
}
