import type {
  inferenceDiscoveredModels,
  inferenceProviderConnections,
  inferenceQuotaSnapshots,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceProviderDefinition, InferenceQuotaWindow } from './inference-provider.types.js';
import { knownProviderModel, pricingFromDiscoveredMetadata } from './inference-provider-model-catalog.js';

export function validateBaseUrl(value: string, required: boolean): string {
  if (required && !value.trim())
    throw new AppError(400, 'INFERENCE_PROVIDER_BASE_URL_REQUIRED', 'Base URL is required');
  try {
    if (/[{}]/.test(value)) throw new Error('placeholder');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new AppError(
      400,
      'INFERENCE_PROVIDER_BASE_URL_INVALID',
      'Base URL must be an HTTP(S) URL without credentials'
    );
  }
}

export function classifyStatus(windows: InferenceQuotaWindow[]) {
  const fractions = windows.flatMap((window) =>
    window.remainingFraction === undefined ? [] : [window.remainingFraction]
  );
  if (fractions.length === 0) return 'healthy' as const;
  const minimum = Math.min(...fractions);
  if (minimum < 0.03) return 'unavailable' as const;
  if (minimum < 0.1) return 'quota_hot' as const;
  return 'healthy' as const;
}

export function preferSyncError(first: unknown, second: unknown): unknown {
  if (isReauthError(first)) return first;
  return second ?? first;
}

export function redactedError(error: unknown): string {
  if (error instanceof InferenceProtocolError || error instanceof AppError) return error.message.slice(0, 500);
  return 'Provider synchronization failed';
}

export function latestQuota(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.dimension}:${row.modelBucket ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function assertMinimumRemainingAllowed(
  provider: InferenceProviderDefinition,
  minimumRemainingPercent: number | undefined
) {
  if (minimumRemainingPercent !== undefined && !provider.subscription) {
    throw new AppError(
      400,
      'INFERENCE_PROVIDER_RESERVE_SUBSCRIPTION_ONLY',
      'Minimum remaining quota is available only for subscription providers'
    );
  }
}

export function assertApiMonthlyLimitAllowed(
  provider: InferenceProviderDefinition,
  apiMonthlyLimitMicrodollars: number | null | undefined
) {
  if (apiMonthlyLimitMicrodollars !== undefined && provider.subscription) {
    throw new AppError(
      400,
      'INFERENCE_PROVIDER_API_LIMIT_API_ONLY',
      'Monthly API limits are available only for API providers'
    );
  }
}

export function nextRoutingOrder(currentMaximum: number | undefined): number {
  return (currentMaximum ?? -1) + 1;
}

export function connectionDisableBlockers<T extends { id: string }>(affected: T[], remainingModelIds: string[]): T[] {
  const routable = new Set(remainingModelIds);
  return affected.filter((model) => !routable.has(model.id));
}

export function serializeConnection(connection: typeof inferenceProviderConnections.$inferSelect) {
  return {
    ...connection,
    lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
    nextSyncAt: connection.nextSyncAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
    deletedAt: connection.deletedAt?.toISOString() ?? null,
  };
}

export function serializeModel(model: typeof inferenceDiscoveredModels.$inferSelect, providerId?: string) {
  const known = providerId ? knownProviderModel(providerId, model.remoteModelId) : undefined;
  const reportedModalities = hasAny(model.metadata, [
    'input_modalities',
    'architecture',
    'supports_image_in',
    'supports_video_in',
  ]);
  const reportedCapabilities = hasAny(model.metadata, [
    'reasoning',
    'supports_reasoning',
    'think_efforts',
    'supported_parameters',
    'tools',
    'input_modalities',
    'architecture',
    'supports_image_in',
  ]);
  return {
    ...model,
    displayName: model.displayName ?? known?.displayName ?? null,
    contextWindow: model.contextWindow ?? known?.contextWindow ?? null,
    maxInputTokens: model.maxInputTokens ?? known?.maxInputTokens ?? null,
    maxOutputTokens: model.maxOutputTokens ?? known?.maxOutputTokens ?? null,
    autoCompactTokenLimit: model.autoCompactTokenLimit ?? known?.autoCompactTokenLimit ?? null,
    modalities: known && !reportedModalities ? known.modalities : model.modalities,
    capabilities: known && !reportedCapabilities ? known.capabilities : model.capabilities,
    reasoningEfforts: model.reasoningEfforts.length ? model.reasoningEfforts : (known?.reasoningEfforts ?? []),
    pricing: pricingFromDiscoveredMetadata(model.metadata) ?? known?.pricing ?? null,
    lastSeenAt: model.lastSeenAt.toISOString(),
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function hasAny(metadata: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => metadata[key] !== undefined);
}

export function serializeQuota(quota: typeof inferenceQuotaSnapshots.$inferSelect) {
  return {
    ...quota,
    fetchedAt: quota.fetchedAt.toISOString(),
    validUntil: quota.validUntil.toISOString(),
    resetAt: quota.resetAt?.toISOString() ?? null,
    stale: quota.validUntil.getTime() <= Date.now(),
  };
}

export function isReauthError(error: unknown): boolean {
  return (
    (error instanceof InferenceProtocolError && error.status === 401) ||
    (error instanceof AppError && error.statusCode === 401)
  );
}

export const __testOnly = {
  classifyStatus,
  validateBaseUrl,
  latestQuota,
  redactedError,
  assertApiMonthlyLimitAllowed,
  assertMinimumRemainingAllowed,
  nextRoutingOrder,
  connectionDisableBlockers,
};
