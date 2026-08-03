import { describe, expect, it, vi } from 'vitest';
import { LoggingSettingsService } from './logging-settings.service.js';

function createHarness() {
  let stored: unknown;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => (stored ? [{ value: stored }] : [])) })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: { value: unknown }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          stored = row.value;
        }),
      })),
    })),
  } as any;
  const secrets = new Map<string, string>();
  const crypto = {
    encryptString: vi.fn((value: string) => {
      const encryptedKey = `ciphertext-${secrets.size + 1}`;
      secrets.set(encryptedKey, value);
      return { encryptedKey, encryptedDek: 'dek' };
    }),
    decryptString: vi.fn((value: { encryptedKey: string }) => secrets.get(value.encryptedKey) ?? ''),
  } as any;
  return { service: new LoggingSettingsService(db, crypto), getStored: () => stored };
}

describe('LoggingSettingsService', () => {
  it('creates managed-local credentials without persisting plaintext', async () => {
    const harness = createHarness();
    const runtime = await harness.service.saveConfig({ mode: 'local' });
    const publicConfig = await harness.service.getPublicConfig();

    expect(runtime).toMatchObject({
      mode: 'local',
      url: 'http://gateway-clickhouse:8123/',
      username: 'gateway',
      database: 'gateway_logs',
      table: 'logs',
    });
    expect(runtime.password.length).toBeGreaterThan(20);
    expect(JSON.stringify(harness.getStored())).not.toContain(runtime.password);
    expect(publicConfig.passwordLast4).toBe(runtime.password.slice(-4));
    expect(publicConfig).not.toHaveProperty('password', runtime.password);
  });

  it('preserves local credentials and data configuration while disabled', async () => {
    const harness = createHarness();
    const enabled = await harness.service.saveConfig({ mode: 'local' });
    await harness.service.saveConfig({ mode: 'disabled' });
    const reenabled = await harness.service.saveConfig({ mode: 'local' });

    expect(reenabled.password).toBe(enabled.password);
    expect(reenabled.url).toBe(enabled.url);
  });

  it('requires complete external connection settings', async () => {
    const harness = createHarness();
    await expect(
      harness.service.saveConfig({ mode: 'external', url: 'https://clickhouse.example.com:8443' })
    ).rejects.toThrow('username is required');
  });
});
