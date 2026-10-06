import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { isAllowedRedirectUri, parseExtraRedirects } from './redirects.js';
import { FailureLimiter } from './rate-limit.js';
import { LOGIN_PAGE_CSP, renderLoginPage } from './login-page.js';
import type { OAuthStore } from './store.js';

export const SCOPE = 'ads.read';
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

interface Grant {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

const randomToken = () => randomBytes(32).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const sameResource = (a: URL, b: URL) => a.href.replace(/\/$/, '') === b.href.replace(/\/$/, '');

/**
 * Single-tenant OAuth 2.1 authorization server for Claude's connector flow.
 * The SDK router handles discovery, DCR, PKCE validation and the HTTP layer;
 * this class owns clients, the access-key login, and token issuance.
 */
export class McpOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, Grant>();
  private readonly codes = new Map<string, Grant>();
  private readonly limiter = new FailureLimiter();
  private readonly jwtKey: Uint8Array;
  private readonly extraRedirects: string[];

  constructor(
    private readonly config: Config,
    private readonly store: OAuthStore,
    private readonly resourceUrl: URL,
    private readonly logger: Logger,
  ) {
    this.jwtKey = new TextEncoder().encode(config.MCP_JWT_SECRET);
    this.extraRedirects = parseExtraRedirects(config.MCP_ALLOWED_REDIRECT_URIS);
    setInterval(() => this.sweep(), 60_000).unref();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: (client) => {
        const uris = client.redirect_uris ?? [];
        const rejected = uris.filter((u) => !isAllowedRedirectUri(String(u), this.extraRedirects));
        if (uris.length === 0 || rejected.length > 0) {
          this.logger.warn('client registration rejected', { redirect_uris: uris.map(String) });
          throw new InvalidClientMetadataError(
            `redirect_uri not allowed: ${rejected.join(', ') || '(none given)'}`,
          );
        }
        // The SDK has already generated client_id / client_id_issued_at.
        const saved = this.store.saveClient(client as OAuthClientInformationFull);
        this.logger.info('client registered', { client_id: saved.client_id, client_name: saved.client_name });
        return saved;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource, this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource: ${params.resource.href}`);
    }
    const pendingId = randomToken();
    this.pending.set(pendingId, { clientId: client.client_id, params, expiresAt: Date.now() + PENDING_TTL_MS });
    this.sendLoginPage(res, 200, { pendingId, clientName: client.client_name });
  }

  /** POST /login — checks the access key and finishes the authorization. */
  handleLogin = (req: Request, res: Response): void => {
    const ip = req.get('cf-connecting-ip') || req.ip || 'unknown';
    const pendingId = typeof req.body?.pending === 'string' ? req.body.pending : '';
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    const grant = this.pending.get(pendingId);

    if (!grant || grant.expiresAt <= Date.now()) {
      this.pending.delete(pendingId);
      res.status(400).type('text/plain').send('This sign-in link expired. Go back to Claude and click Connect again.');
      return;
    }
    if (this.limiter.isBlocked(ip)) {
      this.logger.warn('login blocked by rate limit', { ip });
      this.sendLoginPage(res, 429, { pendingId, error: 'Too many failed attempts. Try again in 15 minutes.' });
      return;
    }
    if (!this.keyMatches(key)) {
      this.limiter.fail(ip);
      this.logger.warn('login failed', { ip });
      this.sendLoginPage(res, 401, { pendingId, error: 'Wrong access key.' });
      return;
    }

    this.limiter.reset(ip);
    this.pending.delete(pendingId);
    const code = randomToken();
    this.codes.set(code, { ...grant, expiresAt: Date.now() + CODE_TTL_MS });
    this.logger.info('login succeeded', { client_id: grant.clientId, ip });

    const target = new URL(grant.params.redirectUri);
    target.searchParams.set('code', code);
    if (grant.params.state !== undefined) target.searchParams.set('state', grant.params.state);
    res.redirect(302, target.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.validCode(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = this.validCode(client, code);
    this.codes.delete(code); // single use
    if (redirectUri && redirectUri !== grant.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && !sameResource(resource, this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
    }
    this.store.touchClient(client.client_id);
    return this.issueTokens(client.client_id);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.store.takeRefreshToken(sha256Hex(refreshToken)); // rotation: old token dies
    if (!rec || rec.client_id !== client.client_id || rec.expires_at <= Date.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (resource && !sameResource(resource, this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
    }
    this.store.touchClient(client.client_id);
    return this.issueTokens(client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: this.config.PUBLIC_URL,
        audience: this.resourceUrl.href,
        algorithms: ['HS256'],
      });
      return {
        token,
        clientId: String(payload.client_id ?? ''),
        scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
        expiresAt: payload.exp,
        resource: this.resourceUrl,
      };
    } catch {
      throw new InvalidTokenError('Invalid or expired access token');
    }
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256Hex(request.token);
    if (this.store.peekRefreshToken(hash)?.client_id === client.client_id) {
      this.store.takeRefreshToken(hash);
    }
    // Access tokens are short-lived JWTs; they expire on their own.
  }

  private async issueTokens(clientId: string): Promise<OAuthTokens> {
    const ttl = this.config.MCP_ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await new SignJWT({ scope: SCOPE, client_id: clientId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.PUBLIC_URL)
      .setAudience(this.resourceUrl.href)
      .setSubject('owner')
      .setIssuedAt()
      .setJti(randomToken())
      .setExpirationTime(`${ttl}s`)
      .sign(this.jwtKey);

    const refreshToken = randomToken();
    this.store.addRefreshToken(sha256Hex(refreshToken), {
      client_id: clientId,
      scopes: [SCOPE],
      expires_at: Date.now() + this.config.MCP_REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });

    return { access_token: accessToken, token_type: 'bearer', expires_in: ttl, refresh_token: refreshToken, scope: SCOPE };
  }

  private validCode(client: OAuthClientInformationFull, code: string): Grant {
    const grant = this.codes.get(code);
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt <= Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return grant;
  }

  /** Constant-time comparison of SHA-256 digests (equal length by construction). */
  private keyMatches(candidate: string): boolean {
    return timingSafeEqual(sha256(candidate), sha256(this.config.MCP_ACCESS_KEY));
  }

  private sendLoginPage(
    res: Response,
    status: number,
    opts: { pendingId: string; clientName?: string; error?: string },
  ): void {
    res
      .status(status)
      .set({
        'Content-Security-Policy': LOGIN_PAGE_CSP,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      .type('html')
      .send(renderLoginPage(opts));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, g] of this.pending) if (g.expiresAt <= now) this.pending.delete(k);
    for (const [k, g] of this.codes) if (g.expiresAt <= now) this.codes.delete(k);
  }
}
