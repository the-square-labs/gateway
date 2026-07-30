import type { inferenceDiscoveredModels, inferencePricingSnapshots } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { pricingFromDiscoveredMetadata } from '../providers/inference-provider-model-catalog.js';
import type { InferenceModelInput, InferencePricingInput } from './inference-model.types.js';

export function validateModelInput(input: InferenceModelInput) {
  normalizePublicId(input.publicId);
  if (!input.displayName.trim()) throw new AppError(400, 'INFERENCE_MODEL_NAME_REQUIRED', 'Display name is required');
  if (
    input.contextWindow <= 0 ||
    input.maxInputTokens <= 0 ||
    (input.maxOutputTokens !== null && input.maxOutputTokens <= 0) ||
    input.autoCompactTokenLimit <= 0 ||
    input.autoCompactTokenLimit > input.maxInputTokens ||
    input.subscriptionMultiplier <= 0
  ) {
    throw new AppError(
      400,
      'INFERENCE_MODEL_LIMIT_INVALID',
      'Model limits and multiplier must be positive and consistent'
    );
  }
}

export function normalizePublicId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:/-]{0,254}$/.test(normalized)) {
    throw new AppError(400, 'INFERENCE_MODEL_ID_INVALID', 'Public model ID contains unsupported characters');
  }
  return normalized;
}

export function validateDefaultEffort(efforts: string[], value?: string | null) {
  if (value && !efforts.includes(value.toLowerCase())) {
    throw new AppError(400, 'INFERENCE_REASONING_DEFAULT_INVALID', 'Default reasoning effort must be advertised');
  }
}

export function manualSourceAllowed(syncStatus: string, modelsPath: string | undefined, metadata?: object): boolean {
  return Boolean(metadata && (!modelsPath || syncStatus === 'error' || syncStatus === 'never'));
}

export function validatePricing(input?: InferencePricingInput): asserts input is InferencePricingInput {
  if (
    !input?.version.trim() ||
    input.inputMicrodollarsPerMillion === null ||
    input.inputMicrodollarsPerMillion === undefined ||
    input.outputMicrodollarsPerMillion === null ||
    input.outputMicrodollarsPerMillion === undefined
  ) {
    throw new AppError(400, 'INFERENCE_PRICING_REQUIRED', 'Versioned input and output pricing is required');
  }
  const values = [
    input.inputMicrodollarsPerMillion,
    input.cachedInputMicrodollarsPerMillion,
    input.cacheWriteMicrodollarsPerMillion,
    input.outputMicrodollarsPerMillion,
    input.reasoningMicrodollarsPerMillion,
    ...Object.values(input.otherUnitPrices ?? {}),
  ];
  if (values.some((value) => value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new AppError(400, 'INFERENCE_PRICING_INVALID', 'Pricing values must be non-negative safe integers');
  }
}

export function latestPricing(rows: Array<typeof inferencePricingSnapshots.$inferSelect>) {
  return rows[0]
    ? {
        ...rows[0],
        effectiveAt: rows[0].effectiveAt.toISOString(),
        createdAt: rows[0].createdAt.toISOString(),
      }
    : null;
}

export function serializeDiscovered(model: typeof inferenceDiscoveredModels.$inferSelect) {
  return {
    id: model.id,
    connectionId: model.connectionId,
    upstreamModelId: model.remoteModelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    modalities: model.modalities,
    capabilities: model.capabilities,
    reasoningEfforts: model.reasoningEfforts,
    pricing: pricingFromDiscoveredMetadata(model.metadata) ?? null,
  };
}
