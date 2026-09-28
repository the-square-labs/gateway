import { describe, expect, it, vi } from 'vitest';
import { RequestACMECertSchema } from './ssl.schemas.js';
import { SSLService } from './ssl.service.js';
import { namesOnCloudflareIngressGroups } from './ssl-ingress-group-challenge.js';

function databaseWithGroupDomains(rows: Array<{ domain: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  return { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })) } as any;
}

function service(db: unknown, integrations?: { resolveCloudflareDnsContext: ReturnType<typeof vi.fn> }) {
  const ssl = new SSLService(db as any, {} as any, {} as any, { log: vi.fn() } as any, {} as any);
  if (integrations) ssl.setIntegrationsService(integrations as any);
  return ssl as unknown as {
    preferCloudflareDns01ForIngressGroups(input: unknown): Promise<Record<string, unknown>>;
  };
}

describe('ACME challenge for ingress group domains', () => {
  it('finds names covered by a Cloudflare-managed ingress group domain', async () => {
    await expect(namesOnCloudflareIngressGroups(databaseWithGroupDomains([]), [])).resolves.toBe(false);
    await expect(
      namesOnCloudflareIngressGroups(databaseWithGroupDomains([{ domain: 'example.com' }]), ['app.example.com'])
    ).resolves.toBe(true);
    await expect(namesOnCloudflareIngressGroups(databaseWithGroupDomains([]), ['app.example.com'])).resolves.toBe(
      false
    );
  });

  it('issues with DNS-01 through Cloudflare when the names are on a Cloudflare group domain', async () => {
    const resolveCloudflareDnsContext = vi.fn().mockResolvedValue({ zone: { remoteId: 'zone-1' } });
    const ssl = service(databaseWithGroupDomains([{ domain: 'app.example.com' }]), { resolveCloudflareDnsContext });
    const input = RequestACMECertSchema.parse({ domains: ['app.example.com'], challengeType: 'http-01' });
    await expect(ssl.preferCloudflareDns01ForIngressGroups(input)).resolves.toMatchObject({
      challengeType: 'dns-01',
      dnsProvider: 'cloudflare',
      autoRenew: true,
    });
  });

  it('keeps HTTP-01 when a name is outside the Cloudflare zones or not on a group domain', async () => {
    const outside = vi.fn().mockRejectedValue(new Error('zone not found'));
    const input = RequestACMECertSchema.parse({ domains: ['app.example.com'], challengeType: 'http-01' });
    await expect(
      service(databaseWithGroupDomains([{ domain: 'app.example.com' }]), {
        resolveCloudflareDnsContext: outside,
      }).preferCloudflareDns01ForIngressGroups(input)
    ).resolves.toMatchObject({ challengeType: 'http-01' });
    await expect(
      service(databaseWithGroupDomains([]), {
        resolveCloudflareDnsContext: vi.fn(),
      }).preferCloudflareDns01ForIngressGroups(input)
    ).resolves.toMatchObject({ challengeType: 'http-01' });
    // No Cloudflare connector configured at all.
    await expect(
      service(databaseWithGroupDomains([{ domain: 'app.example.com' }])).preferCloudflareDns01ForIngressGroups(input)
    ).resolves.toMatchObject({ challengeType: 'http-01' });
  });
});
