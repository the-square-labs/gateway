import { describe, expect, it, vi } from 'vitest';
import { GeneralSettingsService, normalizePublicUrl, normalizeShutdownSettings } from './general-settings.service.js';

/** Runs the transaction callback on the same mock; the fake has no real lock. */
function transactional<T extends object>(db: T) {
  const execute = vi.fn().mockResolvedValue(undefined);
  const transactionDb = Object.assign(db, { execute });
  return Object.assign(transactionDb, {
    transaction: vi.fn(async (write: (tx: typeof transactionDb) => Promise<unknown>) => write(transactionDb)),
  });
}

/** A settings row that concurrent transactions read and write, serialized like an advisory lock. */
function lockedSettingsStore(initial: Record<string, unknown>) {
  let stored: unknown = initial;
  let lock: Promise<void> = Promise.resolve();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const db = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            await tick();
            return [{ value: structuredClone(stored) }];
          },
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (row: { value: unknown }) => ({
        onConflictDoUpdate: async () => {
          await tick();
          stored = structuredClone(row.value);
        },
      }),
    })),
    transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await write(db);
      } finally {
        release();
      }
    }),
  };
  return { db, stored: () => stored as Record<string, any> };
}

describe('normalizePublicUrl', () => {
  it('stores only a canonical http(s) origin', () => {
    expect(normalizePublicUrl(' HTTPS://Gateway.Example.com:443/ ')).toBe('https://gateway.example.com');
    expect(normalizePublicUrl('http://[2001:db8::1]:3000')).toBe('http://[2001:db8::1]:3000');
  });

  it.each([
    'ftp://gateway.example.com',
    'https://user:pass@gateway.example.com',
    'https://gateway.example.com/app',
  ])('rejects a non-origin public URL: %s', (value) => expect(() => normalizePublicUrl(value)).toThrow());

  it('does not infer a public URL when it is blank', () => {
    expect(normalizePublicUrl('')).toBeNull();
  });
});

describe('GeneralSettingsService feature settings', () => {
  it('enables creator permissions by default and persists an explicit opt-out', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ value: {} }]) })) })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })) })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);
    expect((await service.getConfig()).autoAssignCreatedResourcePermissions).toBe(true);
    expect(
      (await service.updateConfig({ autoAssignCreatedResourcePermissions: false })).autoAssignCreatedResourcePermissions
    ).toBe(false);
    expect((await service.getConfig()).autoAssignCreatedResourcePermissions).toBe(false);
  });
  it('defaults unknown or missing update channels to stable and persists preview', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: { updateChannel: 'nightly' } }]);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);

    await expect(service.getConfig()).resolves.toMatchObject({ updateChannel: 'stable' });
    await expect(service.updateConfig({ updateChannel: 'preview' })).resolves.toMatchObject({
      updateChannel: 'preview',
    });
  });

  it('ignores the removed Gateway public IP field in persisted settings', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: { gatewayPublicIps: ['203.0.113.10'] } }]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);

    expect(await service.getConfig()).not.toHaveProperty('gatewayPublicIps');
  });

  it('uses a four-hour relay grant TTL and enforces the 1-48 hour range', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: {} }]);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);

    expect((await service.getConfig()).relayGrantTtlHours).toBe(4);
    expect((await service.getConfig()).hideExternalBranding).toBe(false);
    await expect(service.updateConfig({ hideExternalBranding: true })).resolves.toMatchObject({
      hideExternalBranding: true,
    });
    await expect(service.updateConfig({ relayGrantTtlHours: 1 })).resolves.toMatchObject({ relayGrantTtlHours: 1 });
    await expect(service.updateConfig({ relayGrantTtlHours: 48 })).resolves.toMatchObject({ relayGrantTtlHours: 48 });
    await expect(service.updateConfig({ relayGrantTtlHours: 0 })).rejects.toThrow();
    await expect(service.updateConfig({ relayGrantTtlHours: 49 })).rejects.toThrow();
  });

  it('backfills disabled and applies persisted updates without a restart', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        value: {
          features: { pkiEnabled: true, domainsEnabled: true },
        },
      },
    ]);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate })),
      })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);

    expect((await service.getConfig()).features.siemEnabled).toBe(true);
    expect((await service.getConfig()).features.inferenceEnabled).toBe(false);
    expect(
      (
        await service.updateConfig({
          features: { inferenceEnabled: true },
        })
      ).features.inferenceEnabled
    ).toBe(true);
    expect((await service.getConfig()).features.inferenceEnabled).toBe(true);
    expect((await service.updateConfig({ features: { siemEnabled: false } })).features.siemEnabled).toBe(false);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
  });

  it('invokes the assistant fallback when inference is turned off', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        value: {
          features: { pkiEnabled: true, domainsEnabled: true, inferenceEnabled: true },
        },
      },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);
    const fallback = vi.fn().mockResolvedValue(undefined);
    service.setInferenceDisabledHandler(fallback);

    await service.updateConfig({ features: { inferenceEnabled: false } });

    expect(fallback).toHaveBeenCalledOnce();
  });

  it('publishes a configuration invalidation without exposing settings data', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: { features: { pkiEnabled: true, domainsEnabled: true } } }]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    const eventBus = { publish: vi.fn() };
    const service = new GeneralSettingsService(transactional(db) as never, undefined, eventBus as never);

    await service.updateConfig({ features: { inferenceEnabled: true } });

    expect(eventBus.publish).toHaveBeenCalledWith('system.config.changed', {
      relayChanged: false,
      externalBrandingChanged: false,
    });
  });

  it('applies adaptive relay admission defaults and rejects an invalid database reserve window', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: {} }]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);

    expect((await service.getConfig()).relay).toMatchObject({
      assignmentSpread: { mode: 'fixed', count: 2 },
      adaptiveAdmissionEnabled: true,
      proxyTargetPressurePercent: 70,
      databaseReservePercent: 20,
      hardPressurePercent: 95,
    });
    await expect(
      service.updateConfig({
        relay: { proxyTargetPressurePercent: 80, databaseReservePercent: 15, hardPressurePercent: 95 },
      })
    ).rejects.toThrow('must remain below');
    await expect(service.updateConfig({ relay: { assignmentSpread: { mode: 'all' } } })).resolves.toMatchObject({
      relay: { assignmentSpread: { mode: 'all' } },
    });
    await expect(service.updateConfig({ relay: { assignmentSpread: { mode: 'fixed', count: 65 } } })).rejects.toThrow(
      'between 1 and 64'
    );
  });
});

describe('GeneralSettingsService concurrent writes', () => {
  it('keeps both fields when two saves run at the same time', async () => {
    const store = lockedSettingsStore({});
    const service = new GeneralSettingsService(store.db as never);

    await Promise.all([
      service.updateConfig({ hideExternalBranding: true }),
      service.updateConfig({ features: { siemEnabled: false } }),
    ]);

    expect(store.stored()).toMatchObject({ hideExternalBranding: true, features: { siemEnabled: false } });
    expect(store.db.execute).toHaveBeenCalledTimes(2);
    expect(await service.getConfig()).toMatchObject({
      hideExternalBranding: true,
      features: { siemEnabled: false },
    });
  });

  it('merges into the stored row, not a cached copy another writer replaced', async () => {
    const store = lockedSettingsStore({});
    const admin = new GeneralSettingsService(store.db as never);
    // The license reconciler and a CLI run their own writes against the same row.
    const reconciler = new GeneralSettingsService(store.db as never);
    expect((await admin.getConfig()).features.pkiEnabled).toBe(true);

    await reconciler.updateConfig({ features: { pkiEnabled: false } });
    await admin.updateConfig({ hideExternalBranding: true });

    expect(store.stored()).toMatchObject({ hideExternalBranding: true, features: { pkiEnabled: false } });
  });

  it('restores only the requested fields, and only while they hold the value that was written', async () => {
    const store = lockedSettingsStore({ publicUrl: 'https://old.example.com' });
    const service = new GeneralSettingsService(store.db as never);
    const previous = await service.getConfig();
    const written = await service.updateConfig({
      publicUrl: 'https://new.example.com',
      gatewayGrpcPublicTarget: 'grpc.new.example.com',
    });
    // Someone else changes an unrelated field and the gRPC target meanwhile.
    await new GeneralSettingsService(store.db as never).updateConfig({
      hideExternalBranding: true,
      gatewayGrpcPublicTarget: 'grpc.other.example.com',
    });

    await service.restoreFields(previous, ['publicUrl', 'gatewayGrpcPublicTarget'], { ifUnchangedFrom: written });

    expect(store.stored()).toMatchObject({
      publicUrl: 'https://old.example.com',
      gatewayGrpcPublicTarget: 'grpc.other.example.com',
      hideExternalBranding: true,
    });
  });
});

describe('graceful shutdown settings', () => {
  it('backfills defaults and merges a complete shutdown update', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: {} }]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    const service = new GeneralSettingsService(transactional(db) as never);

    expect((await service.getConfig()).shutdown).toEqual({
      userRequestDrainSeconds: 30,
      structuredLogDrainSeconds: 5,
      finalizationTimeoutSeconds: 10,
    });
    expect(
      (
        await service.updateConfig({
          shutdown: {
            userRequestDrainSeconds: 20,
            structuredLogDrainSeconds: 5,
            finalizationTimeoutSeconds: 10,
          },
        })
      ).shutdown
    ).toEqual({ userRequestDrainSeconds: 20, structuredLogDrainSeconds: 5, finalizationTimeoutSeconds: 10 });
  });

  it('rejects invalid ranges and totals', () => {
    expect(() =>
      normalizeShutdownSettings({
        userRequestDrainSeconds: 40,
        structuredLogDrainSeconds: 10,
        finalizationTimeoutSeconds: 15,
      })
    ).toThrow('must not exceed 50 seconds');
    expect(() =>
      normalizeShutdownSettings({
        userRequestDrainSeconds: 30,
        structuredLogDrainSeconds: 5,
        finalizationTimeoutSeconds: 4,
      })
    ).toThrow('between 5 and 15 seconds');
  });
});
