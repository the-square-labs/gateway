import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PasskeyService } from './passkey.service.js';

describe('PasskeyService MFA flows', () => {
  it('keeps account-bound passkey MFA available when direct passkey sign-in is disabled', async () => {
    const getConfig = vi.fn();
    const where = vi.fn().mockResolvedValue([]);
    const service = new PasskeyService(
      { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) } as never,
      {} as never,
      { getConfig } as never
    );

    await expect(service.beginAuthenticationForUser('user-1')).rejects.toMatchObject({
      code: 'PASSKEY_NOT_CONFIGURED',
    });
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('does not apply the direct sign-in setting while verifying an MFA passkey challenge', async () => {
    const getConfig = vi.fn();
    const service = new PasskeyService(
      {} as never,
      { get: vi.fn().mockResolvedValue(undefined) } as never,
      { getConfig } as never
    );

    await expect(
      service.verifyAuthentication('challenge', { id: 'credential' } as never, 'user-1', false)
    ).resolves.toBeNull();
    expect(getConfig).not.toHaveBeenCalled();
  });
});
