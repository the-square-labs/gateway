import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CryptoService } from '@/services/crypto.service.js';
import { InferenceCredentialVault } from './inference-credential-vault.js';

describe('InferenceCredentialVault', () => {
  it('round-trips provider credentials without retaining plaintext', () => {
    const vault = new InferenceCredentialVault(new CryptoService('ab'.repeat(32)));
    const payload = { accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token' };

    const sealed = vault.seal(payload);

    expect(sealed.keyVersion).toBe(1);
    expect(JSON.stringify(sealed)).not.toContain(payload.accessToken);
    expect(JSON.stringify(sealed)).not.toContain(payload.refreshToken);
    expect(vault.open(sealed)).toEqual(payload);
  });
});
