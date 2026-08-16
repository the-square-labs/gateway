import { beforeEach, describe, expect, it, vi } from 'vitest';

const acmeMocks = vi.hoisted(() => ({
  createPrivateKey: vi.fn(),
  createCsr: vi.fn(),
  Client: vi.fn(),
}));

vi.mock('acme-client', () => ({
  crypto: { createPrivateKey: acmeMocks.createPrivateKey, createCsr: acmeMocks.createCsr },
  Client: acmeMocks.Client,
  directory: { letsencrypt: { staging: 'https://acme.test/staging', production: 'https://acme.test/production' } },
}));

import { ACMEService } from './acme.service.js';

describe('ACMEService HTTP-01 preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves every validation ingress before creating an ACME account or order', async () => {
    const service = new ACMEService('admin@example.com', true);
    const failure = new Error('ingress unavailable');
    service.onHttp01Preflight = vi.fn().mockRejectedValue(failure);

    await expect(service.requestCertHTTP01(['app.example.com'])).rejects.toBe(failure);
    expect(service.onHttp01Preflight).toHaveBeenCalledWith(['app.example.com']);
    expect(acmeMocks.createPrivateKey).not.toHaveBeenCalled();
    expect(acmeMocks.Client).not.toHaveBeenCalled();
  });

  it('deploys and removes each authorization token only for its own domain', async () => {
    acmeMocks.createPrivateKey.mockResolvedValue(Buffer.from('account-key'));
    acmeMocks.createCsr.mockRejectedValue(new Error('stop after challenges'));
    const client = {
      createAccount: vi.fn().mockResolvedValue(undefined),
      createOrder: vi.fn().mockResolvedValue({ url: 'order' }),
      getAuthorizations: vi.fn().mockResolvedValue([
        {
          identifier: { value: 'app.example.com' },
          challenges: [{ type: 'http-01', token: 'token-app' }],
        },
        {
          identifier: { value: 'api.example.com' },
          challenges: [{ type: 'http-01', token: 'token-api' }],
        },
      ]),
      getChallengeKeyAuthorization: vi.fn(async (challenge: { token: string }) => `key-${challenge.token}`),
      verifyChallenge: vi.fn().mockResolvedValue(undefined),
      completeChallenge: vi.fn().mockResolvedValue(undefined),
      waitForValidStatus: vi.fn().mockResolvedValue(undefined),
    };
    acmeMocks.Client.mockImplementation(function MockClient() {
      return client;
    });

    const service = new ACMEService('admin@example.com', true);
    service.onHttp01Preflight = vi.fn().mockResolvedValue(undefined);
    service.onChallengeCreate = vi.fn().mockResolvedValue(undefined);
    service.onChallengeRemove = vi.fn().mockResolvedValue(undefined);

    await expect(
      service.requestCertHTTP01(['app.example.com', 'api.example.com'], undefined, 'operator@wlt.sh')
    ).rejects.toThrow('stop after challenges');
    expect(client.createAccount).toHaveBeenCalledWith({
      termsOfServiceAgreed: true,
      contact: ['mailto:operator@wlt.sh'],
    });
    expect(service.onChallengeCreate).toHaveBeenNthCalledWith(1, 'token-app', 'key-token-app', 'app.example.com');
    expect(service.onChallengeCreate).toHaveBeenNthCalledWith(2, 'token-api', 'key-token-api', 'api.example.com');
    expect(service.onChallengeRemove).toHaveBeenCalledWith('token-app', 'app.example.com');
    expect(service.onChallengeRemove).toHaveBeenCalledWith('token-api', 'api.example.com');
  });

  it('returns a typed safe error when the provider rejects the contact email', async () => {
    acmeMocks.createPrivateKey.mockResolvedValue(Buffer.from('account-key'));
    const client = {
      createAccount: vi
        .fn()
        .mockRejectedValue(new Error('Error validating contact(s) :: contact email has forbidden domain')),
    };
    acmeMocks.Client.mockImplementation(function MockClient() {
      return client;
    });

    const service = new ACMEService('fallback@example.com', true);

    await expect(
      service.requestCertDNS01Start(['app.example.com'], undefined, 'operator@example.com')
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ACME_CONTACT_EMAIL_REJECTED',
      message:
        'ACME provider rejected contact email "operator@example.com": Error validating contact(s) :: contact email has forbidden domain',
    });
  });
});
