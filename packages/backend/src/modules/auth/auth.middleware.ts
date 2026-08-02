import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, User } from '@/types.js';

const SESSION_COOKIE_NAME = 'session_id';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type CredentialType = 'session' | 'api-token' | 'oauth-token';

type AuthenticatedBearer = {
  type: Exclude<CredentialType, 'session'>;
  user: User;
  scopes: string[];
  tokenId: string;
  tokenPrefix: string;
  clientId?: string;
};

function extractCredential(c: Context<AppEnv>): { type: CredentialType; value: string } | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const value = authHeader.slice(7).trim();
    if (value.startsWith('gw_')) {
      return { type: 'api-token', value };
    }
    if (value.startsWith('gwo_')) {
      return { type: 'oauth-token', value };
    }
  }

  const cookieSession = getCookie(c, SESSION_COOKIE_NAME);
  if (cookieSession) return { type: 'session', value: cookieSession };

  return null;
}

function requiresCsrf(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

function allowsBlockedSessionPath(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return path === '/auth/csrf' || path === '/auth/me' || path === '/auth/logout';
}

export async function authenticateBearerToken(rawToken: string): Promise<AuthenticatedBearer | null> {
  if (rawToken.startsWith('gw_')) {
    const tokensService = container.resolve(TokensService);
    const result = await tokensService.validateToken(rawToken);
    if (!result) return null;
    return {
      type: 'api-token',
      user: result.user,
      scopes: result.scopes,
      tokenId: result.tokenId,
      tokenPrefix: result.tokenPrefix,
    };
  }

  if (rawToken.startsWith('gwo_')) {
    const oauthService = container.resolve(OAuthService);
    const result = await oauthService.validateAccessToken(rawToken, { resource: oauthService.getApiResourceUrl() });
    if (!result) return null;
    return {
      type: 'oauth-token',
      user: result.user,
      scopes: result.scopes,
      tokenId: result.tokenId,
      tokenPrefix: result.tokenPrefix,
      clientId: result.clientId,
    };
  }

  return null;
}

function applyBearerContext(c: Context<AppEnv>, result: AuthenticatedBearer): void {
  c.set('user', result.user);
  c.set('effectiveScopes', result.scopes);
  c.set('isTokenAuth', true);
  c.set('authType', result.type);
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credential = extractCredential(c);

  if (!credential) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  if (credential.type === 'api-token' || credential.type === 'oauth-token') {
    const result = await authenticateBearerToken(credential.value);
    if (!result) {
      throw new HTTPException(401, { message: 'Invalid or expired bearer token' });
    }
    applyBearerContext(c, result);
  } else {
    const sessionService = container.resolve(SessionService);
    const session = await sessionService.getSession(credential.value);
    if (!session) {
      throw new HTTPException(401, { message: 'Invalid or expired session' });
    }
    if (
      requiresCsrf(c.req.method) &&
      !(await sessionService.validateCsrfToken(credential.value, c.req.header(CSRF_HEADER_NAME), session))
    ) {
      throw new HTTPException(403, { message: 'Invalid CSRF token' });
    }
    const sessionUserId = session.userId ?? session.user?.id;
    if (!sessionUserId) {
      await sessionService.destroySession(credential.value);
      throw new HTTPException(401, { message: 'Invalid or expired session' });
    }
    const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
    const user = await resolveLiveUser(db, sessionUserId);
    if (!user) {
      throw new HTTPException(401, { message: 'User no longer exists' });
    }
    if (user.isBlocked && !allowsBlockedSessionPath(c)) {
      throw new HTTPException(403, { message: 'Account is blocked' });
    }

    c.set('user', user);
    c.set('sessionId', credential.value);
    c.set('effectiveScopes', user.scopes);
    c.set('isTokenAuth', false);
    c.set('authType', 'session');
    sessionService.updateSession(credential.value, { user }).catch(() => {});
    sessionService.touchSession?.(credential.value, session).catch(() => {});
    sessionService.refreshSession(credential.value, session).catch(() => {});
  }

  await next();
};

export const optionalAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credential = extractCredential(c);

  if (credential) {
    if (credential.type === 'api-token' || credential.type === 'oauth-token') {
      const result = await authenticateBearerToken(credential.value);
      if (result) {
        applyBearerContext(c, result);
      }
    } else {
      const sessionService = container.resolve(SessionService);
      const session = await sessionService.getSession(credential.value);
      if (session) {
        const sessionUserId = session.userId ?? session.user?.id;
        if (!sessionUserId) {
          await sessionService.destroySession(credential.value);
          await next();
          return;
        }
        const db2 = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
        const user = await resolveLiveUser(db2, sessionUserId);
        if (!user) {
          await sessionService.destroySession(credential.value);
        } else {
          c.set('user', user);
          c.set('sessionId', credential.value);
          c.set('effectiveScopes', user.scopes);
          c.set('isTokenAuth', false);
          c.set('authType', 'session');
          sessionService.updateSession(credential.value, { user }).catch(() => {});
          sessionService.touchSession?.(credential.value, session).catch(() => {});
          sessionService.refreshSession(credential.value, session).catch(() => {});
        }
      }
    }
  }

  await next();
};

/**
 * Middleware that rejects blocked users. Apply to all API routes
 * except /auth/me and /auth/logout (which must remain accessible
 * so the frontend can detect blocked status and log out).
 */
export const requireActiveUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (user?.isBlocked) {
    throw new HTTPException(403, { message: 'Account is blocked' });
  }
  await next();
};

/**
 * Unified scope-based permission middleware.
 * Fires for BOTH session users and API token users.
 * Session users' scopes combine their permission group with user-specific additional permissions.
 * Token users' scopes are bounded by both the token and the owner's current effective permissions.
 */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !TokensService.hasScope(scopes, scope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scope}` });
    }
    await next();
  };
}

export function requireScopeBase(scopeBase: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !hasScopeBase(scopes, scopeBase)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scopeBase}` });
    }
    await next();
  };
}

/**
 * Require ANY of the listed scopes (OR logic).
 * Useful when a route should be accessible to users with different scope hierarchies.
 */
export function requireAnyScope(...requiredScopes: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !requiredScopes.some((s) => TokensService.hasScope(scopes, s))) {
      throw new HTTPException(403, { message: `Missing required scope: one of ${requiredScopes.join(', ')}` });
    }
    await next();
  };
}

/**
 * Resource-scoped permission check.
 * Builds scopeBase:resourceId from a URL param and checks against effective scopes.
 */
export function requireScopeForResource(scopeBase: string, paramName: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resourceId = c.req.param(paramName);
    const scopes = c.get('effectiveScopes');
    const fullScope = resourceId ? `${scopeBase}:${resourceId}` : scopeBase;
    if (!scopes || !TokensService.hasScope(scopes, fullScope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${fullScope}` });
    }
    await next();
  };
}

/**
 * Middleware that restricts access to session-authenticated users only.
 * API tokens are not allowed.
 */
export const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('authType') !== 'session') {
    throw new HTTPException(403, {
      message: 'This endpoint requires browser session authentication.',
    });
  }
  await next();
};

export const requireBrowserSession = sessionOnly;

export function isProgrammaticAuth(c: Context<AppEnv>): boolean {
  return c.get('authType') === 'api-token' || c.get('authType') === 'oauth-token';
}

export { CSRF_HEADER_NAME, SESSION_COOKIE_NAME };
