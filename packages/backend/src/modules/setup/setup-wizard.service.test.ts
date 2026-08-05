import { describe, expect, it, vi } from 'vitest';
import { SetupWizardService } from './setup-wizard.service.js';

function createHarness() {
  const policy = {
    isGatewayConfigured: vi.fn().mockResolvedValue(false),
    markSetupComplete: vi.fn(),
  };
  const access = { invalidate: vi.fn() };
  const general = {
    getConfig: vi.fn().mockResolvedValue({ publicUrl: null, gatewayPublicIps: [] }),
    updateConfig: vi.fn().mockResolvedValue({ publicUrl: 'https://gateway.example.com' }),
    requirePublicUrl: vi.fn().mockResolvedValue('https://gateway.example.com'),
  };
  const authSettings = {
    getConfig: vi.fn().mockResolvedValue({ methods: { oidc: true, password: true, emailOtp: true } }),
    updateConfig: vi.fn(async (value) => value),
  };
  const oidc = {
    saveConfig: vi.fn(),
    getPublicConfig: vi.fn().mockResolvedValue({ configured: true }),
    snapshotConfig: vi.fn().mockResolvedValue(null),
    restoreConfig: vi.fn(),
  };
  const mail = {
    saveConfig: vi.fn(),
    verifyAndSaveConfig: vi.fn(),
    sendTestEmail: vi.fn(),
    getPublicConfig: vi.fn().mockResolvedValue({ configured: true, verifiedAt: '2026-08-03T00:00:00.000Z' }),
    snapshotConfig: vi.fn().mockResolvedValue(null),
    restoreConfig: vi.fn(),
  };
  const createdUser = {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Admin',
    authMethod: 'password',
  };
  const auth = {
    createUser: vi.fn().mockResolvedValue(createdUser),
    invalidateOidcConfiguration: vi.fn(),
  };
  const local = {
    setInitialPasswordForSetup: vi.fn(),
    validateInitialPasswordForSetup: vi.fn(),
  };
  const finalizeSetup = {
    initializeOwner: vi.fn(),
    clearOwner: vi.fn(),
  };
  const refreshGrpcIdentity = vi.fn();
  const refreshWebIdentity = vi.fn();
  const claimReturning = vi.fn().mockResolvedValue([{ key: 'setup:first_admin_claim' }]);
  const db = {
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({ returning: claimReturning })),
      })),
    })),
    query: {
      permissionGroups: {
        findFirst: vi.fn().mockResolvedValue({ id: 'system-admin-id', name: 'system-admin' }),
      },
    },
  };
  const service = new SetupWizardService(
    db as any,
    policy as any,
    access as any,
    general as any,
    authSettings as any,
    oidc as any,
    mail as any,
    auth as any,
    local as any,
    finalizeSetup as any,
    refreshGrpcIdentity,
    refreshWebIdentity
  );
  const logging = {
    update: vi.fn(),
    snapshot: vi.fn().mockResolvedValue({ mode: 'disabled' }),
    restore: vi.fn(),
  };
  return {
    service,
    policy,
    access,
    general,
    authSettings,
    oidc,
    mail,
    auth,
    local,
    finalizeSetup,
    logging,
    claimReturning,
    refreshGrpcIdentity,
    refreshWebIdentity,
  };
}

const APPLY_INPUT = {
  publicUrl: 'https://gateway.example.com',
  network: {
    publicIps: ['203.0.113.10'],
    grpcPublicTarget: 'gateway.example.com:9443',
    grpcLocalIp: '192.168.1.10',
  },
  auth: {
    methods: { oidc: false, password: true, emailOtp: false },
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      tlsMode: 'starttls' as const,
      username: 'gateway',
      password: 'smtp-secret',
      senderName: 'Gateway',
      senderEmail: 'gateway@example.com',
    },
  },
  administrator: {
    name: 'Admin',
    email: 'admin@example.com',
    authMethod: 'password' as const,
    password: 'correct horse battery staple',
  },
  logging: { mode: 'disabled' as const },
};

describe('SetupWizardService', () => {
  it('applies the complete setup only from the final operation without sending a test email', async () => {
    const harness = createHarness();
    harness.policy.isGatewayConfigured
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await harness.service.apply(APPLY_INPUT, harness.logging as any);

    expect(harness.general.updateConfig).toHaveBeenCalledWith({
      publicUrl: 'https://gateway.example.com',
      gatewayPublicIps: ['203.0.113.10'],
      gatewayGrpcPublicTarget: 'gateway.example.com:9443',
      gatewayGrpcLocalIp: '192.168.1.10',
    });
    expect(harness.refreshGrpcIdentity).toHaveBeenCalledOnce();
    expect(harness.refreshWebIdentity).toHaveBeenCalledOnce();
    expect(harness.mail.verifyAndSaveConfig).toHaveBeenCalledWith(APPLY_INPUT.auth.smtp);
    expect(harness.mail.sendTestEmail).not.toHaveBeenCalled();
    expect(harness.logging.update).toHaveBeenCalledWith({ mode: 'disabled' });
    expect(harness.auth.createUser).toHaveBeenCalledOnce();
    expect(harness.policy.markSetupComplete).toHaveBeenCalledOnce();
    expect(harness.access.invalidate).toHaveBeenCalledOnce();
  });

  it('finishes a previously partial setup without creating another administrator', async () => {
    const harness = createHarness();
    harness.policy.isGatewayConfigured.mockResolvedValue(true);

    await harness.service.apply({ ...APPLY_INPUT, administrator: undefined }, harness.logging as any);

    expect(harness.auth.createUser).not.toHaveBeenCalled();
    expect(harness.policy.markSetupComplete).toHaveBeenCalledOnce();
  });

  it('rolls back live configuration when final apply fails', async () => {
    const harness = createHarness();
    harness.logging.update.mockRejectedValueOnce(new Error('ClickHouse unavailable'));

    await expect(harness.service.apply(APPLY_INPUT, harness.logging as any)).rejects.toThrow('ClickHouse unavailable');

    expect(harness.logging.restore).toHaveBeenCalledWith({ mode: 'disabled' });
    expect(harness.oidc.restoreConfig).toHaveBeenCalledWith(null);
    expect(harness.mail.restoreConfig).toHaveBeenCalledWith(null);
    expect(harness.general.updateConfig).toHaveBeenLastCalledWith({ publicUrl: null, gatewayPublicIps: [] });
    expect(harness.auth.createUser).not.toHaveBeenCalled();
    expect(harness.policy.markSetupComplete).not.toHaveBeenCalled();
  });

  it('rejects invalid network settings before applying any configuration', async () => {
    const harness = createHarness();

    await expect(
      harness.service.apply(
        {
          ...APPLY_INPUT,
          network: { ...APPLY_INPUT.network, publicIps: [] },
        },
        harness.logging as any
      )
    ).rejects.toThrow('Select exactly one Gateway public IP');

    await expect(
      harness.service.apply(
        {
          ...APPLY_INPUT,
          network: { ...APPLY_INPUT.network, publicIps: ['203.0.113.10', '203.0.113.11'] },
        },
        harness.logging as any
      )
    ).rejects.toThrow('Select exactly one Gateway public IP');

    expect(harness.general.updateConfig).not.toHaveBeenCalled();
    expect(harness.authSettings.updateConfig).not.toHaveBeenCalled();
    expect(harness.logging.update).not.toHaveBeenCalled();
  });

  it('creates exactly one deliberate administrator in the built-in system-admin group', async () => {
    const harness = createHarness();
    await harness.service.createAdministrator({
      name: 'Admin',
      email: 'admin@example.com',
      authMethod: 'password',
      password: 'correct horse battery staple',
    });

    expect(harness.auth.createUser).toHaveBeenCalledWith({
      name: 'Admin',
      email: 'admin@example.com',
      groupId: 'system-admin-id',
      authMethod: 'password',
    });
    expect(harness.local.validateInitialPasswordForSetup).toHaveBeenCalledWith('correct horse battery staple');
    expect(harness.local.setInitialPasswordForSetup).toHaveBeenCalledWith('user-1', 'correct horse battery staple');
    expect(harness.finalizeSetup.initializeOwner).toHaveBeenCalledWith('user-1');
  });

  it('rejects a concurrent first-administrator request that did not obtain the database claim', async () => {
    const harness = createHarness();
    harness.claimReturning.mockResolvedValue([]);

    await expect(
      harness.service.createAdministrator({
        name: 'Another Admin',
        email: 'other@example.com',
        authMethod: 'oidc',
      })
    ).rejects.toThrow('already being created');
    expect(harness.auth.createUser).not.toHaveBeenCalled();
  });

  it('refuses to create another administrator once any real user exists', async () => {
    const harness = createHarness();
    harness.policy.isGatewayConfigured.mockResolvedValue(true);

    await expect(
      harness.service.createAdministrator({
        name: 'Admin',
        email: 'admin@example.com',
        authMethod: 'oidc',
      })
    ).rejects.toThrow('already been created');
    expect(harness.auth.createUser).not.toHaveBeenCalled();
  });

  it('locks setup and invalidates the one-time code only after required state exists', async () => {
    const harness = createHarness();
    harness.policy.isGatewayConfigured.mockResolvedValue(true);

    await harness.service.complete();

    expect(harness.general.requirePublicUrl).toHaveBeenCalledOnce();
    expect(harness.policy.markSetupComplete).toHaveBeenCalledOnce();
    expect(harness.access.invalidate).toHaveBeenCalledOnce();
  });
});
