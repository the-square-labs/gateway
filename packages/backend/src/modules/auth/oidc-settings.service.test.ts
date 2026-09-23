import { describe, expect, it, vi } from 'vitest';
import { OidcSettingsService } from './oidc-settings.service.js';

function createService(previousIssuer: string) {
  const previous = {
    issuer: previousIssuer,
    clientId: 'gateway',
    clientSecret: { encryptedKey: 'key', encryptedDek: 'dek' },
    redirectUri: 'https://gateway.example.com/auth/callback',
    scopes: 'openid email profile',
  };
  const updateSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([{ value: previous }]) }) }),
    })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }) })),
    update: vi.fn(() => ({ set: updateSet })),
  };
  const crypto = { encryptString: vi.fn(), decryptString: vi.fn().mockReturnValue('secret-1234') };
  return { service: new OidcSettingsService(db as never, crypto as never), updateSet };
}

const input = {
  clientId: 'gateway',
  redirectUri: 'https://gateway.example.com/auth/callback',
};

describe('OidcSettingsService issuer changes', () => {
  it('does not rewrite account issuers when the configured issuer changes', async () => {
    // Accounts are bound to the `iss` their provider reports at login. Some
    // providers (Entra ID, B2C) report an issuer that differs from the
    // configured URL, so pinning accounts to the configured URL locks them out.
    const { service, updateSet } = createService('https://login.microsoftonline.com/common/v2.0');

    await service.saveConfig({ ...input, issuer: 'https://new-idp.example.com' });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it('leaves accounts alone when the issuer is unchanged', async () => {
    const { service, updateSet } = createService('https://idp.example.com/');

    await service.saveConfig({ ...input, issuer: 'https://idp.example.com' });

    expect(updateSet).not.toHaveBeenCalled();
  });
});
