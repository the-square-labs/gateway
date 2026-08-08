import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithPinnedAddresses: vi.fn(),
  checkOutboundWebhookTarget: vi.fn(),
}));

vi.mock('@/modules/settings/outbound-webhook-request.js', () => ({
  fetchWithPinnedAddresses: mocks.fetchWithPinnedAddresses,
}));

vi.mock('@/modules/settings/outbound-webhook-policy.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/settings/outbound-webhook-policy.service.js')>();
  return { ...actual, checkOutboundWebhookTarget: mocks.checkOutboundWebhookTarget };
});

import { SiemTransportService } from './siem-transport.service.js';

describe('SiemTransportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs the exact raw batch body with the timestamp and never sends bearer auth for HMAC', async () => {
    mocks.checkOutboundWebhookTarget.mockResolvedValue({ allowed: true, resolvedAddresses: ['203.0.113.10'] });
    mocks.fetchWithPinnedAddresses.mockResolvedValue({ status: 202, text: vi.fn().mockResolvedValue('accepted') });
    const cryptoService = { decryptString: vi.fn().mockReturnValue('hmac-secret') };
    const service = new SiemTransportService(
      {} as never,
      cryptoService as never,
      { getConfig: vi.fn().mockResolvedValue({}) } as never
    );
    const events = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        source: 'urn:wiolett:gateway:installation-1',
        type: 'com.wiolett.gateway.audit.v1' as const,
        time: '2026-08-07T12:00:00.000Z',
        data: {
          action: 'proxy_host.update',
          actor: null,
          resource: { type: 'proxy_host', id: 'proxy-1' },
          sourceIp: null,
        },
      },
    ];

    await expect(
      service.send(
        {
          url: 'https://collector.example.test/gateway/audit',
          authType: 'hmac_sha256',
          customHeaderName: null,
          encryptedSecret: '{}',
        },
        events
      )
    ).resolves.toMatchObject({ success: true, statusCode: 202 });

    const [url, addresses, options] = mocks.fetchWithPinnedAddresses.mock.calls[0] ?? [];
    expect(url).toBe('https://collector.example.test/gateway/audit');
    expect(addresses).toEqual(['203.0.113.10']);
    expect(options).toMatchObject({ method: 'POST' });
    const body = options.body as string;
    const timestamp = options.headers['X-Gateway-Timestamp'] as string;
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers['X-Gateway-Signature-256']).toBe(
      `sha256=${createHmac('sha256', 'hmac-secret').update(`${timestamp}.${body}`).digest('hex')}`
    );
    expect(JSON.parse(body)).toEqual({ schemaVersion: 1, events });
  });

  it('sends a configured custom header without replacing Gateway transport headers', async () => {
    mocks.checkOutboundWebhookTarget.mockResolvedValue({ allowed: true, resolvedAddresses: ['203.0.113.10'] });
    mocks.fetchWithPinnedAddresses.mockResolvedValue({ status: 204, text: vi.fn().mockResolvedValue('') });
    const cryptoService = { decryptString: vi.fn().mockReturnValue('collector-api-key') };
    const service = new SiemTransportService(
      {} as never,
      cryptoService as never,
      { getConfig: vi.fn().mockResolvedValue({}) } as never
    );

    await expect(
      service.send(
        {
          url: 'https://collector.example.test/gateway/audit',
          authType: 'custom_header',
          customHeaderName: 'X-API-Key',
          encryptedSecret: '{}',
        },
        []
      )
    ).resolves.toMatchObject({ success: true, statusCode: 204 });

    const [, , options] = mocks.fetchWithPinnedAddresses.mock.calls[0] ?? [];
    expect(options.headers['X-API-Key']).toBe('collector-api-key');
    expect(options.headers['X-Gateway-Timestamp']).toEqual(expect.any(String));
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers['X-Gateway-Signature-256']).toBeUndefined();
  });
});
