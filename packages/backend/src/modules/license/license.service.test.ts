import { afterEach, describe, expect, it, vi } from 'vitest';
import { LicenseServerRequestError, LicenseService } from './license.service.js';
import type { LicenseServerState } from './license.types.js';

function createDb() {
  const rows = new Map<string, unknown>();
  const keyFromCondition = (condition: unknown): string | undefined => {
    const chunks = (condition as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? [];
    for (const chunk of chunks) {
      const value = chunk.value;
      if (typeof value === 'string' && value.startsWith('license:')) return value;
    }
    return undefined;
  };
  return {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: () => {
            const key = keyFromCondition(condition);
            return Promise.resolve(key && rows.has(key) ? [{ key, value: rows.get(key) }] : []);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (value: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          rows.set(value.key, value.value);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (condition: unknown) => {
        const key = keyFromCondition(condition);
        if (key) rows.delete(key);
        return Promise.resolve();
      },
    }),
    rows,
  };
}

function createCrypto() {
  return {
    encryptString: (plaintext: string) => ({
      encryptedKey: `enc:${plaintext}`,
      encryptedDek: 'dek',
    }),
    decryptString: (encrypted: { encryptedKey: string }) => encrypted.encryptedKey.replace(/^enc:/, ''),
  };
}

const env = {
  APP_URL: 'https://gateway.example.com',
  APP_VERSION: 'v2.6.12',
} as never;

const communityState = (): LicenseServerState => ({
  registrationStatus: 'registered',
  effectivePlan: 'community',
  paidLicenseStatus: 'none',
  graceUntil: null,
  entitlementsVersion: 2,
  entitlements: {
    managedNodes: 100,
    users: 10,
    customPermissionGroups: 5,
    supportLevel: 'community',
    features: ['infrastructure'],
  },
  serverTime: new Date().toISOString(),
});

const paidState = (plan: 'personal' | 'business' | 'enterprise' = 'business'): LicenseServerState => ({
  registrationStatus: 'registered',
  effectivePlan: plan,
  paidLicenseStatus: 'valid',
  paidLicense: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'active',
    plan,
    name: `Test ${plan}`,
    expiresAt: '2030-01-01T00:00:00.000Z',
    keyLast4: 'DDDD',
    metadata: { order: 'A-1' },
  },
  graceUntil: null,
  entitlementsVersion: 2,
  entitlements: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority',
    features: ['infrastructure', 'structured-logging'],
  },
  activation: {
    installationId: '11111111-1111-4111-8111-111111111111',
    installationName: 'gateway.example.com',
    activatedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  },
  serverTime: new Date().toISOString(),
});

function dataResponse<T>(data: T, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
  });
}

function errorResponse(code: string, message: string, status = 409) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message } }),
  });
}

function registerResponse(state = communityState()) {
  return dataResponse(
    {
      installationToken: 'WLT-GWI-INSTALLATION-TOKEN',
      state,
    },
    201
  );
}

describe('LicenseService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns usable Community with pending registration before the first heartbeat', async () => {
    const fetcher = vi.fn();
    const service = new LicenseService(createDb() as never, createCrypto() as never, env, fetcher as never);

    const status = await service.getStatus();

    expect(status).toMatchObject({
      status: 'community',
      plan: 'community',
      registrationStatus: 'pending',
      licensed: true,
      hasKey: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('registers Community with a client-held nonce and stores only encrypted credentials', async () => {
    const db = createDb();
    const fetcher = vi.fn().mockImplementation(() => registerResponse());
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);

    await service.heartbeat();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://license.wiolett.cloud/api/v1/installations/register');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      installationName: 'gateway.example.com',
      gatewayVersion: 'v2.6.12',
    });
    expect(body.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.registrationNonce.length).toBeGreaterThanOrEqual(32);
    expect(db.rows.get('license:registration_nonce_encrypted')).toMatchObject({
      encryptedKey: expect.stringMatching(/^enc:/),
    });
    expect(db.rows.get('license:installation_token_encrypted')).toEqual({
      encryptedKey: 'enc:WLT-GWI-INSTALLATION-TOKEN',
      encryptedDek: 'dek',
    });
    expect(db.rows.has('license:installation_token')).toBe(false);
    expect(db.rows.has('license:registration_nonce')).toBe(false);
    expect(await service.getStatus()).toMatchObject({
      plan: 'community',
      registrationStatus: 'registered',
    });
  });

  it('keeps Community usable and pending when automatic registration is unavailable', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const service = new LicenseService(createDb() as never, createCrypto() as never, env, fetcher as never);

    await expect(service.heartbeat()).resolves.toBeUndefined();

    expect(await service.getStatus()).toMatchObject({
      status: 'community',
      plan: 'community',
      registrationStatus: 'pending',
      licensed: true,
      errorMessage: 'License server is unavailable',
    });
  });

  it('serializes concurrent Community registration attempts', async () => {
    const fetcher = vi.fn().mockImplementation(() => registerResponse());
    const service = new LicenseService(createDb() as never, createCrypto() as never, env, fetcher as never);

    await Promise.all([service.heartbeat(), service.heartbeat()]);

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('uses one stable installation ID across concurrent status and registration calls', async () => {
    const db = createDb();
    const fetcher = vi.fn().mockImplementation(() => registerResponse());
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);

    const [status] = await Promise.all([service.getStatus(), service.heartbeat()]);

    const registrationBody = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(status.installationId).toBe(registrationBody.installationId);
    expect(db.rows.get('license:installation_id')).toBe(status.installationId);
  });

  it('serializes heartbeat state updates with paid activation', async () => {
    const db = createDb();
    type HeartbeatResponse = Awaited<ReturnType<typeof dataResponse<LicenseServerState>>>;
    let resolveHeartbeat!: (response: HeartbeatResponse) => void;
    const heartbeatResponse = new Promise<HeartbeatResponse>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => heartbeatResponse)
      .mockImplementationOnce(() => dataResponse(paidState('business')));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);
    await service.heartbeat();
    db.rows.set('license:cached_state', {
      ...(db.rows.get('license:cached_state') as Record<string, unknown>),
      lastCheckedAt: '2020-01-01T00:00:00.000Z',
    });

    const heartbeat = service.heartbeat();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const activation = service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');
    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveHeartbeat(await dataResponse(communityState()));
    await heartbeat;
    const status = await activation;

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(status).toMatchObject({ status: 'valid', plan: 'business', hasKey: true });
  });

  it('requires online registration and activation before storing a paid key', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('business')));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);

    const status = await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      installationToken: 'WLT-GWI-INSTALLATION-TOKEN',
      licenseKey: 'WLT-GW-AAAA-BBBB-CCCC-DDDD',
    });
    expect(status).toMatchObject({
      status: 'valid',
      plan: 'business',
      registrationStatus: 'registered',
      licenseName: 'Test business',
      licenseMetadata: { order: 'A-1' },
      keyLast4: 'DDDD',
    });
    expect(db.rows.get('license:key_encrypted')).toEqual({
      encryptedKey: 'enc:WLT-GW-AAAA-BBBB-CCCC-DDDD',
      encryptedDek: 'dek',
    });
  });

  it('does not store a paid key when registration or activation fails', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => errorResponse('LICENSE_IN_USE', 'License is in use'));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);

    await expect(service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      code: 'LICENSE_IN_USE',
    });
    expect(db.rows.has('license:key_encrypted')).toBe(false);
  });

  it('keeps a previously valid paid plan only during network grace', async () => {
    const db = createDb();
    const activateFetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('enterprise')));
    const service = new LicenseService(db as never, createCrypto() as never, env, activateFetcher as never);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    const failed = new LicenseService(
      db as never,
      createCrypto() as never,
      env,
      vi.fn().mockRejectedValue(new Error('network down')) as never
    );
    const status = await failed.checkNow();

    expect(status).toMatchObject({
      status: 'valid_with_warning',
      plan: 'enterprise',
      licensed: true,
      errorMessage: 'License server is unavailable',
    });
    expect(status.offlineGraceUntil).toBeTruthy();
    expect(status.graceUntil).toBeNull();
  });

  it.each([
    ['personal', 24],
    ['business', 72],
    ['enterprise', 168],
  ] as const)('keeps %s entitlements during its %dh expiration grace', async (plan, graceHours) => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    const graceUntil = new Date(expiresAt.getTime() + graceHours * 60 * 60 * 1000);
    vi.setSystemTime(new Date(expiresAt.getTime() + 60_000));
    const state = paidState(plan);
    state.paidLicenseStatus = 'expired_grace';
    state.paidLicense!.expiresAt = expiresAt.toISOString();
    state.graceUntil = graceUntil.toISOString();
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(state));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);

    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD').catch(async () => {
      db.rows.set('license:key_encrypted', createCrypto().encryptString('WLT-GW-AAAA-BBBB-CCCC-DDDD'));
      db.rows.set('license:cached_state', {
        registrationStatus: 'registered',
        status: 'expired_grace',
        plan,
        paidPlan: plan,
        paidLicenseStatus: 'expired_grace',
        licenseName: `Test ${plan}`,
        licenseMetadata: {},
        expiresAt: expiresAt.toISOString(),
        graceUntil: graceUntil.toISOString(),
        entitlementsVersion: 2,
        entitlements: state.entitlements,
        lastCheckedAt: new Date().toISOString(),
        lastValidAt: new Date().toISOString(),
        activeInstallationId: null,
        activeInstallationName: null,
        errorMessage: null,
      });
    });

    expect(await service.getStatus()).toMatchObject({
      status: 'expired_grace',
      plan,
      licensed: true,
      graceUntil: graceUntil.toISOString(),
      entitlements: state.entitlements,
    });
  });

  it('downgrades locally when expiration grace ends without another heartbeat', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    const graceUntil = new Date('2026-08-20T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-08-17T12:01:00.000Z'));
    const state = paidState('business');
    state.paidLicenseStatus = 'expired_grace';
    state.paidLicense!.expiresAt = expiresAt.toISOString();
    state.graceUntil = graceUntil.toISOString();
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(state));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);
    await expect(service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      code: 'LICENSE_NOT_ACTIVE',
    });
    db.rows.set('license:key_encrypted', createCrypto().encryptString('WLT-GW-AAAA-BBBB-CCCC-DDDD'));
    db.rows.set('license:cached_state', {
      registrationStatus: 'registered',
      status: 'expired_grace',
      plan: 'business',
      paidPlan: 'business',
      paidLicenseStatus: 'expired_grace',
      licenseName: 'Test business',
      licenseMetadata: {},
      expiresAt: expiresAt.toISOString(),
      graceUntil: graceUntil.toISOString(),
      entitlementsVersion: 2,
      entitlements: state.entitlements,
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: new Date().toISOString(),
      activeInstallationId: null,
      activeInstallationName: null,
      errorMessage: null,
    });

    vi.setSystemTime(graceUntil);
    expect(await service.getStatus()).toMatchObject({
      status: 'expired',
      plan: 'community',
      licensed: false,
      graceUntil: null,
      entitlements: expect.objectContaining({ managedNodes: 100, users: 10, customPermissionGroups: 5 }),
    });
  });

  it('downgrades a replaced paid activation to Community authoritatively', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('personal')))
      .mockImplementationOnce(() =>
        dataResponse({
          ...communityState(),
          paidLicenseStatus: 'replaced',
          paidLicense: paidState('personal').paidLicense,
          activation: paidState('personal').activation,
        })
      );
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    const status = await service.checkNow();

    expect(status).toMatchObject({
      status: 'replaced',
      plan: 'community',
      licensed: false,
      paidLicenseStatus: 'replaced',
    });
  });

  it('detaches from the server before deleting the local paid key', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState()))
      .mockImplementationOnce(() => dataResponse(communityState()));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    const status = await service.clearKey();

    expect(fetcher.mock.calls[2]![0]).toContain('/api/v1/licenses/deactivate');
    expect(db.rows.has('license:key_encrypted')).toBe(false);
    expect(status).toMatchObject({ status: 'community', plan: 'community', hasKey: false });
  });

  it('retains the local key when server detach fails', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState()))
      .mockImplementationOnce(() => errorResponse('LICENSE_SERVER_ERROR', 'Unavailable', 503));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    await expect(service.clearKey()).rejects.toBeInstanceOf(LicenseServerRequestError);
    expect(db.rows.has('license:key_encrypted')).toBe(true);
  });

  it('uses a 30 minute Community cadence while the scheduler ticks every 15 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementation(() => dataResponse(communityState()));
    const service = new LicenseService(createDb() as never, createCrypto() as never, env, fetcher as never);

    await service.heartbeat();
    vi.setSystemTime(new Date('2026-08-16T12:15:00.000Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-08-16T12:30:00.001Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries pending Community registration no more than every 30 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const service = new LicenseService(createDb() as never, createCrypto() as never, env, fetcher as never);

    await service.heartbeat();
    vi.setSystemTime(new Date('2026-08-16T12:15:00.000Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-08-16T12:30:00.001Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('attempts one online activation for a legacy encrypted Homelab key after registration', async () => {
    const db = createDb();
    db.rows.set('license:key_encrypted', {
      encryptedKey: 'enc:WLT-GW-LEGACY',
      encryptedDek: 'dek',
    });
    db.rows.set('license:cached_state', {
      status: 'valid',
      tier: 'homelab',
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: new Date().toISOString(),
    });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('personal')));
    const service = new LicenseService(db as never, createCrypto() as never, env, fetcher as never);

    const status = await service.checkNow();

    expect(fetcher.mock.calls[1]![0]).toContain('/api/v1/licenses/activate');
    expect(status).toMatchObject({ status: 'valid', plan: 'personal' });
  });
});
