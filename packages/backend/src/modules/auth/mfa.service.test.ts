import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { userPasskeys, userRecoveryCodes, userTotpFactors } from '@/db/schema/index.js';
import { MfaService } from './mfa.service.js';

describe('MfaService.resetTotp', () => {
  it('removes only TOTP and recovery codes, leaving passkeys intact', async () => {
    const where = vi.fn();
    const db = { delete: vi.fn(() => ({ where })) };
    const cache = { delete: vi.fn() };
    const service = new MfaService(db as never, cache as never, {} as never);

    await service.resetTotp('user-1');

    expect(db.delete).toHaveBeenNthCalledWith(1, userTotpFactors);
    expect(db.delete).toHaveBeenNthCalledWith(2, userRecoveryCodes);
    expect(db.delete).not.toHaveBeenCalledWith(userPasskeys);
    expect(cache.delete).toHaveBeenCalledWith('mfa:totp:setup:user-1');
  });
});

describe('MfaService.requiresLocalMfa', () => {
  it('requires MFA whenever a local factor is configured, independent of group policy', async () => {
    const service = new MfaService({} as never, {} as never, {} as never);
    vi.spyOn(service, 'getStatus').mockResolvedValue({
      totpConfigured: false,
      passkeyCount: 1,
      recoveryCodeCount: 0,
    });
    const groupPolicy = vi.spyOn(service, 'isGatewayMfaRequired').mockResolvedValue(false);

    await expect(service.requiresLocalMfa('user-1')).resolves.toBe(true);
    expect(groupPolicy).not.toHaveBeenCalled();
  });
});
