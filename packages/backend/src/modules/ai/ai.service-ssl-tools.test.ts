import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService(sslService: Record<string, unknown>) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    sslService as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('AIService SSL tool routing', () => {
  it('routes Cloudflare DNS-01 ACME requests through SSL service', async () => {
    const sslService = {
      requestACMECert: vi.fn().mockResolvedValue({ certificate: { id: 'cert-1' }, status: 'issued' }),
    };
    const service = createService(sslService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['ssl:cert:issue'] }, 'request_acme_cert', {
        domains: ['*.example.com', 'example.com'],
        challengeType: 'dns-01',
        dnsProvider: 'cloudflare',
        autoRenew: true,
      })
    ).resolves.toEqual({
      result: { certificate: { id: 'cert-1' }, status: 'issued' },
      invalidateStores: ['ssl'],
    });

    expect(sslService.requestACMECert).toHaveBeenCalledWith(
      {
        domains: ['*.example.com', 'example.com'],
        challengeType: 'dns-01',
        provider: 'letsencrypt',
        dnsProvider: 'cloudflare',
        autoRenew: true,
      },
      'user-1',
      'admin@example.com'
    );
  });

  it('uses SSL request schema defaults for manual DNS-01 ACME requests', async () => {
    const sslService = {
      requestACMECert: vi.fn().mockResolvedValue({ certificate: { id: 'cert-1' }, status: 'pending_dns_verification' }),
    };
    const service = createService(sslService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['ssl:cert:issue'] }, 'request_acme_cert', {
        domains: ['*.example.com'],
        challengeType: 'dns-01',
      })
    ).resolves.toEqual({
      result: { certificate: { id: 'cert-1' }, status: 'pending_dns_verification' },
      invalidateStores: ['ssl'],
    });

    expect(sslService.requestACMECert).toHaveBeenCalledWith(
      {
        domains: ['*.example.com'],
        challengeType: 'dns-01',
        provider: 'letsencrypt',
        autoRenew: false,
      },
      'user-1',
      'admin@example.com'
    );
  });

  it('routes SSL auto-renew updates through SSL service', async () => {
    const sslService = {
      setAutoRenew: vi.fn().mockResolvedValue({ id: 'cert-1', autoRenew: true, autoRenewProvider: 'cloudflare' }),
    };
    const service = createService(sslService);

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['ssl:cert:view', 'ssl:cert:issue:cert-1'] },
        'manage_ssl_certificate',
        {
          operation: 'set_auto_renew',
          sslCertificateId: 'cert-1',
          enabled: true,
          provider: 'cloudflare',
        }
      )
    ).resolves.toEqual({
      result: { id: 'cert-1', autoRenew: true, autoRenewProvider: 'cloudflare' },
      invalidateStores: ['ssl'],
    });

    expect(sslService.setAutoRenew).toHaveBeenCalledWith('cert-1', { enabled: true, provider: 'cloudflare' }, 'user-1');
  });

  it('rejects SSL auto-renew updates without an explicit enabled value', async () => {
    const sslService = {
      setAutoRenew: vi.fn(),
    };
    const service = createService(sslService);

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['ssl:cert:view', 'ssl:cert:issue:cert-1'] },
        'manage_ssl_certificate',
        {
          operation: 'set_auto_renew',
          sslCertificateId: 'cert-1',
          provider: 'cloudflare',
        }
      )
    ).resolves.toMatchObject({
      error: expect.stringContaining('Required'),
      invalidateStores: [],
    });

    expect(sslService.setAutoRenew).not.toHaveBeenCalled();
  });
});
