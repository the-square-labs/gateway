import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { inferenceLimitPolicies, inferenceUsageLedger } from '@/db/schema/index.js';
import type { InferenceLimitPolicy } from '@/db/schema/inference-models.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';

export const SUBSCRIPTION_WINDOWS = {
  '5h': 5 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
} as const;

export interface EffectiveInferenceLimits {
  enabled: boolean;
  credits5hEnabled: boolean;
  credits5h: number;
  credits7dEnabled: boolean;
  credits7d: number;
  credits30dEnabled: boolean;
  credits30d: number;
  apiMonthlyMicrodollars: number;
  billingTimezone: string;
}

export interface InferenceBudgetUsage {
  credits5h: number;
  credits7d: number;
  credits30d: number;
  apiMonthlyMicrodollars: number;
  recoveryAt: { credits5h: Date; credits7d: Date; credits30d: Date; apiMonthly: Date };
}

@injectable()
export class InferenceBudgetPolicyService {
  constructor(@inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient) {}

  async effective(userId: string, database: DrizzleExecutor = this.db): Promise<EffectiveInferenceLimits> {
    const rows = await database
      .select()
      .from(inferenceLimitPolicies)
      .where(
        sql`${inferenceLimitPolicies.policyType} = 'default' OR (${inferenceLimitPolicies.policyType} = 'user' AND ${inferenceLimitPolicies.userId} = ${userId})`
      )
      .orderBy(desc(inferenceLimitPolicies.policyType));
    const defaultPolicy = rows.find((row) => row.policyType === 'default');
    const userPolicy = rows.find((row) => row.policyType === 'user');
    const policy = userPolicy ?? defaultPolicy;
    if (!policy) {
      throw new InferenceProtocolError(503, 'budget_policy_unavailable', 'Inference limits are not configured');
    }
    return effectiveLimits(policy, userPolicy ? defaultPolicy : undefined);
  }

  async usage(
    userId: string,
    limits: EffectiveInferenceLimits,
    now = new Date(),
    database: DrizzleExecutor = this.db
  ): Promise<InferenceBudgetUsage> {
    const month = calendarMonthWindow(now, limits.billingTimezone);
    const cutoffs = {
      credits5h: new Date(now.getTime() - SUBSCRIPTION_WINDOWS['5h']),
      credits7d: new Date(now.getTime() - SUBSCRIPTION_WINDOWS['7d']),
      credits30d: new Date(now.getTime() - SUBSCRIPTION_WINDOWS['30d']),
    };
    const subscriptionSum = async (cutoff: Date) => {
      const [row] = await database
        .select({ value: sql<string>`COALESCE(SUM(${inferenceUsageLedger.credits}), 0)` })
        .from(inferenceUsageLedger)
        .where(
          and(
            eq(inferenceUsageLedger.userId, userId),
            eq(inferenceUsageLedger.budgetType, 'subscription'),
            gte(inferenceUsageLedger.occurredAt, cutoff)
          )
        );
      return Number(row?.value ?? 0);
    };
    const [credits5h, credits7d, credits30d, apiRow] = await Promise.all([
      subscriptionSum(cutoffs.credits5h),
      subscriptionSum(cutoffs.credits7d),
      subscriptionSum(cutoffs.credits30d),
      database
        .select({ value: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)` })
        .from(inferenceUsageLedger)
        .where(
          and(
            eq(inferenceUsageLedger.userId, userId),
            eq(inferenceUsageLedger.budgetType, 'api'),
            gte(inferenceUsageLedger.occurredAt, month.start)
          )
        ),
    ]);
    return {
      credits5h,
      credits7d,
      credits30d,
      apiMonthlyMicrodollars: Number(apiRow[0]?.value ?? 0),
      recoveryAt: {
        credits5h: new Date(now.getTime() + SUBSCRIPTION_WINDOWS['5h']),
        credits7d: new Date(now.getTime() + SUBSCRIPTION_WINDOWS['7d']),
        credits30d: new Date(now.getTime() + SUBSCRIPTION_WINDOWS['30d']),
        apiMonthly: month.end,
      },
    };
  }
}

function effectiveLimits(policy: InferenceLimitPolicy, defaultPolicy?: InferenceLimitPolicy): EffectiveInferenceLimits {
  return {
    enabled: policy.enabled,
    credits5hEnabled: policy.credits5hEnabled && (defaultPolicy?.credits5hEnabled ?? true),
    credits5h: Number(policy.credits5h),
    credits7dEnabled: policy.credits7dEnabled && (defaultPolicy?.credits7dEnabled ?? true),
    credits7d: Number(policy.credits7d),
    credits30dEnabled: policy.credits30dEnabled && (defaultPolicy?.credits30dEnabled ?? true),
    credits30d: Number(policy.credits30d),
    apiMonthlyMicrodollars: policy.apiMonthlyMicrodollars,
    billingTimezone: policy.billingTimezone,
  };
}

export function dynamicBurnMultiplier(
  windows: Array<{ dimension: string; remainingFraction: number | null; resetAt: Date | null; validUntil: Date }>,
  now = new Date(),
  isCompaction = false
): number {
  if (isCompaction) return 1;
  if (windows.length === 0) return 1;
  let worst = 1;
  for (const window of windows) {
    if (window.validUntil.getTime() <= now.getTime()) return 8;
    const remaining = window.remainingFraction;
    if (remaining === null || remaining <= 0) return 8;
    const duration = quotaWindowDuration(window.dimension);
    const timeFraction = window.resetAt
      ? Math.max(0, Math.min(1, (window.resetAt.getTime() - now.getTime()) / duration))
      : 1;
    worst = Math.max(worst, timeFraction / remaining, 0.3 / remaining);
  }
  return Math.min(8, worst);
}

export function subscriptionCredits(
  totalTokens: number,
  modelMultiplier: number,
  burnMultiplier: number,
  serviceTierMultiplier = 1
): number {
  return (Math.max(0, totalTokens) / 1000) * modelMultiplier * burnMultiplier * serviceTierMultiplier;
}

export function apiMicrodollars(
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  },
  pricing: {
    inputMicrodollarsPerMillion: number | null;
    cachedInputMicrodollarsPerMillion: number | null;
    cacheWriteMicrodollarsPerMillion: number | null;
    outputMicrodollarsPerMillion: number | null;
    reasoningMicrodollarsPerMillion: number | null;
  }
): number {
  if (pricing.inputMicrodollarsPerMillion === null || pricing.outputMicrodollarsPerMillion === null) {
    throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  }
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    uncachedInput * pricing.inputMicrodollarsPerMillion +
    usage.cachedInputTokens * (pricing.cachedInputMicrodollarsPerMillion ?? pricing.inputMicrodollarsPerMillion) +
    usage.cacheWriteTokens * (pricing.cacheWriteMicrodollarsPerMillion ?? pricing.inputMicrodollarsPerMillion) +
    usage.outputTokens * pricing.outputMicrodollarsPerMillion +
    usage.reasoningTokens * (pricing.reasoningMicrodollarsPerMillion ?? pricing.outputMicrodollarsPerMillion);
  return Math.ceil(cost / 1_000_000);
}

export function calendarMonthWindow(now: Date, timezone: string): { start: Date; end: Date } {
  const local = localParts(now, timezone);
  const start = zonedDateToUtc(local.year, local.month, 1, timezone);
  const nextYear = local.month === 12 ? local.year + 1 : local.year;
  const nextMonth = local.month === 12 ? 1 : local.month + 1;
  return { start, end: zonedDateToUtc(nextYear, nextMonth, 1, timezone) };
}

function quotaWindowDuration(dimension: string): number {
  if (dimension.startsWith('5h')) return SUBSCRIPTION_WINDOWS['5h'];
  if (dimension.startsWith('7d')) return SUBSCRIPTION_WINDOWS['7d'];
  if (dimension.startsWith('30d')) return SUBSCRIPTION_WINDOWS['30d'];
  return SUBSCRIPTION_WINDOWS['30d'];
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function zonedDateToUtc(year: number, month: number, day: number, timezone: string): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day));
  for (let index = 0; index < 3; index += 1) {
    const actual = localParts(candidate, timezone);
    const desired = Date.UTC(year, month - 1, day);
    const rendered = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate = new Date(candidate.getTime() + desired - rendered);
  }
  return candidate;
}

export const __testOnly = { effectiveLimits };
