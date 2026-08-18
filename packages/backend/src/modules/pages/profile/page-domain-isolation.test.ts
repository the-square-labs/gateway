import { describe, expect, it } from 'vitest';
import { compareRegistrableDomains, normalizePagesHostname, registrableDomain } from './page-domain-isolation.js';

describe('Pages domain isolation', () => {
  it('compares registrable domains with public suffix awareness', () => {
    expect(compareRegistrableDomains('gateway.example.co.uk', '*.pages.example.co.uk')).toMatchObject({
      gatewayRegistrableDomain: 'example.co.uk',
      pagesRegistrableDomain: 'example.co.uk',
      same: true,
    });
    expect(compareRegistrableDomains('gateway.example.com', '*.pages-example.net').same).toBe(false);
  });

  it('includes private suffixes when deciding the cookie boundary', () => {
    expect(compareRegistrableDomains('gateway.github.io', '*.pages.github.io')).toMatchObject({
      gatewayRegistrableDomain: 'gateway.github.io',
      pagesRegistrableDomain: 'pages.github.io',
      same: false,
    });
  });

  it('does not require an override for an unregistrable local Gateway host', () => {
    expect(compareRegistrableDomains('localhost', '*.pages.example.com')).toMatchObject({
      gatewayRegistrableDomain: null,
      pagesRegistrableDomain: 'example.com',
      same: false,
    });
  });

  it('normalizes wildcard, case, trailing dots, and IDNs', () => {
    expect(normalizePagesHostname('*.PAGES.Example.COM.')).toBe('pages.example.com');
    expect(normalizePagesHostname('*.пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
  });

  it('rejects Pages hosts without a registrable public domain', () => {
    expect(() => registrableDomain('localhost')).toThrowError(
      expect.objectContaining({ code: 'PAGES_DOMAIN_NOT_REGISTRABLE' })
    );
  });
});
