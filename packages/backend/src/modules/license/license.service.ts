import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import {
  type CachedLicenseState,
  type EncryptedLicenseKey,
  LICENSE_OFFLINE_GRACE_DAYS,
  LICENSE_SERVER_URL,
  type LicenseServerResponse,
  type LicenseStatus,
  type LicenseStatusView,
  type LicenseTier,
} from './license.types.js';

const logger = createChildLogger('LicenseService');

const SETTINGS_KEYS = {
  installationId: 'license:installation_id',
  keyEncrypted: 'license:key_encrypted',
  cachedState: 'license:cached_state',
} as const;

type Fetcher = typeof fetch;

export class LicenseService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly env: Env,
    private readonly fetcher: Fetcher = fetch,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {}

  async getStatus(): Promise<LicenseStatusView> {
    const installationId = await this.getInstallationId();
    const encrypted = await this.getSetting<EncryptedLicenseKey | null>(SETTINGS_KEYS.keyEncrypted, null);
    const cached = await this.getCachedState();
    const installationName = this.getInstallationName();

    if (!encrypted) {
      return {
        status: 'community',
        tier: 'community',
        licensed: true,
        hasKey: false,
        keyLast4: null,
        licenseName: null,
        installationId,
        installationName,
        expiresAt: null,
        lastCheckedAt: null,
        lastValidAt: null,
        graceUntil: null,
        activeInstallationId: null,
        activeInstallationName: null,
        errorMessage: null,
        serverUrl: LICENSE_SERVER_URL,
      };
    }

    if (cached && !Object.hasOwn(cached, 'licenseName')) {
      return this.checkNow();
    }

    return this.toStatusView(cached, encrypted, installationId, installationName);
  }

  async activateKey(licenseKey: string): Promise<LicenseStatusView> {
    const key = licenseKey.trim();
    if (!key) {
      throw new Error('License key is required');
    }

    const response = await this.callLicenseServer('/api/v1/licenses/activate', key);
    if (response.status !== 'valid' || !response.tier) {
      const status = this.statusFromServer(response);
      return this.toStatusView(
        {
          status,
          tier: response.tier ?? null,
          licenseName: response.licenseName ?? null,
          expiresAt: response.expiresAt ?? null,
          lastCheckedAt: new Date().toISOString(),
          lastValidAt: null,
          activeInstallationId: response.activeInstallationId ?? null,
          activeInstallationName: response.activeInstallationName ?? null,
          errorMessage: response.message ?? status,
        },
        null,
        await this.getInstallationId(),
        this.getInstallationName()
      );
    }

    await this.setSetting(SETTINGS_KEYS.keyEncrypted, this.cryptoService.encryptString(key));
    await this.saveServerResponse(response, null);
    logger.info('License activated', { tier: response.tier });
    return this.getStatus();
  }

  async clearKey(): Promise<LicenseStatusView> {
    await this.deleteSetting(SETTINGS_KEYS.keyEncrypted);
    await this.deleteSetting(SETTINGS_KEYS.cachedState);
    logger.info('License key cleared');
    return this.getStatus();
  }

  async checkNow(): Promise<LicenseStatusView> {
    const encrypted = await this.getSetting<EncryptedLicenseKey | null>(SETTINGS_KEYS.keyEncrypted, null);
    if (!encrypted) return this.getStatus();

    let key: string;
    try {
      key = this.cryptoService.decryptString(encrypted);
    } catch {
      await this.saveCachedState({
        status: 'invalid',
        tier: null,
        licenseName: null,
        expiresAt: null,
        lastCheckedAt: new Date().toISOString(),
        lastValidAt: null,
        activeInstallationId: null,
        activeInstallationName: null,
        errorMessage: 'Stored license key cannot be decrypted',
      });
      return this.getStatus();
    }

    try {
      const response = await this.callLicenseServer('/api/v1/licenses/heartbeat', key);
      await this.saveServerResponse(response, null);
    } catch (error) {
      await this.markUnreachable(error);
    }

    return this.getStatus();
  }

  async heartbeat(): Promise<void> {
    const status = await this.checkNow();
    if (status.status !== 'community') {
      logger.debug('License heartbeat completed', { status: status.status, tier: status.tier });
    }
  }

  private async callLicenseServer(path: string, licenseKey: string): Promise<LicenseServerResponse> {
    const installationId = await this.getInstallationId();
    const response = await this.fetcher(`${LICENSE_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey,
        installationId,
        installationName: this.getInstallationName(),
        version: this.env.APP_VERSION,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`License server returned HTTP ${response.status}`);
    }
    return (await response.json()) as LicenseServerResponse;
  }

  private async saveServerResponse(response: LicenseServerResponse, fallbackError: string | null): Promise<void> {
    const now = new Date().toISOString();
    const status = this.statusFromServer(response);
    const tier = response.tier ?? null;
    await this.saveCachedState({
      status,
      tier,
      licenseName: response.licenseName ?? null,
      expiresAt: response.expiresAt ?? null,
      lastCheckedAt: now,
      lastValidAt: response.status === 'valid' ? now : ((await this.getCachedState())?.lastValidAt ?? null),
      activeInstallationId: response.activeInstallationId ?? null,
      activeInstallationName: response.activeInstallationName ?? null,
      errorMessage: response.status === 'valid' ? null : (response.message ?? fallbackError ?? status),
    });
  }

  private async markUnreachable(error: unknown): Promise<void> {
    const cached = await this.getCachedState();
    await this.saveCachedState({
      status: cached?.status ?? 'invalid',
      tier: cached?.tier ?? null,
      licenseName: cached?.licenseName ?? null,
      expiresAt: cached?.expiresAt ?? null,
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: cached?.lastValidAt ?? null,
      activeInstallationId: cached?.activeInstallationId ?? null,
      activeInstallationName: cached?.activeInstallationName ?? null,
      errorMessage: error instanceof Error ? error.message : 'License server unreachable',
    });
  }

  private toStatusView(
    cached: CachedLicenseState | null,
    encrypted: EncryptedLicenseKey | null,
    installationId: string,
    installationName: string
  ): LicenseStatusView {
    const lastValidAt = cached?.lastValidAt ?? null;
    const graceUntil = lastValidAt ? this.addGrace(lastValidAt).toISOString() : null;
    let status: LicenseStatus = cached?.status ?? 'invalid';
    let licensed = status === 'valid';

    if (cached?.status === 'valid' && cached.errorMessage && lastValidAt) {
      const grace = this.addGrace(lastValidAt);
      if (grace.getTime() > Date.now()) {
        status = 'valid_with_warning';
        licensed = true;
      } else {
        status = 'unreachable_grace_expired';
        licensed = false;
      }
    }

    return {
      status,
      tier: (cached?.tier ?? 'community') as LicenseTier,
      licensed,
      hasKey: !!encrypted,
      keyLast4: encrypted ? this.keyLast4(encrypted) : null,
      licenseName: cached?.licenseName ?? null,
      installationId,
      installationName,
      expiresAt: cached?.expiresAt ?? null,
      lastCheckedAt: cached?.lastCheckedAt ?? null,
      lastValidAt,
      graceUntil,
      activeInstallationId: cached?.activeInstallationId ?? null,
      activeInstallationName: cached?.activeInstallationName ?? null,
      errorMessage: cached?.errorMessage ?? null,
      serverUrl: LICENSE_SERVER_URL,
    };
  }

  private keyLast4(encrypted: EncryptedLicenseKey): string | null {
    try {
      return this.cryptoService.decryptString(encrypted).slice(-4);
    } catch {
      return null;
    }
  }

  private statusFromServer(
    response: LicenseServerResponse
  ): Exclude<LicenseStatus, 'community' | 'valid_with_warning' | 'unreachable_grace_expired'> {
    return response.status;
  }

  private addGrace(iso: string): Date {
    const date = new Date(iso);
    date.setUTCDate(date.getUTCDate() + LICENSE_OFFLINE_GRACE_DAYS);
    return date;
  }

  private getInstallationName(): string {
    try {
      const publicUrl = this.generalSettingsService?.getCachedPublicUrl() ?? this.env.APP_URL;
      return new URL(publicUrl).hostname || os.hostname();
    } catch {
      return os.hostname();
    }
  }

  /**
   * Return the stable local installation identifier without contacting the
   * license service. Non-licensing features may safely use it as a source
   * identity without changing entitlement or heartbeat behavior.
   */
  async getInstallationId(): Promise<string> {
    const existing = await this.getSetting<string | null>(SETTINGS_KEYS.installationId, null);
    if (existing) return existing;
    const created = randomUUID();
    await this.setSetting(SETTINGS_KEYS.installationId, created);
    return created;
  }

  private async getCachedState(): Promise<CachedLicenseState | null> {
    return this.getSetting<CachedLicenseState | null>(SETTINGS_KEYS.cachedState, null);
  }

  private async saveCachedState(state: CachedLicenseState): Promise<void> {
    await this.setSetting(SETTINGS_KEYS.cachedState, state);
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

  private async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}
