import { count, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, settings, type UserAuthMethod, userPasskeys, users } from '@/db/schema/index.js';
import type { CryptoService } from '@/services/crypto.service.js';

const AUTH_SETTINGS_DEFAULTS = {
  'auth:oidc_auto_create_users': true,
  'auth:oidc_require_verified_email': false,
  'auth:oauth_extended_callback_compatibility': false,
  'auth:methods': { oidc: true, password: false, emailOtp: false, passkeyLogin: false },
  'auth:password_policy': {
    minLength: 12,
    maxLength: 72,
    requireUppercase: false,
    requireLowercase: false,
    requireDigit: false,
    requireSymbol: false,
  },
} as const;

export interface LocalAuthMethods {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
  passkeyLogin: boolean;
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export interface OidcPublicConfig {
  configured: boolean;
  issuer: string | null;
  clientId: string | null;
  redirectUri: string | null;
  scopes: string | null;
}

export interface OidcConfigInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

interface StoredOidcConfig extends Omit<OidcConfig, 'clientSecret'> {
  clientSecret: { encryptedKey: string; encryptedDek: string };
}

const OIDC_SETTING_KEY = 'auth:oidc';

export interface AuthProvisioningSettings {
  oidcAutoCreateUsers: boolean;
  oidcDefaultGroupId: string;
  oidcRequireVerifiedEmail: boolean;
  oauthExtendedCallbackCompatibility: boolean;
  methods: LocalAuthMethods;
  passwordPolicy: PasswordPolicy;
  oidc: OidcPublicConfig;
}

export class AuthSettingsService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService?: CryptoService
  ) {}

  async getConfig(): Promise<AuthProvisioningSettings> {
    const autoCreateUsers = await this.getSetting<boolean>(
      'auth:oidc_auto_create_users',
      AUTH_SETTINGS_DEFAULTS['auth:oidc_auto_create_users']
    );

    const defaultGroupId = await this.resolveDefaultGroupId();
    const requireVerifiedEmail = await this.getSetting<boolean>(
      'auth:oidc_require_verified_email',
      AUTH_SETTINGS_DEFAULTS['auth:oidc_require_verified_email']
    );
    const oauthExtendedCallbackCompatibility = await this.getSetting<boolean>(
      'auth:oauth_extended_callback_compatibility',
      AUTH_SETTINGS_DEFAULTS['auth:oauth_extended_callback_compatibility']
    );
    const methods = await this.getSetting<LocalAuthMethods>('auth:methods', AUTH_SETTINGS_DEFAULTS['auth:methods']);
    const [passwordPolicy, oidc] = await Promise.all([
      this.getSetting<PasswordPolicy>('auth:password_policy', AUTH_SETTINGS_DEFAULTS['auth:password_policy']),
      this.getOidcPublicConfig(),
    ]);

    return {
      oidcAutoCreateUsers: autoCreateUsers,
      oidcDefaultGroupId: defaultGroupId,
      oidcRequireVerifiedEmail: requireVerifiedEmail,
      oauthExtendedCallbackCompatibility,
      methods,
      passwordPolicy,
      oidc,
    };
  }

  async updateConfig(updates: {
    oidcAutoCreateUsers?: boolean;
    oidcDefaultGroupId?: string;
    oidcRequireVerifiedEmail?: boolean;
    oauthExtendedCallbackCompatibility?: boolean;
    methods?: Partial<LocalAuthMethods>;
    passwordPolicy?: Partial<PasswordPolicy>;
    oidc?: OidcConfigInput;
  }): Promise<AuthProvisioningSettings> {
    if (updates.oidcAutoCreateUsers !== undefined) {
      await this.setSetting('auth:oidc_auto_create_users', updates.oidcAutoCreateUsers);
    }

    if (updates.oidcRequireVerifiedEmail !== undefined) {
      await this.setSetting('auth:oidc_require_verified_email', updates.oidcRequireVerifiedEmail);
    }

    if (updates.oauthExtendedCallbackCompatibility !== undefined) {
      await this.setSetting('auth:oauth_extended_callback_compatibility', updates.oauthExtendedCallbackCompatibility);
    }

    if (updates.methods !== undefined) {
      const current = await this.getSetting<LocalAuthMethods>('auth:methods', AUTH_SETTINGS_DEFAULTS['auth:methods']);
      const next = { ...current, ...updates.methods };
      if (!next.oidc && !next.password && !next.emailOtp) {
        throw new Error('At least one primary authentication method must remain enabled');
      }
      for (const [method, enabled] of Object.entries(updates.methods)) {
        if (enabled !== false) continue;
        if (method === 'passkeyLogin') {
          const [{ count: passkeyCount }] = await this.db.select({ count: count() }).from(userPasskeys);
          if (Number(passkeyCount) > 0) throw new Error('Cannot disable passkey login while users exist');
          continue;
        }
        const authMethod: UserAuthMethod = method === 'emailOtp' ? 'email_otp' : (method as UserAuthMethod);
        const [{ count: userCount }] = await this.db
          .select({ count: count() })
          .from(users)
          .where(eq(users.authMethod, authMethod));
        if (Number(userCount) > 0) throw new Error(`Cannot disable ${method} while users are assigned to it`);
      }
      await this.setSetting('auth:methods', next);
    }

    if (updates.passwordPolicy !== undefined) {
      const current = await this.getSetting<PasswordPolicy>(
        'auth:password_policy',
        AUTH_SETTINGS_DEFAULTS['auth:password_policy']
      );
      const next = { ...current, ...updates.passwordPolicy };
      if (
        !Number.isInteger(next.minLength) ||
        !Number.isInteger(next.maxLength) ||
        next.minLength < 8 ||
        next.maxLength > 72 ||
        next.minLength > next.maxLength
      ) {
        throw new Error('Password policy must use a minimum of 8 and a maximum of 72 bytes');
      }
      await this.setSetting('auth:password_policy', next);
    }

    if (updates.oidc !== undefined) {
      await this.saveOidcConfig(updates.oidc);
    }

    if (updates.oidcDefaultGroupId !== undefined) {
      const group = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.id, updates.oidcDefaultGroupId),
      });
      if (!group) {
        throw new Error('Permission group not found');
      }
      await this.setSetting('auth:oidc_default_group_id', group.id);
    }

    return this.getConfig();
  }

  async getOAuthExtendedCallbackCompatibility(): Promise<boolean> {
    return this.getSetting<boolean>(
      'auth:oauth_extended_callback_compatibility',
      AUTH_SETTINGS_DEFAULTS['auth:oauth_extended_callback_compatibility']
    );
  }

  async getOidcPublicConfig(): Promise<OidcPublicConfig> {
    const config = await this.getStoredOidcConfigWithLegacyMigration();
    if (!config) {
      return { configured: false, issuer: null, clientId: null, redirectUri: null, scopes: null };
    }
    return {
      configured: true,
      issuer: config.issuer,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
    };
  }

  async getOidcConfig(): Promise<OidcConfig | null> {
    const config = await this.getStoredOidcConfigWithLegacyMigration();
    if (!config) return null;
    return {
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: this.requireCrypto().decryptString(config.clientSecret),
      redirectUri: config.redirectUri,
      scopes: config.scopes,
    };
  }

  async saveOidcConfig(input: OidcConfigInput): Promise<OidcPublicConfig> {
    const issuer = input.issuer.trim();
    const clientId = input.clientId.trim();
    const redirectUri = input.redirectUri.trim();
    const scopes = input.scopes?.trim() || 'openid email profile';
    if (!isHttpUrl(issuer) || !isHttpUrl(redirectUri) || !clientId) {
      throw new Error('OIDC issuer, client ID, and redirect URI are required');
    }

    const existing = await this.getStoredOidcConfig();
    const clientSecret = input.clientSecret?.trim()
      ? this.requireCrypto().encryptString(input.clientSecret)
      : existing?.clientSecret;
    if (!clientSecret) throw new Error('OIDC client secret is required');

    await this.setSetting(OIDC_SETTING_KEY, { issuer, clientId, redirectUri, scopes, clientSecret } satisfies StoredOidcConfig);
    return this.getOidcPublicConfig();
  }

  private async getStoredOidcConfigWithLegacyMigration(): Promise<StoredOidcConfig | null> {
    const stored = await this.getStoredOidcConfig();
    if (stored) return stored;

    const issuer = process.env.OIDC_ISSUER?.trim();
    const clientId = process.env.OIDC_CLIENT_ID?.trim();
    const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
    const redirectUri = process.env.OIDC_REDIRECT_URI?.trim();
    if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
    await this.saveOidcConfig({
      issuer,
      clientId,
      clientSecret,
      redirectUri,
      scopes: process.env.OIDC_SCOPES,
    });
    return this.getStoredOidcConfig();
  }

  private async getStoredOidcConfig(): Promise<StoredOidcConfig | null> {
    return this.getSetting<StoredOidcConfig | null>(OIDC_SETTING_KEY, null);
  }

  private requireCrypto(): CryptoService {
    if (!this.cryptoService) throw new Error('Crypto service is required for OIDC configuration');
    return this.cryptoService;
  }

  async resolveDefaultGroupId(): Promise<string> {
    const stored = await this.getSetting<string | null>('auth:oidc_default_group_id', null);
    if (stored) {
      const existing = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.id, stored),
      });
      if (existing) return existing.id;
    }

    const viewerGroup = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, 'viewer'),
    });
    if (!viewerGroup) {
      throw new Error('Built-in group "viewer" not found. Has the migration been run?');
    }

    await this.setSetting('auth:oidc_default_group_id', viewerGroup.id);
    return viewerGroup.id;
  }

  private async getSetting<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return (row?.value !== undefined ? row.value : fallback) as T;
  }

  private async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
