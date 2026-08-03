import { describe, expect, it, vi } from 'vitest';
import { OidcSettingsService } from './oidc-settings.service.js';

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
  return { service: new OidcSettingsService(db, crypto), getStored: () => stored };
}

describe('OidcSettingsService', () => {
  it('persists the client secret encrypted and returns only a redacted public view', async () => {
    const harness = createHarness();
    const publicConfig = await harness.service.saveConfig({
      issuer: 'https://id.example.com/application/o/gateway',
      clientId: 'gateway',
      clientSecret: 'super-secret',
      redirectUri: 'https://gateway.example.com/auth/callback',
      scopes: 'openid profile email email',
    });

    expect(JSON.stringify(harness.getStored())).not.toContain('super-secret');
    expect(publicConfig).toMatchObject({
      configured: true,
      issuer: 'https://id.example.com/application/o/gateway',
      clientId: 'gateway',
      clientSecretLast4: 'cret',
      scopes: 'openid profile email',
    });
    expect(publicConfig).not.toHaveProperty('clientSecret');
  });

  it('keeps the existing encrypted secret when the settings UI leaves it blank', async () => {
    const harness = createHarness();
    await harness.service.saveConfig({
      issuer: 'https://id.example.com',
      clientId: 'gateway',
      clientSecret: 'first-secret',
      redirectUri: 'https://gateway.example.com/auth/callback',
    });
    await harness.service.saveConfig({
      issuer: 'https://id2.example.com',
      clientId: 'gateway-2',
      redirectUri: 'https://gateway.example.com/auth/callback',
    });

    await expect(harness.service.getRuntimeConfig()).resolves.toMatchObject({ clientSecret: 'first-secret' });
  });
});
