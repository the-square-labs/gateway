import { createChildLogger } from '@/lib/logger.js';
import type { InferenceAdmission } from './accounting/inference-accounting.service.js';
import type { InferenceUsage } from './protocol/inference-protocol.types.js';

const logger = createChildLogger('InferenceRuntime');

export function logInferenceSettlement(
  admission: InferenceAdmission,
  usage: InferenceUsage,
  status: 'completed' | 'failed',
  latencyMs: number
): void {
  logger.info('Inference request settled', {
    requestId: admission.requestId,
    status,
    latencyMs,
    publicModelId: admission.model.publicId,
    providerId: admission.connection.providerId,
    sourceType: admission.source.sourceType,
    budgetType: admission.budgetType,
    totalTokens: usage.totalTokens,
    usageEstimated: usage.estimated,
    burnMultiplier: admission.burnMultiplier,
    serviceTier: admission.serviceTier,
    serviceTierMultiplier: admission.serviceTierMultiplier,
  });
}

export function logInferenceFailure(
  admission: InferenceAdmission,
  errorCode: string,
  emittedOutput: boolean,
  latencyMs: number
): void {
  logger.warn('Inference request failed', {
    requestId: admission.requestId,
    errorCode,
    emittedOutput,
    latencyMs,
    publicModelId: admission.model.publicId,
    providerId: admission.connection.providerId,
    sourceType: admission.source.sourceType,
    budgetType: admission.budgetType,
  });
}
