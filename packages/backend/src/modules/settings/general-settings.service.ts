import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { InferenceSetupEventsService } from '@/modules/inference/inference-setup-events.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const SETTINGS_KEY = 'general:settings';
const BODY_LIMIT_OVERHEAD_RATIO = 1.5;
const BODY_LIMIT_OVERHEAD_BYTES = 4096;

export const FILE_UPLOAD_MIN_BYTES = 1 * 1024 * 1024;
export const FILE_UPLOAD_DEFAULT_BYTES = 100 * 1024 * 1024;
export const FILE_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
export const FILE_OPEN_MIN_BYTES = 1 * 1024 * 1024;
export const FILE_OPEN_DEFAULT_BYTES = 10 * 1024 * 1024;
export const FILE_OPEN_MAX_BYTES = 100 * 1024 * 1024;
export const SHUTDOWN_USER_DRAIN_MAX_SECONDS = 40;
export const SHUTDOWN_LOG_DRAIN_MAX_SECONDS = 10;
export const SHUTDOWN_FINALIZATION_MIN_SECONDS = 5;
export const SHUTDOWN_FINALIZATION_MAX_SECONDS = 15;
export const SHUTDOWN_TOTAL_MAX_SECONDS = 50;

export interface GeneralSettings {
  publicUrl: string | null;
  fileUploadMaxBytes: number;
  fileOpenMaxBytes: number;
  gatewayPublicIps: string[];
  gatewayGrpcPublicTarget: string | null;
  gatewayGrpcLocalIp: string | null;
  relayAutoRecovery: boolean;
  shutdown: GeneralShutdownSettings;
  features: GeneralFeatureSettings;
  inference: GeneralInferenceSettings;
}

export interface GeneralShutdownSettings {
  userRequestDrainSeconds: number;
  structuredLogDrainSeconds: number;
  finalizationTimeoutSeconds: number;
}

export interface GeneralFeatureSettings {
  pkiEnabled: boolean;
  domainsEnabled: boolean;
  siemEnabled: boolean;
  inferenceEnabled: boolean;
}

export interface GeneralInferenceSettings {
  harnessSpecificEndpointsEnabled: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  publicUrl: null,
  fileUploadMaxBytes: FILE_UPLOAD_DEFAULT_BYTES,
  fileOpenMaxBytes: FILE_OPEN_DEFAULT_BYTES,
  gatewayPublicIps: [],
  gatewayGrpcPublicTarget: null,
  gatewayGrpcLocalIp: null,
  relayAutoRecovery: true,
  shutdown: {
    userRequestDrainSeconds: 30,
    structuredLogDrainSeconds: 5,
    finalizationTimeoutSeconds: 10,
  },
  features: {
    pkiEnabled: true,
    domainsEnabled: true,
    siemEnabled: true,
    inferenceEnabled: false,
  },
  inference: {
    harnessSpecificEndpointsEnabled: false,
  },
};

export type GeneralSettingsUpdate = Omit<Partial<GeneralSettings>, 'features' | 'inference' | 'shutdown'> & {
  features?: Partial<GeneralFeatureSettings>;
  inference?: Partial<GeneralInferenceSettings>;
  shutdown?: GeneralShutdownSettings;
};

export function normalizePublicUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Gateway public URL must be a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Gateway public URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Gateway public URL must be an origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function fileUploadBodyLimitBytes(fileUploadMaxBytes: number): number {
  return Math.ceil(fileUploadMaxBytes * BODY_LIMIT_OVERHEAD_RATIO) + BODY_LIMIT_OVERHEAD_BYTES;
}

export function normalizeHostPortTarget(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (/[/?#@\s]/.test(trimmed) || trimmed.includes('://')) {
    throw new Error(`Gateway gRPC public target must be a hostname or IP address: ${trimmed}`);
  }

  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketedIpv6) {
    const [, ip, rawPort] = bracketedIpv6;
    if (!isValidGatewayIp(ip)) throw new Error(`Gateway gRPC public target IPv6 address is invalid: ${ip}`);
    const port = normalizePort(rawPort);
    return port ? `[${ip}]:${port}` : ip;
  }

  if (isValidGatewayIp(trimmed)) return trimmed;

  const hostWithPort = trimmed.match(/^([^:]+):(\d+)$/);
  const host = hostWithPort?.[1] ?? trimmed;
  const port = normalizePort(hostWithPort?.[2]);
  if (!isValidGatewayHostname(host)) {
    throw new Error(`Gateway gRPC public target must be a hostname or IP address: ${trimmed}`);
  }
  return port ? `${host}:${port}` : host;
}

export function splitConfiguredIps(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isValidGatewayIp(value: string): boolean {
  return isIP(value) !== 0;
}

export function isValidGatewayHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith('.')) return false;
  const labels = value.split('.');
  return labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function normalizePort(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error(`Gateway gRPC local IP port must be numeric: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Gateway gRPC local IP port must be between 1 and 65535: ${value}`);
  }
  return String(port);
}

export function normalizeIpPortTarget(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;

  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketedIpv6) {
    const [, ip, rawPort] = bracketedIpv6;
    if (!isValidGatewayIp(ip)) throw new Error(`Gateway gRPC local IP must be an IPv4 or IPv6 address: ${ip}`);
    const port = normalizePort(rawPort);
    return port ? `[${ip}]:${port}` : ip;
  }

  if (isValidGatewayIp(trimmed)) return trimmed;

  const ipv4WithPort = trimmed.match(/^([^:]+):(\d+)$/);
  if (ipv4WithPort) {
    const [, ip, rawPort] = ipv4WithPort;
    if (!isValidGatewayIp(ip)) throw new Error(`Gateway gRPC local IP must be an IPv4 or IPv6 address: ${ip}`);
    return `${ip}:${normalizePort(rawPort)}`;
  }

  throw new Error(`Gateway gRPC local IP must be an IPv4 or IPv6 address: ${trimmed}`);
}

export function isValidGatewayIpPortTarget(value: string): boolean {
  try {
    normalizeIpPortTarget(value);
    return true;
  } catch {
    return false;
  }
}

export function isValidGatewayHostPortTarget(value: string): boolean {
  try {
    normalizeHostPortTarget(value);
    return true;
  } catch {
    return false;
  }
}

export class GeneralSettingsService {
  private cached: GeneralSettings | null = null;
  private cachedAt = 0;
  private inferenceDisabledHandler?: () => Promise<void>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly inferenceSetupEvents?: InferenceSetupEventsService,
    private readonly eventBus?: EventBusService
  ) {}

  setInferenceDisabledHandler(handler: () => Promise<void>): void {
    this.inferenceDisabledHandler = handler;
  }

  async getConfig(): Promise<GeneralSettings> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < 5000) return this.cached;

    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    const config = this.normalize(row?.value);
    this.cached = config;
    this.cachedAt = now;
    return config;
  }

  async updateConfig(updates: GeneralSettingsUpdate): Promise<GeneralSettings> {
    const current = await this.getConfig();
    const next = this.normalize({
      ...current,
      ...updates,
      features: {
        ...current.features,
        ...updates.features,
      },
      inference: {
        ...current.inference,
        ...updates.inference,
      },
      shutdown: updates.shutdown ?? current.shutdown,
    });
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: new Date() },
      });
    this.cached = next;
    this.cachedAt = Date.now();
    // No configuration is carried by this event. It only lets cached,
    // permission-filtered read models refresh immediately.
    this.eventBus?.publish('system.config.changed', {});
    if (
      current.features.inferenceEnabled !== next.features.inferenceEnabled ||
      current.inference.harnessSpecificEndpointsEnabled !== next.inference.harnessSpecificEndpointsEnabled
    ) {
      this.inferenceSetupEvents?.publishCatalogChanged();
    }
    if (current.features.inferenceEnabled && !next.features.inferenceEnabled) {
      await this.inferenceDisabledHandler?.();
    }
    return next;
  }

  async getFileUploadMaxBodyBytes(): Promise<number> {
    const config = await this.getConfig();
    return fileUploadBodyLimitBytes(config.fileUploadMaxBytes);
  }

  async getPublicUrl(): Promise<string | null> {
    return (await this.getConfig()).publicUrl;
  }

  getCachedPublicUrl(): string | null {
    return this.cached?.publicUrl ?? null;
  }

  async requirePublicUrl(): Promise<string> {
    const publicUrl = await this.getPublicUrl();
    if (!publicUrl) throw new Error('Gateway public URL has not been configured');
    return publicUrl;
  }

  async importLegacyPublicUrl(value: string | null | undefined): Promise<GeneralSettings> {
    const current = await this.getConfig();
    if (current.publicUrl) return current;
    const publicUrl = normalizePublicUrl(value);
    return publicUrl ? this.updateConfig({ publicUrl }) : current;
  }

  async getFileOpenMaxBytes(): Promise<number> {
    const config = await this.getConfig();
    return config.fileOpenMaxBytes;
  }

  async getGatewayEndpointSettings(): Promise<
    Pick<GeneralSettings, 'gatewayPublicIps' | 'gatewayGrpcPublicTarget' | 'gatewayGrpcLocalIp'>
  > {
    const config = await this.getConfig();
    return {
      gatewayPublicIps: config.gatewayPublicIps,
      gatewayGrpcPublicTarget: config.gatewayGrpcPublicTarget,
      gatewayGrpcLocalIp: config.gatewayGrpcLocalIp,
    };
  }

  async isFeatureEnabled(feature: keyof GeneralFeatureSettings): Promise<boolean> {
    const config = await this.getConfig();
    return config.features[feature];
  }

  async getInferenceSettings(): Promise<GeneralInferenceSettings> {
    return (await this.getConfig()).inference;
  }

  getCachedShutdownSettings(): GeneralShutdownSettings {
    return { ...(this.cached?.shutdown ?? DEFAULT_GENERAL_SETTINGS.shutdown) };
  }

  async updateInferenceSettings(updates: Partial<GeneralInferenceSettings>): Promise<GeneralInferenceSettings> {
    return (await this.updateConfig({ inference: updates })).inference;
  }

  private normalize(value: unknown): GeneralSettings {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const rawFileUploadMaxBytes = Number(record.fileUploadMaxBytes);
    const fileUploadMaxBytes = Number.isInteger(rawFileUploadMaxBytes)
      ? rawFileUploadMaxBytes
      : DEFAULT_GENERAL_SETTINGS.fileUploadMaxBytes;
    const rawFileOpenMaxBytes = Number(record.fileOpenMaxBytes);
    const fileOpenMaxBytes = Number.isInteger(rawFileOpenMaxBytes)
      ? rawFileOpenMaxBytes
      : DEFAULT_GENERAL_SETTINGS.fileOpenMaxBytes;
    const gatewayPublicIps = splitConfiguredIps(record.gatewayPublicIps);
    const invalidGatewayPublicIp = gatewayPublicIps.find((ip) => !isValidGatewayIp(ip));

    if (fileUploadMaxBytes < FILE_UPLOAD_MIN_BYTES || fileUploadMaxBytes > FILE_UPLOAD_MAX_BYTES) {
      throw new Error(`File upload limit must be between ${FILE_UPLOAD_MIN_BYTES} and ${FILE_UPLOAD_MAX_BYTES} bytes`);
    }

    if (fileOpenMaxBytes < FILE_OPEN_MIN_BYTES || fileOpenMaxBytes > FILE_OPEN_MAX_BYTES) {
      throw new Error(`File open limit must be between ${FILE_OPEN_MIN_BYTES} and ${FILE_OPEN_MAX_BYTES} bytes`);
    }
    if (invalidGatewayPublicIp) {
      throw new Error(`Gateway public IP must be an IPv4 or IPv6 address: ${invalidGatewayPublicIp}`);
    }

    const features =
      typeof record.features === 'object' && record.features !== null
        ? (record.features as Record<string, unknown>)
        : {};
    const inference =
      typeof record.inference === 'object' && record.inference !== null
        ? (record.inference as Record<string, unknown>)
        : {};
    const shutdown = normalizeShutdownSettings(record.shutdown);

    return {
      publicUrl: normalizePublicUrl(record.publicUrl as string | null | undefined),
      fileUploadMaxBytes,
      fileOpenMaxBytes,
      gatewayPublicIps,
      gatewayGrpcPublicTarget: normalizeHostPortTarget(record.gatewayGrpcPublicTarget as string | null | undefined),
      gatewayGrpcLocalIp: normalizeIpPortTarget(record.gatewayGrpcLocalIp as string | null | undefined),
      relayAutoRecovery:
        typeof record.relayAutoRecovery === 'boolean'
          ? record.relayAutoRecovery
          : DEFAULT_GENERAL_SETTINGS.relayAutoRecovery,
      shutdown,
      features: {
        pkiEnabled:
          typeof features.pkiEnabled === 'boolean' ? features.pkiEnabled : DEFAULT_GENERAL_SETTINGS.features.pkiEnabled,
        domainsEnabled:
          typeof features.domainsEnabled === 'boolean'
            ? features.domainsEnabled
            : DEFAULT_GENERAL_SETTINGS.features.domainsEnabled,
        siemEnabled:
          typeof features.siemEnabled === 'boolean'
            ? features.siemEnabled
            : DEFAULT_GENERAL_SETTINGS.features.siemEnabled,
        inferenceEnabled:
          typeof features.inferenceEnabled === 'boolean'
            ? features.inferenceEnabled
            : DEFAULT_GENERAL_SETTINGS.features.inferenceEnabled,
      },
      inference: {
        harnessSpecificEndpointsEnabled:
          typeof inference.harnessSpecificEndpointsEnabled === 'boolean'
            ? inference.harnessSpecificEndpointsEnabled
            : DEFAULT_GENERAL_SETTINGS.inference.harnessSpecificEndpointsEnabled,
      },
    };
  }
}

export function normalizeShutdownSettings(value: unknown): GeneralShutdownSettings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const normalized = {
    userRequestDrainSeconds: numberOrDefault(
      record.userRequestDrainSeconds,
      DEFAULT_GENERAL_SETTINGS.shutdown.userRequestDrainSeconds
    ),
    structuredLogDrainSeconds: numberOrDefault(
      record.structuredLogDrainSeconds,
      DEFAULT_GENERAL_SETTINGS.shutdown.structuredLogDrainSeconds
    ),
    finalizationTimeoutSeconds: numberOrDefault(
      record.finalizationTimeoutSeconds,
      DEFAULT_GENERAL_SETTINGS.shutdown.finalizationTimeoutSeconds
    ),
  };

  if (normalized.userRequestDrainSeconds < 0 || normalized.userRequestDrainSeconds > SHUTDOWN_USER_DRAIN_MAX_SECONDS) {
    throw new Error(`User request drain must be between 0 and ${SHUTDOWN_USER_DRAIN_MAX_SECONDS} seconds`);
  }
  if (
    normalized.structuredLogDrainSeconds < 0 ||
    normalized.structuredLogDrainSeconds > SHUTDOWN_LOG_DRAIN_MAX_SECONDS
  ) {
    throw new Error(`Structured log drain must be between 0 and ${SHUTDOWN_LOG_DRAIN_MAX_SECONDS} seconds`);
  }
  if (
    normalized.finalizationTimeoutSeconds < SHUTDOWN_FINALIZATION_MIN_SECONDS ||
    normalized.finalizationTimeoutSeconds > SHUTDOWN_FINALIZATION_MAX_SECONDS
  ) {
    throw new Error(
      `Shutdown finalization must be between ${SHUTDOWN_FINALIZATION_MIN_SECONDS} and ${SHUTDOWN_FINALIZATION_MAX_SECONDS} seconds`
    );
  }
  const total =
    normalized.userRequestDrainSeconds + normalized.structuredLogDrainSeconds + normalized.finalizationTimeoutSeconds;
  if (total > SHUTDOWN_TOTAL_MAX_SECONDS) {
    throw new Error(`Total graceful shutdown deadline must not exceed ${SHUTDOWN_TOTAL_MAX_SECONDS} seconds`);
  }
  return normalized;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}
