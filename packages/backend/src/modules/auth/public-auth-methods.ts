import { container } from '@/container.js';
import { AuthSettingsService } from './auth.settings.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';

export interface PublicAuthMethods {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
  passkeyLogin: boolean;
}

export async function getPublicAuthMethods(): Promise<PublicAuthMethods> {
  const [{ methods }, oidc] = await Promise.all([
    container.resolve(AuthSettingsService).getConfig(),
    container.resolve(OidcSettingsService).getPublicConfig(),
  ]);

  return {
    ...methods,
    oidc: methods.oidc && oidc.configured,
  };
}
