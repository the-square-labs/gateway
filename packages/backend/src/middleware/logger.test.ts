import { describe, expect, it } from 'vitest';
import { redactRequestPath } from './logger.js';

describe('redactRequestPath', () => {
  it('redacts the public Docker webhook bearer token', () => {
    expect(redactRequestPath('/api/webhooks/docker/sensitive-token')).toBe('/api/webhooks/docker/[REDACTED]');
  });

  it('redacts the token segment on malformed paths that reach request logging', () => {
    expect(redactRequestPath('/api/webhooks/docker/sensitive-token/')).toBe('/api/webhooks/docker/[REDACTED]/');
    expect(redactRequestPath('/api/webhooks/docker/sensitive-token/extra')).toBe(
      '/api/webhooks/docker/[REDACTED]/extra'
    );
  });

  it('preserves non-webhook request paths', () => {
    expect(redactRequestPath('/api/docker/nodes/node-1/containers')).toBe('/api/docker/nodes/node-1/containers');
    expect(redactRequestPath('/api/webhooks/dockerish/sensitive-token')).toBe(
      '/api/webhooks/dockerish/sensitive-token'
    );
  });
});
