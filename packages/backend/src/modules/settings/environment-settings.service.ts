import { eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  type EnvironmentSettings,
  type EnvironmentSettingsLegacyUpdate,
  EnvironmentSettingsSchema,
  type EnvironmentSettingsUpdate,
  EnvironmentSettingsUpdateSchema,
} from './environment-settings.schemas.js';

const SETTINGS_KEY = 'environment:settings';

export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = {
  rateLimits: {
    windowMs: 60_000,
    maxRequests: 1_200,
    authMaxRequests: 120,
    authLoginMaxRequests: 20,
    authCallbackMaxRequests: 60,
    setupMaxRequests: 20,
    publicStatusMaxRequests: 600,
    publicWebhookMaxRequests: 60,
    pkiMaxRequests: 600,
    streamMaxRequests: 120,
    aiWebSocketMaxRequests: 120,
    inferenceMaxRequests: 1_800,
  },
  loggingIngest: {
    maxBodyBytes: 1_048_576,
    maxBatchSize: 500,
    maxMessageBytes: 16_384,
    maxLabels: 32,
    maxFields: 64,
    maxKeyLength: 100,
    maxValueBytes: 8_192,
    maxJsonDepth: 5,
    rateLimitWindowSeconds: 60,
    globalRequestsPerWindow: 600,
    globalEventsPerWindow: 60_000,
    tokenRequestsPerWindow: 300,
    tokenEventsPerWindow: 10_000,
  },
  requestLimits: {
    requestBodyMaxBytes: 2_097_152,
    oauthBodyMaxBytes: 32_768,
    inferenceHttpBodyMaxBytes: 256 * 1024 * 1024,
    inferenceWebSocketMaxPayloadBytes: 50 * 1024 * 1024,
    inferenceMaxConcurrentRequestsPerToken: 32,
    inferenceConcurrencyLeaseSeconds: 600,
  },
  sessions: {
    expirySeconds: 2_592_000,
  },
  pkiDefaults: {
    crlValidityHours: 24,
    expiryWarningDays: 30,
    expiryCriticalDays: 7,
  },
};

export class EnvironmentSettingsService {
  private current: EnvironmentSettings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);

  constructor(
    private readonly db: DrizzleClient,
    private readonly eventBus?: EventBusService
  ) {}

  async initialize(): Promise<EnvironmentSettings> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    this.current = normalizeEnvironmentSettings(row?.value);
    return this.getSnapshot();
  }

  getSnapshot(): EnvironmentSettings {
    return structuredClone(this.current);
  }

  async update(input: EnvironmentSettingsUpdate): Promise<EnvironmentSettings> {
    const validated = EnvironmentSettingsUpdateSchema.parse(input);
    const next = EnvironmentSettingsSchema.parse({
      rateLimits: { ...this.current.rateLimits, ...validated.rateLimits },
      loggingIngest: { ...this.current.loggingIngest, ...validated.loggingIngest },
      requestLimits: { ...this.current.requestLimits, ...validated.requestLimits },
      sessions: { ...this.current.sessions, ...validated.sessions },
      pkiDefaults: { ...this.current.pkiDefaults, ...validated.pkiDefaults },
    });
    await this.persist(next);
    this.current = next;
    this.eventBus?.publish('system.config.changed', { key: SETTINGS_KEY });
    return this.getSnapshot();
  }

  async importLegacy(input: EnvironmentSettingsLegacyUpdate): Promise<boolean> {
    const [existing] = await this.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    if (existing) return false;
    const next = EnvironmentSettingsSchema.parse({
      rateLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.rateLimits, ...input.rateLimits },
      loggingIngest: { ...DEFAULT_ENVIRONMENT_SETTINGS.loggingIngest, ...input.loggingIngest },
      requestLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.requestLimits, ...input.requestLimits },
      sessions: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions, ...input.sessions },
      pkiDefaults: { ...DEFAULT_ENVIRONMENT_SETTINGS.pkiDefaults, ...input.pkiDefaults },
    });
    await this.persist(next);
    this.current = next;
    return true;
  }

  private async persist(value: EnvironmentSettings): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

export function getEnvironmentSettingsSnapshot(): EnvironmentSettings {
  if (!container.isRegistered(EnvironmentSettingsService)) {
    return structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);
  }
  return container.resolve(EnvironmentSettingsService).getSnapshot();
}

function normalizeEnvironmentSettings(value: unknown): EnvironmentSettings {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);
  const stored = value as Partial<EnvironmentSettings>;
  return EnvironmentSettingsSchema.parse({
    rateLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.rateLimits, ...stored.rateLimits },
    loggingIngest: { ...DEFAULT_ENVIRONMENT_SETTINGS.loggingIngest, ...stored.loggingIngest },
    requestLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.requestLimits, ...stored.requestLimits },
    sessions: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions, ...stored.sessions },
    pkiDefaults: { ...DEFAULT_ENVIRONMENT_SETTINGS.pkiDefaults, ...stored.pkiDefaults },
  });
}
