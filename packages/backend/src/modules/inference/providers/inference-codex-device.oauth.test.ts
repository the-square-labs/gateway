import { describe, expect, it, vi } from 'vitest';
import { pollCodexDevice, startCodexDevice } from './inference-codex-device.oauth.js';
import type { InferenceOAuthCodexDeviceConfig } from './inference-provider.types.js';

const OAUTH: InferenceOAuthCodexDeviceConfig = {
  flow: 'codex_device',
  clientId: 'codex-client',
  userCodeUrl: 'https://auth.example/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.example/api/accounts/deviceauth/token',
  verificationUrl: 'https://auth.example/codex/device',
  tokenUrl: 'https://auth.example/oauth/token',
  redirectUri: 'https://auth.example/deviceauth/callback',
};

describe('Codex device OAuth', () => {
  it('starts the remote-safe device flow without a localhost callback', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-1234', interval: '7' }));

    const result = await startCodexDevice(OAUTH, fetcher);

    expect(result).toEqual({
      authorizationUrl: OAUTH.verificationUrl,
      userCode: 'ABCD-1234',
      pollIntervalSeconds: 7,
      pending: { deviceAuthId: 'device-1', userCode: 'ABCD-1234' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      OAUTH.userCodeUrl,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ client_id: OAUTH.clientId }) })
    );
  });

  it('treats provider pending responses as retryable and exchanges the issued code', async () => {
    const pendingFetcher = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      pollCodexDevice(OAUTH, { deviceAuthId: 'device-1', userCode: 'ABCD-1234' }, pendingFetcher)
    ).resolves.toBeNull();

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ authorization_code: 'authorization-code', code_verifier: 'verifier' }))
      .mockResolvedValueOnce(
        Response.json({ access_token: 'access', refresh_token: 'refresh', id_token: 'header.payload.sig' })
      );
    const result = await pollCodexDevice(OAUTH, { deviceAuthId: 'device-1', userCode: 'ABCD-1234' }, fetcher);

    expect(result).toMatchObject({ access_token: 'access', refresh_token: 'refresh' });
    const exchange = fetcher.mock.calls[1];
    expect(exchange?.[0]).toBe(OAUTH.tokenUrl);
    expect(String(exchange?.[1]?.body)).toContain('redirect_uri=https%3A%2F%2Fauth.example%2Fdeviceauth%2Fcallback');
    expect(String(exchange?.[1]?.body)).toContain('code_verifier=verifier');
  });
});
