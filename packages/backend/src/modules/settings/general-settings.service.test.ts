import { describe, expect, it, vi } from 'vitest';
import { GeneralSettingsService, normalizePublicUrl, normalizeShutdownSettings } from './general-settings.service.js';

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
  it('uses a four-hour relay grant TTL and enforces the 1-48 hour range', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: {} }]);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    };
    const service = new GeneralSettingsService(db as never);

    expect((await service.getConfig()).relayGrantTtlHours).toBe(4);
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
    const service = new GeneralSettingsService(db as never);

    expect((await service.getConfig()).features.siemEnabled).toBe(true);
    expect((await service.getConfig()).features.inferenceEnabled).toBe(false);
    expect((await service.getConfig()).inference.harnessSpecificEndpointsEnabled).toBe(false);
    expect(
      (
        await service.updateConfig({
          features: { inferenceEnabled: true },
        })
      ).features.inferenceEnabled
    ).toBe(true);
    expect((await service.getConfig()).features.inferenceEnabled).toBe(true);
    expect((await service.updateConfig({ features: { siemEnabled: false } })).features.siemEnabled).toBe(false);
    expect(
      (
        await service.updateInferenceSettings({
          harnessSpecificEndpointsEnabled: true,
        })
      ).harnessSpecificEndpointsEnabled
    ).toBe(true);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(3);
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
    const service = new GeneralSettingsService(db as never);
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
    const service = new GeneralSettingsService(db as never, undefined, eventBus as never);

    await service.updateConfig({ features: { inferenceEnabled: true } });

    expect(eventBus.publish).toHaveBeenCalledWith('system.config.changed', { relayChanged: false });
  });

  it('applies adaptive relay admission defaults and rejects an invalid database reserve window', async () => {
    const limit = vi.fn().mockResolvedValue([{ value: {} }]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    const service = new GeneralSettingsService(db as never);

    expect((await service.getConfig()).relay).toMatchObject({
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
    const service = new GeneralSettingsService(db as never);

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
