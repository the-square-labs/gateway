import { describe, expect, it } from 'vitest';
import { CreateDomainSchema, ResolveCloudflareMigrationSchema } from './domain.schemas.js';

describe('domain schemas', () => {
  it('canonicalizes registered domains before persistence', () => {
    expect(CreateDomainSchema.parse({ domain: ' APP.Example.COM ' }).domain).toBe('app.example.com');
    expect(CreateDomainSchema.parse({ domain: ' *.Example.COM ' }).domain).toBe('*.example.com');
  });

  it('preserves Cloudflare as the compatible default and accepts external DNS mode', () => {
    expect(CreateDomainSchema.parse({ domain: 'app.example.com' }).dnsProvider).toBe('cloudflare');
    expect(CreateDomainSchema.parse({ domain: 'app.example.com', dnsProvider: 'external' }).dnsProvider).toBe(
      'external'
    );
  });

  it('requires a node only for explicit Cloudflare DNS updates', () => {
    expect(ResolveCloudflareMigrationSchema.parse({ action: 'retry' })).toEqual({ action: 'retry' });
    expect(ResolveCloudflareMigrationSchema.parse({ action: 'keep_external' })).toEqual({ action: 'keep_external' });
    expect(() => ResolveCloudflareMigrationSchema.parse({ action: 'update_dns' })).toThrow();
  });
});
