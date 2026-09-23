import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { CryptoService } from '@/services/crypto.service.js';

const OIDC_SETTING_KEY = 'auth:oidc';

interface EncryptedSecret {
  encryptedKey: string;
  encryptedDek: string;
}

interface StoredOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: EncryptedSecret;
  redirectUri: string;
  scopes: string;
}

export interface OidcConfigInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
}

export interface OidcRuntimeConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

export interface LegacyOidcEnvironment {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_SCOPES: string;
}

export interface OidcPublicConfig {
  configured: boolean;
  issuer: string | null;
  clientId: string | null;
  clientSecretLast4: string | null;
  redirectUri: string | null;
  scopes: string;
}

export class OidcSettingsService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async getRuntimeConfig(): Promise<OidcRuntimeConfig | null> {
    const stored = await this.getStoredConfig();
    if (!stored) return null;
    return { ...stored, clientSecret: this.cryptoService.decryptString(stored.clientSecret) };
  }

  async getPublicConfig(): Promise<OidcPublicConfig> {
    const runtime = await this.getRuntimeConfig();
    return runtime
      ? {
          configured: true,
          issuer: runtime.issuer,
          clientId: runtime.clientId,
          clientSecretLast4: runtime.clientSecret.slice(-4) || null,
          redirectUri: runtime.redirectUri,
          scopes: runtime.scopes,
        }
      : {
          configured: false,
          issuer: null,
          clientId: null,
          clientSecretLast4: null,
          redirectUri: null,
          scopes: 'openid email profile',
        };
  }

  async saveConfig(input: OidcConfigInput): Promise<OidcPublicConfig> {
    const previous = await this.getStoredConfig();
    const issuer = normalizeUrl(input.issuer, 'OIDC issuer');
    const redirectUri = normalizeUrl(input.redirectUri, 'OIDC redirect URI');
    const clientId = input.clientId.trim();
    const scopes = normalizeScopes(input.scopes);
    const clientSecret = input.clientSecret?.trim()
      ? this.cryptoService.encryptString(input.clientSecret.trim())
      : previous?.clientSecret;
    if (!clientId) throw new Error('OIDC client ID is required');
    if (!clientSecret) throw new Error('OIDC client secret is required');

    const stored: StoredOidcConfig = { issuer, clientId, clientSecret, redirectUri, scopes };
    await this.setStoredConfig(stored);
    return this.getPublicConfig();
  }

  async importLegacyEnv(env: LegacyOidcEnvironment): Promise<boolean> {
    if (await this.getStoredConfig()) return false;
    if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.OIDC_REDIRECT_URI) return false;
    await this.saveConfig({
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
      scopes: env.OIDC_SCOPES,
    });
    return true;
  }

  async snapshotConfig(): Promise<StoredOidcConfig | null> {
    return this.getStoredConfig();
  }

  async restoreConfig(snapshot: StoredOidcConfig | null): Promise<void> {
    if (snapshot) {
      await this.setStoredConfig(snapshot);
      return;
    }
    await this.db.delete(settings).where(eq(settings.key, OIDC_SETTING_KEY));
  }

  private async getStoredConfig(): Promise<StoredOidcConfig | null> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, OIDC_SETTING_KEY))
      .limit(1);
    return (row?.value as StoredOidcConfig | undefined) ?? null;
  }

  private async setStoredConfig(value: StoredOidcConfig): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: OIDC_SETTING_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

function normalizeUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} must use http or https`);
  return url.toString();
}

function normalizeScopes(value: string | undefined): string {
  const scopes = [
    ...new Set(
      (value ?? 'openid email profile')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
    ),
  ];
  if (!scopes.includes('openid')) throw new Error('OIDC scopes must include openid');
  return scopes.join(' ');
}
