import { createHash } from 'node:crypto';
import { getEnv } from '@/config/env.js';

export const LEGACY_SESSION_COOKIE_NAME = 'session_id';

type SessionCookieTransport = 'http' | 'https';

function getInstallationCookieNamespace(): string {
  // The master key is generated per Gateway installation and persists across
  // restarts. Expose only a short one-way namespace, never the key itself.
  return createHash('sha256').update(getEnv().PKI_MASTER_KEY).digest('hex').slice(0, 12);
}

export function getSessionCookieName(transport: SessionCookieTransport): string {
  return `gateway_session_${getInstallationCookieNamespace()}_${transport}`;
}

export function getSessionCookieNameForUrl(publicUrl: string): string {
  return getSessionCookieName(new URL(publicUrl).protocol === 'https:' ? 'https' : 'http');
}

/**
 * Prefer the new names but retain session_id while clients migrate after an
 * upgrade. Accepting both transport names lets an existing browser session
 * survive a deliberate HTTP/HTTPS setting change.
 */
export function getAcceptedSessionCookieNames(): string[] {
  return [getSessionCookieName('https'), getSessionCookieName('http'), LEGACY_SESSION_COOKIE_NAME];
}
