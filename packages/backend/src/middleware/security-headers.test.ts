import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '@/types.js';
import { securityHeadersMiddleware } from './security-headers.js';

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeadersMiddleware);
  app.get('*', (c) => c.text('ok'));
  return app;
}

describe('securityHeadersMiddleware', () => {
  it('allows sandboxed loopback callback delivery only on the OAuth consent page', async () => {
    const app = createTestApp();

    const consentCsp = (await app.request('/oauth/consent?request=test')).headers.get('Content-Security-Policy');
    expect(consentCsp).toContain('frame-src http:');

    const defaultCsp = (await app.request('/dashboard')).headers.get('Content-Security-Policy');
    expect(defaultCsp).toContain("frame-src 'none'");
    expect(defaultCsp).not.toContain('frame-src http:');
  });
});
