import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { inferencePricingSnapshots, inferenceQuotaSnapshots } from '@/db/schema/index.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceRequest, InferenceUsage } from '../protocol/inference-protocol.types.js';
import { estimateInputTokens } from '../protocol/inference-usage.js';
import { apiMicrodollars, subscriptionCredits } from './inference-budget-policy.js';
import type { BudgetReservationAmounts } from './inference-budget-reservation.service.js';

const DEFAULT_UNKNOWN_MAX_OUTPUT_TOKENS = 8_192;

export function conservativeEstimate(
  request: InferenceRequest,
  modelMaxOutput: number | null,
  modelMaxInput: number
): InferenceUsage {
  const inputTokens = estimateInputTokens(request.messages);
  const outputCeiling = modelMaxOutput ?? Math.min(modelMaxInput, DEFAULT_UNKNOWN_MAX_OUTPUT_TOKENS);
  const outputTokens = Math.min(request.maxOutputTokens ?? outputCeiling, outputCeiling);
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}

export function zeroUsage(): InferenceUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

export function reservationAmounts(
  sourceType: 'subscription' | 'api',
  usage: InferenceUsage,
  modelMultiplier: number,
  burnMultiplier: number,
  serviceTierMultiplier: number,
  pricing: typeof inferencePricingSnapshots.$inferSelect | null,
  fixedApiMicrodollars = 0
): BudgetReservationAmounts {
  if (sourceType === 'subscription') {
    const credits = subscriptionCredits(usage.totalTokens, modelMultiplier, burnMultiplier, serviceTierMultiplier);
    return { credits5h: credits, credits7d: credits, credits30d: credits, apiMonthlyMicrodollars: 0 };
  }
  if (!pricing) throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  return {
    credits5h: 0,
    credits7d: 0,
    credits30d: 0,
    apiMonthlyMicrodollars: apiMicrodollars(usage, pricing) + fixedApiMicrodollars,
  };
}

export function unitCharge(
  pricing: typeof inferencePricingSnapshots.$inferSelect | null,
  priceKey: string,
  rawUnits: number
): number {
  if (!pricing) throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  const price = pricing.otherUnitPrices[priceKey];
  const units = Math.max(1, Math.floor(rawUnits));
  const total = price * units;
  if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(total)) {
    throw new InferenceProtocolError(503, 'pricing_unavailable', `API pricing for ${priceKey} is unavailable`);
  }
  return total;
}

export function stringExtension(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function errorCode(error: unknown): string {
  return error instanceof InferenceProtocolError ? error.code.slice(0, 128) : 'upstream_error';
}

export async function latestPricing(database: DrizzleExecutor, sourceId: string) {
  const pricing = await database.query.inferencePricingSnapshots.findFirst({
    where: eq(inferencePricingSnapshots.sourceId, sourceId),
    orderBy: [desc(inferencePricingSnapshots.effectiveAt)],
  });
  if (!pricing || pricing.inputMicrodollarsPerMillion === null || pricing.outputMicrodollarsPerMillion === null) {
    throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  }
  return pricing;
}

export async function latestQuota(database: DrizzleExecutor, connectionId: string) {
  const rows = await database
    .select()
    .from(inferenceQuotaSnapshots)
    .where(eq(inferenceQuotaSnapshots.connectionId, connectionId))
    .orderBy(desc(inferenceQuotaSnapshots.fetchedAt));
  return latestQuotaRows(rows);
}

function latestQuotaRows(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>) {
  const latestFetchedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.fetchedAt.getTime()),
    Number.NEGATIVE_INFINITY
  );
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (row.fetchedAt.getTime() !== latestFetchedAt) return [];
    const key = `${row.dimension}:${row.modelBucket ?? ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        dimension: row.dimension,
        remainingFraction: row.remainingFraction === null ? null : Number(row.remainingFraction),
        resetAt: row.resetAt,
        validUntil: row.validUntil,
      },
    ];
  });
}

export const __testOnly = { conservativeEstimate, reservationAmounts, latestQuotaRows };
