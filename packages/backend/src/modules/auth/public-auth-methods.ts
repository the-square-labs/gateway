import { container } from '@/container.js';
import { isDemoMode } from '@/modules/demo/demo-mode.js';
import { AuthSettingsService } from './auth.settings.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';

export interface PublicAuthMethods {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
  passkeyLogin: boolean;
  demoEmailOtp?: true;
}

export async function getPublicAuthMethods(): Promise<PublicAuthMethods> {
  if (isDemoMode()) {
    return { oidc: false, password: false, emailOtp: false, passkeyLogin: false, demoEmailOtp: true };
  }

  const [{ methods }, oidc] = await Promise.all([
    container.resolve(AuthSettingsService).getConfig(),
    container.resolve(OidcSettingsService).getPublicConfig(),
  ]);

  return {
    ...methods,
    oidc: methods.oidc && oidc.configured,
  };
}
