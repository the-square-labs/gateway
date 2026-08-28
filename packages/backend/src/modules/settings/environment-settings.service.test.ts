import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENVIRONMENT_SETTINGS, EnvironmentSettingsService } from './environment-settings.service.js';

function database(value?: unknown) {
  const limit = vi.fn().mockResolvedValue(value === undefined ? [] : [{ value }]);
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    },
    limit,
    onConflictDoUpdate,
  };
}

describe('EnvironmentSettingsService', () => {
  it('backfills defaults and applies updates immediately', async () => {
    const { db, onConflictDoUpdate } = database({
      sessions: { expirySeconds: 3_600 },
      requestLimits: { inferenceHttpBodyMaxBytes: 64 * 1024 * 1024 },
    });
    const eventBus = { publish: vi.fn() };
    const service = new EnvironmentSettingsService(db as never, eventBus as never);

    await service.initialize();

    expect(service.getSnapshot()).toMatchObject({
      sessions: { expirySeconds: 3_600 },
      requestLimits: {
        inferenceHttpBodyMaxBytes: 64 * 1024 * 1024,
        inferenceWebSocketMaxPayloadBytes: 50 * 1024 * 1024,
      },
      rateLimits: DEFAULT_ENVIRONMENT_SETTINGS.rateLimits,
    });

    await service.update({
      sessions: { expirySeconds: 7_200 },
      requestLimits: { inferenceHttpBodyMaxBytes: 128 * 1024 * 1024 },
    });

    expect(service.getSnapshot().sessions.expirySeconds).toBe(7_200);
    expect(service.getSnapshot().requestLimits.inferenceHttpBodyMaxBytes).toBe(128 * 1024 * 1024);
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(eventBus.publish).toHaveBeenCalledWith('system.config.changed', { key: 'environment:settings' });
  });

  it('rejects unsafe limits and invalid PKI threshold ordering', async () => {
    const { db } = database();
    const service = new EnvironmentSettingsService(db as never);
    await service.initialize();

    await expect(
      service.update({ requestLimits: { inferenceWebSocketMaxPayloadBytes: 51 * 1024 * 1024 } })
    ).rejects.toThrow();
    await expect(service.update({ pkiDefaults: { expiryWarningDays: 7, expiryCriticalDays: 30 } })).rejects.toThrow(
      'Critical expiry threshold'
    );
    await expect(service.update({ rateLimits: { setupMaxRequests: 50 } } as never)).rejects.toThrow();
    expect(service.getSnapshot().rateLimits.setupMaxRequests).toBe(
      DEFAULT_ENVIRONMENT_SETTINGS.rateLimits.setupMaxRequests
    );
  });

  it('imports legacy values only when no persisted settings exist', async () => {
    const empty = database();
    const service = new EnvironmentSettingsService(empty.db as never);

    await expect(service.importLegacy({ sessions: { expirySeconds: 86_400 } })).resolves.toBe(true);
    expect(service.getSnapshot().sessions.expirySeconds).toBe(86_400);

    const existing = database({ sessions: { expirySeconds: 3_600 } });
    const existingService = new EnvironmentSettingsService(existing.db as never);
    await expect(existingService.importLegacy({ sessions: { expirySeconds: 86_400 } })).resolves.toBe(false);
  });
});
