import { describe, expect, it } from 'vitest';
import { normalizeAdditionalRoutePath } from './additional-route.validation.js';

describe('Additional Route path normalization', () => {
  it('canonicalizes a trailing slash and rejects root', () => {
    expect(normalizeAdditionalRoutePath('/api/')).toBe('/api');
    expect(() => normalizeAdditionalRoutePath('/')).toThrow('cannot be root');
  });

  it.each([
    '/_gateway',
    '/_gateway/anything',
    '/.well-known/acme-challenge',
    '/.well-known/acme-challenge/token',
    '/%5Fgateway',
    '/api//v1',
    '/api/../private',
    '/api?x=1',
    '/api#fragment',
    '/api/{id}',
  ])('rejects reserved or non-literal path %s', (path) => {
    expect(() => normalizeAdditionalRoutePath(path)).toThrow();
  });

  it('treats the reserved namespaces canonically and case-insensitively', () => {
    expect(() => normalizeAdditionalRoutePath('/_GATEWAY/health')).toThrow('reserved');
    expect(() => normalizeAdditionalRoutePath('/.WELL-KNOWN/acme-challenge/x')).toThrow('reserved');
    expect(normalizeAdditionalRoutePath('/_gateway-api')).toBe('/_gateway-api');
  });
});
