import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuthSettingsService } from './auth.settings.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';

const demoState = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/modules/demo/demo-mode.js', () => ({
  isDemoMode: () => demoState.enabled,
}));

import { getPublicAuthMethods } from './public-auth-methods.js';

afterEach(() => {
  demoState.enabled = false;
  container.reset();
});

describe('getPublicAuthMethods', () => {
  it('exposes only the dedicated demo login and does not read ordinary auth settings', async () => {
    demoState.enabled = true;
    const getConfig = vi.fn();
    const getPublicConfig = vi.fn();
    container.registerInstance(AuthSettingsService, { getConfig } as never);
    container.registerInstance(OidcSettingsService, { getPublicConfig } as never);

    await expect(getPublicAuthMethods()).resolves.toEqual({
      oidc: false,
      password: false,
      emailOtp: false,
      passkeyLogin: false,
      demoEmailOtp: true,
    });
    expect(getConfig).not.toHaveBeenCalled();
    expect(getPublicConfig).not.toHaveBeenCalled();
  });

  it('keeps the standard auth method contract unchanged', async () => {
    const getConfig = vi.fn().mockResolvedValue({
      methods: { oidc: true, password: true, emailOtp: true, passkeyLogin: true },
    });
    const getPublicConfig = vi.fn().mockResolvedValue({ configured: true });
    container.registerInstance(AuthSettingsService, { getConfig } as never);
    container.registerInstance(OidcSettingsService, { getPublicConfig } as never);

    await expect(getPublicAuthMethods()).resolves.toEqual({
      oidc: true,
      password: true,
      emailOtp: true,
      passkeyLogin: true,
    });
  });
});
