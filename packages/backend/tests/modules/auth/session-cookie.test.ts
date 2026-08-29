import { describe, expect, it } from 'vitest';
import {
  getAcceptedSessionCookieNames,
  getSessionCookieName,
  getSessionCookieNameForUrl,
  LEGACY_SESSION_COOKIE_NAME,
} from '@/modules/auth/session-cookie.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

describe('Gateway browser session cookie names', () => {
  it('uses separate per-installation names for HTTP and HTTPS', () => {
    const httpCookie = getSessionCookieName('http');
    const httpsCookie = getSessionCookieName('https');

    expect(httpCookie).toMatch(/^gateway_session_[a-f0-9]{12}_http$/);
    expect(httpsCookie).toMatch(/^gateway_session_[a-f0-9]{12}_https$/);
    expect(httpCookie).not.toBe(httpsCookie);
    expect(getSessionCookieNameForUrl('http://gateway.example.test')).toBe(httpCookie);
    expect(getSessionCookieNameForUrl('https://gateway.example.test')).toBe(httpsCookie);
  });

  it('continues to accept the legacy cookie during upgrade', () => {
    expect(getAcceptedSessionCookieNames()).toEqual([
      getSessionCookieName('https'),
      getSessionCookieName('http'),
      LEGACY_SESSION_COOKIE_NAME,
    ]);
  });
});
