import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  type CachedLicenseState,
  COMMUNITY_ENTITLEMENTS,
  type EncryptedLicenseCredential,
  isCanonicalEntitlements,
  LICENSE_COMMUNITY_HEARTBEAT_INTERVAL_MS,
  LICENSE_ENTITLEMENTS_VERSION,
  LICENSE_OFFLINE_GRACE_DAYS,
  LICENSE_PAID_HEARTBEAT_INTERVAL_MS,
  LICENSE_SERVER_URL,
  type LicensePlan,
  type LicenseServerEnvelope,
  type LicenseServerErrorEnvelope,
  type LicenseServerRegistration,
  type LicenseServerState,
  type LicenseStatus,
  type LicenseStatusView,
} from './license.types.js';

const logger = createChildLogger('LicenseService');

const SETTINGS_KEYS = {
  installationId: 'license:installation_id',
  registrationNonceEncrypted: 'license:registration_nonce_encrypted',
  installationTokenEncrypted: 'license:installation_token_encrypted',
  keyEncrypted: 'license:key_encrypted',
  cachedState: 'license:cached_state',
  onboardingCompleted: 'license:onboarding_completed',
} as const;

type Fetcher = typeof fetch;

interface RegistrationCredential {
  token: string;
  newlyRegistered: boolean;
}

export class LicenseServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'LicenseServerRequestError';
  }
}

export class LicenseService {
  private registrationPromise: Promise<RegistrationCredential> | null = null;
  private installationIdPromise: Promise<string> | null = null;
  private syncQueue: Promise<void> = Promise.resolve();
  private lastPublishedStatus: string | null = null;
  private lifecycleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly env: Env,
    private readonly fetcher: Fetcher = fetch,
    private readonly generalSettingsService?: GeneralSettingsService,
    private readonly eventBus?: EventBusService
  ) {}

  async getStatus(): Promise<LicenseStatusView> {
    const [installationId, encryptedKey, encryptedToken, cached] = await Promise.all([
      this.getInstallationId(),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.installationTokenEncrypted, null),
      this.getCachedState(),
    ]);
    const registrationStatus = encryptedToken ? 'registered' : (cached?.registrationStatus ?? 'pending');
    const effectiveCached = cached ? { ...cached, registrationStatus } : this.communityState(registrationStatus);
    const status = this.toStatusView(effectiveCached, encryptedKey, installationId, this.getInstallationName());
    this.scheduleLifecycleRefresh(status, effectiveCached);
    this.publishStatusIfChanged(status);
    return status;
  }

  async getOnboardingState(): Promise<{ completed: boolean; status: LicenseStatusView }> {
    const completed = await this.getSetting<boolean | string>(SETTINGS_KEYS.onboardingCompleted, false);
    return {
      completed: completed === true || completed === 'true',
      status: await this.getStatus(),
    };
  }

  async continueWithCommunity(): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.continueWithCommunityNow());
  }

  private async continueWithCommunityNow(): Promise<LicenseStatusView> {
    await this.ensureRegistered(false);
    await this.setSetting(SETTINGS_KEYS.onboardingCompleted, true);
    return this.getStatus();
  }

  async activateKey(licenseKey: string): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.activateKeyNow(licenseKey));
  }

  private async activateKeyNow(licenseKey: string): Promise<LicenseStatusView> {
    const key = licenseKey.trim();
    if (!key) throw new Error('License key is required');

    const credential = await this.ensureRegistered(true);
    if (!credential) throw new Error('Installation registration is required');
    const state = await this.post<LicenseServerState>('/api/v1/licenses/activate', {
      installationToken: credential.token,
      licenseKey: key,
    });
    this.assertServerState(state);
    if (state.effectivePlan === 'community' || state.paidLicenseStatus !== 'valid') {
      throw new LicenseServerRequestError(409, 'LICENSE_NOT_ACTIVE', 'License server did not activate the paid plan');
    }

    await this.setSetting(SETTINGS_KEYS.keyEncrypted, this.cryptoService.encryptString(key));
    await this.saveServerState(state);
    await this.setSetting(SETTINGS_KEYS.onboardingCompleted, true);
    logger.info('License activated', { plan: state.effectivePlan });
    return this.getStatus();
  }

  async clearKey(): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.clearKeyNow());
  }

  private async clearKeyNow(): Promise<LicenseStatusView> {
    const credential = await this.ensureRegistered(true);
    if (!credential) throw new Error('Installation registration is required');
    const state = await this.post<LicenseServerState>('/api/v1/licenses/deactivate', {
      installationToken: credential.token,
    });
    this.assertServerState(state);
    await this.saveServerState(state);
    await this.deleteSetting(SETTINGS_KEYS.keyEncrypted);
    logger.info('License deactivated');
    return this.getStatus();
  }

  async checkNow(): Promise<LicenseStatusView> {
    return this.runSerialized(() => this.checkNowUnlocked());
  }

  private async checkNowUnlocked(): Promise<LicenseStatusView> {
    const [legacyCached, encryptedKey, encryptedToken] = await Promise.all([
      this.getSetting<Record<string, unknown> | null>(SETTINGS_KEYS.cachedState, null),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.installationTokenEncrypted, null),
    ]);
    const legacyNeedsActivation =
      Boolean(encryptedKey) && Boolean(legacyCached) && !Object.hasOwn(legacyCached!, 'registrationStatus');

    let credential: RegistrationCredential | null;
    try {
      credential = await this.ensureRegistered(false);
    } catch {
      credential = null;
    }
    if (!credential) return this.getStatus();

    if (legacyNeedsActivation && !encryptedToken && credential.newlyRegistered && encryptedKey) {
      try {
        const key = this.cryptoService.decryptString(encryptedKey);
        const state = await this.post<LicenseServerState>('/api/v1/licenses/activate', {
          installationToken: credential.token,
          licenseKey: key,
        });
        await this.saveServerState(state);
      } catch (error) {
        if (error instanceof LicenseServerRequestError) {
          await this.saveLegacyActivationFailure(error);
        } else {
          await this.markUnreachable(error);
        }
      }
      return this.getStatus();
    }

    if (credential.newlyRegistered) return this.getStatus();

    try {
      const state = await this.post<LicenseServerState>('/api/v1/installations/heartbeat', {
        installationToken: credential.token,
        installationName: this.getInstallationName(),
        gatewayVersion: this.env.APP_VERSION,
      });
      await this.saveServerState(state);
    } catch (error) {
      if (error instanceof LicenseServerRequestError && error.code === 'INVALID_INSTALLATION_TOKEN') {
        await this.deleteSetting(SETTINGS_KEYS.installationTokenEncrypted);
        const replacement = await this.ensureRegistered(false);
        if (replacement) return this.getStatus();
      }
      await this.markUnreachable(error);
    }
    return this.getStatus();
  }

  async heartbeat(): Promise<void> {
    await this.runSerialized(() => this.heartbeatUnlocked());
  }

  private async heartbeatUnlocked(): Promise<void> {
    const [cached, encryptedKey] = await Promise.all([
      this.getCachedState(),
      this.getSetting<EncryptedLicenseCredential | null>(SETTINGS_KEYS.keyEncrypted, null),
    ]);
    const interval =
      encryptedKey || (cached?.plan && cached.plan !== 'community')
        ? LICENSE_PAID_HEARTBEAT_INTERVAL_MS
        : LICENSE_COMMUNITY_HEARTBEAT_INTERVAL_MS;
    const lastCheckedAt = cached?.lastCheckedAt ? Date.parse(cached.lastCheckedAt) : 0;
    if (lastCheckedAt && Date.now() - lastCheckedAt < interval) return;

    const status = await this.checkNowUnlocked();
    logger.debug('License heartbeat completed', {
      status: status.status,
      plan: status.plan,
      registrationStatus: status.registrationStatus,
    });
  }

  private async ensureRegistered(strict: boolean): Promise<RegistrationCredential | null> {
    const token = await this.readInstallationToken();
    if (token) return { token, newlyRegistered: false };

    if (!this.registrationPromise) {
      this.registrationPromise = this.registerInstallation().finally(() => {
        this.registrationPromise = null;
      });
    }
    try {
      return await this.registrationPromise;
    } catch (error) {
      await this.markRegistrationPending(error);
      if (strict) throw error;
      return null;
    }
  }

  private async runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.syncQueue.then(task, task);
    this.syncQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async registerInstallation(): Promise<RegistrationCredential> {
    const nonce = await this.getOrCreateRegistrationNonce();
    const result = await this.post<LicenseServerRegistration>('/api/v1/installations/register', {
      installationId: await this.getInstallationId(),
      registrationNonce: nonce,
      installationName: this.getInstallationName(),
      gatewayVersion: this.env.APP_VERSION,
    });
    if (!result || typeof result.installationToken !== 'string' || !result.installationToken.trim()) {
      throw new LicenseServerRequestError(502, 'INVALID_LICENSE_STATE', 'License server returned an invalid state');
    }
    this.assertServerState(result.state);
    await this.setSetting(
      SETTINGS_KEYS.installationTokenEncrypted,
      this.cryptoService.encryptString(result.installationToken)
    );
    await this.saveServerState(result.state);
    logger.info('Community installation registered');
    return { token: result.installationToken, newlyRegistered: true };
  }

  private async readInstallationToken(): Promise<string | null> {
    const encrypted = await this.getSetting<EncryptedLicenseCredential | null>(
      SETTINGS_KEYS.installationTokenEncrypted,
      null
    );
    if (!encrypted) return null;
    try {
      const token = this.cryptoService.decryptString(encrypted).trim();
      if (token) return token;
    } catch {
      // Re-register with the existing nonce when a stored token is unreadable.
    }
    await this.deleteSetting(SETTINGS_KEYS.installationTokenEncrypted);
    return null;
  }

  private async getOrCreateRegistrationNonce(): Promise<string> {
    const encrypted = await this.getSetting<EncryptedLicenseCredential | null>(
      SETTINGS_KEYS.registrationNonceEncrypted,
      null
    );
    if (encrypted) {
      try {
        const nonce = this.cryptoService.decryptString(encrypted).trim();
        if (nonce) return nonce;
      } catch {
        throw new Error('Stored license registration nonce cannot be decrypted');
      }
    }
    const nonce = randomBytes(32).toString('base64url');
    await this.setSetting(SETTINGS_KEYS.registrationNonceEncrypted, this.cryptoService.encryptString(nonce));
    return nonce;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${LICENSE_SERVER_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new LicenseServerRequestError(503, 'LICENSE_SERVER_UNAVAILABLE', 'License server is unavailable');
    }
    const payload = (await response.json().catch(() => null)) as
      | LicenseServerEnvelope<T>
      | LicenseServerErrorEnvelope
      | null;
    if (!response.ok) {
      const serverError = payload && 'error' in payload ? payload.error : null;
      throw new LicenseServerRequestError(
        response.status,
        serverError?.code ?? 'LICENSE_SERVER_ERROR',
        serverError?.message ?? `License server returned HTTP ${response.status}`,
        serverError?.details
      );
    }
    if (!payload || !('data' in payload)) {
      throw new Error('License server returned an invalid response');
    }
    return payload.data;
  }

  private async saveServerState(state: LicenseServerState): Promise<void> {
    this.assertServerState(state);
    const previous = await this.getCachedState();
    const now = new Date().toISOString();
    const status = this.statusFromState(state);
    await this.saveCachedState({
      registrationStatus: 'registered',
      status,
      plan: state.effectivePlan,
      paidPlan: state.paidLicense?.plan ?? null,
      paidLicenseStatus: state.paidLicenseStatus,
      licenseName: state.paidLicense?.name ?? null,
      licenseMetadata: state.paidLicense?.metadata ?? {},
      expiresAt: state.paidLicense?.expiresAt ?? null,
      graceUntil: state.graceUntil,
      entitlementsVersion: state.entitlementsVersion,
      entitlements: state.entitlements,
      lastCheckedAt: now,
      lastValidAt: status === 'valid' || status === 'expired_grace' ? now : (previous?.lastValidAt ?? null),
      activeInstallationId: state.activation?.installationId ?? null,
      activeInstallationName: state.activation?.installationName ?? null,
      errorMessage:
        status === 'valid' || status === 'expired_grace' || status === 'community' ? null : state.paidLicenseStatus,
    });
  }

  private async saveLegacyActivationFailure(error: LicenseServerRequestError): Promise<void> {
    const statusByCode: Record<string, LicenseStatus> = {
      LICENSE_EXPIRED: 'expired',
      LICENSE_REVOKED: 'revoked',
      LICENSE_IN_USE: 'invalid',
      LICENSE_NOT_FOUND: 'invalid',
    };
    const previous = await this.getCachedState();
    await this.saveCachedState({
      ...this.communityState('registered'),
      status: statusByCode[error.code] ?? 'invalid',
      paidLicenseStatus: error.code.toLowerCase(),
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: previous?.lastValidAt ?? null,
      errorMessage: error.message,
    });
  }

  private async markRegistrationPending(error: unknown): Promise<void> {
    const cached = await this.getCachedState();
    await this.saveCachedState({
      ...(cached ?? this.communityState('pending')),
      registrationStatus: 'pending',
      lastCheckedAt: new Date().toISOString(),
      errorMessage: this.errorMessage(error),
    });
  }

  private async markUnreachable(error: unknown): Promise<void> {
    const cached = await this.getCachedState();
    await this.saveCachedState({
      ...(cached ?? this.communityState('pending')),
      lastCheckedAt: new Date().toISOString(),
      errorMessage: this.errorMessage(error),
    });
  }

  private toStatusView(
    cached: CachedLicenseState,
    encrypted: EncryptedLicenseCredential | null,
    installationId: string,
    installationName: string
  ): LicenseStatusView {
    const lastValidAt = cached.lastValidAt;
    const now = Date.now();
    const expiryAt = cached.expiresAt ? Date.parse(cached.expiresAt) : Number.NaN;
    const expirationGraceUntil = this.resolveExpirationGraceUntil(cached);
    const expirationGraceDeadline = expirationGraceUntil?.getTime() ?? Number.NaN;
    const offlineGraceUntil = cached.paidPlan && lastValidAt ? this.addOfflineGrace(lastValidAt) : null;
    let status = cached.status;
    let plan = cached.plan;
    let entitlements = cached.entitlements;
    let licensed = status === 'community' || status === 'valid' || status === 'expired_grace';
    const authoritativeLoss = ['revoked', 'replaced', 'deactivated', 'invalid'].includes(cached.status);

    if (!authoritativeLoss && cached.paidPlan && Number.isFinite(expiryAt) && now >= expiryAt) {
      if (Number.isFinite(expirationGraceDeadline) && now < expirationGraceDeadline) {
        status = 'expired_grace';
        plan = cached.paidPlan;
        licensed = true;
      } else {
        status = 'expired';
        plan = 'community';
        entitlements = COMMUNITY_ENTITLEMENTS;
        licensed = false;
      }
    }

    if (!authoritativeLoss && cached.paidPlan && cached.errorMessage && offlineGraceUntil) {
      const offlineDeadline = Math.min(
        offlineGraceUntil.getTime(),
        Number.isFinite(expirationGraceDeadline) ? expirationGraceDeadline : Number.POSITIVE_INFINITY
      );
      if (offlineDeadline > now) {
        if (!(Number.isFinite(expiryAt) && now >= expiryAt)) status = 'valid_with_warning';
        licensed = true;
      } else {
        status =
          Number.isFinite(expirationGraceDeadline) && now >= expirationGraceDeadline
            ? 'expired'
            : 'unreachable_grace_expired';
        plan = 'community';
        entitlements = COMMUNITY_ENTITLEMENTS;
        licensed = false;
      }
    }

    return {
      status,
      plan,
      registrationStatus: cached.registrationStatus,
      paidLicenseStatus: cached.paidLicenseStatus,
      licensed,
      hasKey: Boolean(encrypted),
      keyLast4: encrypted ? this.keyLast4(encrypted) : null,
      licenseName: cached.licenseName,
      licenseMetadata: cached.licenseMetadata,
      installationId,
      installationName,
      expiresAt: cached.expiresAt,
      entitlementsVersion: cached.entitlementsVersion,
      entitlements,
      lastCheckedAt: cached.lastCheckedAt,
      lastValidAt,
      graceUntil: status === 'expired_grace' ? (expirationGraceUntil?.toISOString() ?? null) : null,
      offlineGraceUntil:
        status === 'valid_with_warning' || status === 'unreachable_grace_expired'
          ? (offlineGraceUntil?.toISOString() ?? null)
          : null,
      activeInstallationId: cached.activeInstallationId,
      activeInstallationName: cached.activeInstallationName,
      errorMessage: cached.errorMessage,
      serverUrl: LICENSE_SERVER_URL,
    };
  }

  private statusFromState(state: LicenseServerState): LicenseStatus {
    if (state.effectivePlan !== 'community' && state.paidLicenseStatus === 'valid') return 'valid';
    if (state.effectivePlan !== 'community' && state.paidLicenseStatus === 'expired_grace') return 'expired_grace';
    switch (state.paidLicenseStatus) {
      case 'none':
        return 'community';
      case 'expired':
      case 'revoked':
      case 'replaced':
      case 'deactivated':
        return state.paidLicenseStatus;
      default:
        return 'invalid';
    }
  }

  private communityState(registrationStatus: 'registered' | 'pending'): CachedLicenseState {
    return {
      registrationStatus,
      status: 'community',
      plan: 'community',
      paidPlan: null,
      paidLicenseStatus: 'none',
      licenseName: null,
      licenseMetadata: {},
      expiresAt: null,
      graceUntil: null,
      entitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
      entitlements: COMMUNITY_ENTITLEMENTS,
      lastCheckedAt: null,
      lastValidAt: null,
      activeInstallationId: null,
      activeInstallationName: null,
      errorMessage: null,
    };
  }

  private normalizeCachedState(value: Record<string, unknown>): CachedLicenseState {
    const legacyTier = value.tier;
    const legacyPlan: LicensePlan =
      legacyTier === 'homelab' ? 'personal' : legacyTier === 'enterprise' ? 'enterprise' : 'community';
    const plan =
      value.plan === 'community' ||
      value.plan === 'personal' ||
      value.plan === 'business' ||
      value.plan === 'enterprise'
        ? value.plan
        : legacyPlan;
    const paidPlan =
      value.paidPlan === 'personal' || value.paidPlan === 'business' || value.paidPlan === 'enterprise'
        ? value.paidPlan
        : plan === 'personal' || plan === 'business' || plan === 'enterprise'
          ? plan
          : null;
    const status = typeof value.status === 'string' ? (value.status as LicenseStatus) : 'community';
    const fallback = this.communityState(value.registrationStatus === 'registered' ? 'registered' : 'pending');
    return {
      registrationStatus: fallback.registrationStatus,
      status,
      plan,
      paidPlan,
      paidLicenseStatus:
        typeof value.paidLicenseStatus === 'string' ? value.paidLicenseStatus : status === 'valid' ? 'valid' : 'none',
      licenseMetadata:
        value.licenseMetadata && typeof value.licenseMetadata === 'object'
          ? (value.licenseMetadata as Record<string, unknown>)
          : {},
      entitlements:
        value.entitlements && typeof value.entitlements === 'object'
          ? (value.entitlements as CachedLicenseState['entitlements'])
          : COMMUNITY_ENTITLEMENTS,
      entitlementsVersion: typeof value.entitlementsVersion === 'number' ? value.entitlementsVersion : 1,
      licenseName: typeof value.licenseName === 'string' ? value.licenseName : null,
      expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
      graceUntil: typeof value.graceUntil === 'string' ? value.graceUntil : null,
      lastCheckedAt: typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : null,
      lastValidAt: typeof value.lastValidAt === 'string' ? value.lastValidAt : null,
      activeInstallationId: typeof value.activeInstallationId === 'string' ? value.activeInstallationId : null,
      activeInstallationName: typeof value.activeInstallationName === 'string' ? value.activeInstallationName : null,
      errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : null,
    };
  }

  private keyLast4(encrypted: EncryptedLicenseCredential): string | null {
    try {
      return this.cryptoService.decryptString(encrypted).slice(-4);
    } catch {
      return null;
    }
  }

  private addOfflineGrace(iso: string): Date {
    const date = new Date(iso);
    date.setUTCDate(date.getUTCDate() + LICENSE_OFFLINE_GRACE_DAYS);
    return date;
  }

  private resolveExpirationGraceUntil(cached: CachedLicenseState): Date | null {
    if (!cached.paidPlan || !cached.expiresAt) return null;
    const expiresAt = new Date(cached.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) return null;
    const days = cached.paidPlan === 'personal' ? 1 : cached.paidPlan === 'business' ? 3 : 7;
    expiresAt.setUTCDate(expiresAt.getUTCDate() + days);
    if (!cached.graceUntil) return expiresAt;
    const declared = new Date(cached.graceUntil);
    if (!Number.isFinite(declared.getTime())) return expiresAt;
    return declared.getTime() < expiresAt.getTime() ? declared : expiresAt;
  }

  private assertServerState(value: unknown): asserts value is LicenseServerState {
    if (!value || typeof value !== 'object') this.invalidServerState();
    const state = value as Partial<LicenseServerState>;
    const plans: LicensePlan[] = ['community', 'personal', 'business', 'enterprise'];
    const statuses = ['none', 'valid', 'expired_grace', 'expired', 'revoked', 'replaced', 'deactivated'];
    if (
      state.registrationStatus !== 'registered' ||
      !plans.includes(state.effectivePlan as LicensePlan) ||
      typeof state.paidLicenseStatus !== 'string' ||
      !statuses.includes(state.paidLicenseStatus) ||
      state.entitlementsVersion !== LICENSE_ENTITLEMENTS_VERSION ||
      !state.entitlements ||
      !isCanonicalEntitlements(state.effectivePlan as LicensePlan, state.entitlements) ||
      typeof state.serverTime !== 'string' ||
      !Number.isFinite(Date.parse(state.serverTime))
    ) {
      this.invalidServerState();
    }

    const paid = state.paidLicense;
    if (state.paidLicenseStatus === 'none') {
      if (state.effectivePlan !== 'community' || paid !== undefined || state.graceUntil !== null) {
        this.invalidServerState();
      }
      return;
    }
    if (!paid || typeof paid !== 'object') this.invalidServerState();
    if (
      !['personal', 'business', 'enterprise'].includes(paid.plan) ||
      !['active', 'expired', 'revoked'].includes(paid.status) ||
      typeof paid.id !== 'string' ||
      typeof paid.name !== 'string' ||
      typeof paid.keyLast4 !== 'string' ||
      !paid.metadata ||
      typeof paid.metadata !== 'object' ||
      Array.isArray(paid.metadata) ||
      (paid.expiresAt !== null && (typeof paid.expiresAt !== 'string' || !Number.isFinite(Date.parse(paid.expiresAt))))
    ) {
      this.invalidServerState();
    }

    const effectivePaid = state.paidLicenseStatus === 'valid' || state.paidLicenseStatus === 'expired_grace';
    if (effectivePaid) {
      if (state.effectivePlan !== paid.plan) this.invalidServerState();
    } else if (state.effectivePlan !== 'community') {
      this.invalidServerState();
    }
    if (state.paidLicenseStatus === 'valid' && paid.status !== 'active') this.invalidServerState();
    if (state.paidLicenseStatus === 'expired_grace' && paid.status !== 'expired') this.invalidServerState();
    if (state.paidLicenseStatus === 'expired' && paid.status !== 'expired') this.invalidServerState();
    if (state.paidLicenseStatus === 'revoked' && paid.status !== 'revoked') this.invalidServerState();

    if (state.activation !== undefined) {
      const activation = state.activation;
      if (
        !activation ||
        typeof activation.installationId !== 'string' ||
        typeof activation.installationName !== 'string' ||
        typeof activation.activatedAt !== 'string' ||
        !Number.isFinite(Date.parse(activation.activatedAt)) ||
        (activation.lastHeartbeatAt !== null &&
          (typeof activation.lastHeartbeatAt !== 'string' || !Number.isFinite(Date.parse(activation.lastHeartbeatAt))))
      ) {
        this.invalidServerState();
      }
    }

    const expectedGrace = this.serverExpirationGraceUntil(paid.plan, paid.expiresAt);
    const declaredGrace = state.graceUntil;
    if (
      (expectedGrace === null && declaredGrace !== null) ||
      (expectedGrace !== null &&
        (typeof declaredGrace !== 'string' || Date.parse(declaredGrace) !== expectedGrace.getTime()))
    ) {
      this.invalidServerState();
    }
  }

  private invalidServerState(): never {
    throw new LicenseServerRequestError(502, 'INVALID_LICENSE_STATE', 'License server returned an invalid state');
  }

  private serverExpirationGraceUntil(plan: Exclude<LicensePlan, 'community'>, expiresAt: string | null): Date | null {
    if (!expiresAt) return null;
    const date = new Date(expiresAt);
    const hours = plan === 'personal' ? 24 : plan === 'business' ? 72 : 168;
    date.setUTCHours(date.getUTCHours() + hours);
    return date;
  }

  private scheduleLifecycleRefresh(status: LicenseStatusView, cached: CachedLicenseState): void {
    if (this.lifecycleTimer) clearTimeout(this.lifecycleTimer);
    this.lifecycleTimer = null;
    const now = Date.now();
    const offlineDeadline =
      cached.errorMessage && cached.paidPlan && cached.lastValidAt
        ? this.addOfflineGrace(cached.lastValidAt).toISOString()
        : null;
    const expirationGraceDeadline = this.resolveExpirationGraceUntil(cached)?.toISOString() ?? null;
    const deadline = [
      status.expiresAt,
      status.graceUntil,
      status.offlineGraceUntil,
      offlineDeadline,
      expirationGraceDeadline,
    ]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0];
    if (deadline === undefined) return;
    const delay = Math.min(deadline - now, 2_147_483_647);
    this.lifecycleTimer = setTimeout(() => {
      this.lifecycleTimer = null;
      void this.getStatus().catch((error) => {
        logger.error('Failed to refresh license lifecycle state', { error: this.errorMessage(error) });
      });
    }, delay);
    this.lifecycleTimer.unref?.();
  }

  private publishStatusIfChanged(status: LicenseStatusView): void {
    const payload = {
      status: status.status,
      plan: status.plan,
      paidLicenseStatus: status.paidLicenseStatus,
      expiresAt: status.expiresAt,
      graceUntil: status.graceUntil,
      offlineGraceUntil: status.offlineGraceUntil,
      entitlementsVersion: status.entitlementsVersion,
    };
    const signature = JSON.stringify(payload);
    if (signature === this.lastPublishedStatus) return;
    this.lastPublishedStatus = signature;
    this.eventBus?.publish('system.license.changed', payload);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'License server unreachable';
  }

  private getInstallationName(): string {
    try {
      const publicUrl = this.generalSettingsService?.getCachedPublicUrl() ?? this.env.APP_URL;
      return new URL(publicUrl).hostname || os.hostname();
    } catch {
      return os.hostname();
    }
  }

  async getInstallationId(): Promise<string> {
    if (!this.installationIdPromise) {
      this.installationIdPromise = this.loadOrCreateInstallationId().finally(() => {
        this.installationIdPromise = null;
      });
    }
    return this.installationIdPromise;
  }

  private async loadOrCreateInstallationId(): Promise<string> {
    const existing = await this.getSetting<string | null>(SETTINGS_KEYS.installationId, null);
    if (existing) return existing;
    const created = randomUUID();
    await this.setSetting(SETTINGS_KEYS.installationId, created);
    return created;
  }

  private async getCachedState(): Promise<CachedLicenseState | null> {
    const value = await this.getSetting<Record<string, unknown> | null>(SETTINGS_KEYS.cachedState, null);
    return value ? this.normalizeCachedState(value) : null;
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
