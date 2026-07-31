import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { authenticateBearerToken, SESSION_COOKIE_NAME } from '@/modules/auth/auth.middleware.js';
import { resolveLiveSessionUser } from '@/modules/auth/live-session-user.js';
import type { User } from '@/types.js';

export type WebSocketCredential =
  | {
      type: 'session';
      value: string;
    }
  | {
      type: 'bearer';
      value: string;
    };

export type WebSocketAuthResult = {
  user: User;
  scopes: string[];
};

export function getCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return rawValue.join('=');
  }
  return '';
}

export function getBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith('Bearer ')) return '';
  const token = authorizationHeader.slice(7).trim();
  return token.startsWith('gw_') || token.startsWith('gwo_') ? token : '';
}

export function getSessionWebSocketCredential(
  cookieHeader: string | undefined,
  origin: string | undefined,
  isAllowedOrigin: (origin: string | undefined) => boolean
): WebSocketCredential | null {
  if (!isAllowedOrigin(origin)) return null;
  const sessionId = getCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  return sessionId ? { type: 'session', value: sessionId } : null;
}

export function getProgrammaticWebSocketCredential(
  cookieHeader: string | undefined,
  origin: string | undefined,
  authorizationHeader: string | undefined,
  isAllowedOrigin: (origin: string | undefined) => boolean
): WebSocketCredential | null {
  const bearerToken = getBearerToken(authorizationHeader);
  if (bearerToken) return { type: 'bearer', value: bearerToken };
  return getSessionWebSocketCredential(cookieHeader, origin, isAllowedOrigin);
}

export async function resolveWebSocketCredential(
  credential: WebSocketCredential | null,
  requiredScope: string
): Promise<WebSocketAuthResult | null> {
  const result = await resolveWebSocketCredentialContext(credential);
  if (!result || !hasScope(result.scopes, requiredScope)) return null;
  return result;
}

export async function resolveWebSocketCredentialForScopeBase(
  credential: WebSocketCredential | null,
  requiredScopeBase: string
): Promise<WebSocketAuthResult | null> {
  const result = await resolveWebSocketCredentialContext(credential);
  if (!result || !hasScopeBase(result.scopes, requiredScopeBase)) return null;
  return result;
}

async function resolveWebSocketCredentialContext(
  credential: WebSocketCredential | null
): Promise<WebSocketAuthResult | null> {
  if (!credential) return null;
  const result =
    credential.type === 'session'
      ? await resolveLiveSessionUser(credential.value).then((value) =>
          value ? { user: value.user, scopes: value.effectiveScopes } : null
        )
      : await authenticateBearerToken(credential.value);
  if (!result || result.user.isBlocked) return null;
  return {
    user: result.user,
    scopes: result.scopes,
  };
}
