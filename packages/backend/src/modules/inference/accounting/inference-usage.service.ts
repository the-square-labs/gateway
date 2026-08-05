import { and, asc, desc, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceLimitPolicies, inferenceRequests, inferenceUsageLedger, users } from '@/db/schema/index.js';
import type { InferenceRequestStatus } from '@/db/schema/inference-usage.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { type InferenceBudgetPolicyService, SUBSCRIPTION_CHAT_BUDGET_FRACTION } from './inference-budget-policy.js';
import { publishInferenceUsageChanged } from './inference-usage-events.js';

export interface InferenceLimitPolicyInput {
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

const GATEWAY_SYSTEM_OIDC_SUBJECT = 'system:gateway-setup';

@injectable()
export class InferenceUsageService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly policies: InferenceBudgetPolicyService,
    private readonly audit: AuditService,
    private readonly eventBus?: EventBusService
  ) {}

  async self(userId: string) {
    const limits = await this.policies.effective(userId);
    const usage = await this.policies.usage(userId, limits);
    return {
      enabled: limits.enabled,
      api: {
        configured: limits.apiMonthlyMicrodollars > 0,
        percentage: percentage(usage.apiMonthlyMicrodollars, limits.apiMonthlyMicrodollars),
        recoveryAt: usage.recoveryAt.apiMonthly.toISOString(),
      },
      subscription: {
        '5h': {
          configured: limits.credits5hEnabled,
          percentage: subscriptionPercentage(usage.credits5h, limits.credits5h),
          recoveryAt: usage.recoveryAt.credits5h.toISOString(),
        },
        '7d': {
          configured: limits.credits7dEnabled,
          percentage: subscriptionPercentage(usage.credits7d, limits.credits7d),
          recoveryAt: usage.recoveryAt.credits7d.toISOString(),
        },
        '30d': {
          configured: limits.credits30dEnabled,
          percentage: subscriptionPercentage(usage.credits30d, limits.credits30d),
          recoveryAt: usage.recoveryAt.credits30d.toISOString(),
        },
      },
    };
  }

  async adminOverview() {
    const [requestTotals, ledgerTotals] = await Promise.all([
      this.db
        .select({
          status: inferenceRequests.status,
          requests: sql<number>`COUNT(*)::int`,
          credits: sql<string>`COALESCE(SUM(${inferenceRequests.creditsCharged}), 0)`,
          apiMicrodollars: sql<number>`COALESCE(SUM(${inferenceRequests.apiMicrodollarsCharged}), 0)`,
          tokens: sql<number>`COALESCE(SUM(${inferenceRequests.uncachedInputTokens} + ${inferenceRequests.cachedInputTokens} + ${inferenceRequests.outputTokens} + ${inferenceRequests.reasoningTokens}), 0)`,
        })
        .from(inferenceRequests)
        .groupBy(inferenceRequests.status),
      this.db
        .select({
          budgetType: inferenceUsageLedger.budgetType,
          credits: sql<string>`COALESCE(SUM(${inferenceUsageLedger.credits}), 0)`,
          apiMicrodollars: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)`,
          tokens: sql<number>`COALESCE(SUM(${inferenceUsageLedger.uncachedInputTokens} + ${inferenceUsageLedger.cachedInputTokens} + ${inferenceUsageLedger.outputTokens} + ${inferenceUsageLedger.reasoningTokens}), 0)`,
        })
        .from(inferenceUsageLedger)
        .groupBy(inferenceUsageLedger.budgetType),
    ]);
    return {
      requestTotals: requestTotals.map((row) => ({
        ...row,
        requests: Number(row.requests),
        apiMicrodollars: Number(row.apiMicrodollars),
        tokens: Number(row.tokens),
      })),
      ledgerTotals: ledgerTotals.map((row) => ({
        ...row,
        apiMicrodollars: Number(row.apiMicrodollars),
        tokens: Number(row.tokens),
      })),
    };
  }

  async users() {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(or(isNull(users.oidcSubject), ne(users.oidcSubject, GATEWAY_SYSTEM_OIDC_SUBJECT)));
    return Promise.all(
      rows.map(async (user) => {
        try {
          const limits = await this.policies.effective(user.id);
          const usage = await this.policies.usage(user.id, limits);
          return { ...user, limits, usage };
        } catch {
          return { ...user, limits: null, usage: null };
        }
      })
    );
  }

  async limitUsers() {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(
        and(or(isNull(users.oidcSubject), ne(users.oidcSubject, GATEWAY_SYSTEM_OIDC_SUBJECT)), isNull(users.deletedAt))
      );
    return Promise.all(
      rows.map(async (user) => {
        try {
          return { ...user, limits: await this.policies.effective(user.id), usage: null };
        } catch {
          return { ...user, limits: null, usage: null };
        }
      })
    );
  }

  async activity(
    input: {
      page?: number;
      limit?: number;
      search?: string;
      status?: InferenceRequestStatus;
      userId?: string;
      model?: string;
    } = {}
  ) {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const conditions = [];
    const search = input.search?.trim();
    if (search) {
      const pattern = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      conditions.push(
        or(
          ilike(users.email, pattern),
          ilike(inferenceRequests.publicModelId, pattern),
          ilike(inferenceRequests.reasoningEffort, pattern),
          ilike(inferenceRequests.operation, pattern),
          ilike(inferenceRequests.status, pattern),
          ilike(inferenceRequests.errorCode, pattern)
        )!
      );
    }
    if (input.status) conditions.push(eq(inferenceRequests.status, input.status));
    if (input.userId) conditions.push(eq(inferenceRequests.userId, input.userId));
    if (input.model) conditions.push(eq(inferenceRequests.publicModelId, input.model));
    const rows = await this.db
      .select({
        id: inferenceRequests.id,
        userId: inferenceRequests.userId,
        userName: users.name,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
        protocol: inferenceRequests.protocol,
        operation: inferenceRequests.operation,
        publicModelId: inferenceRequests.publicModelId,
        reasoningEffort: inferenceRequests.reasoningEffort,
        budgetType: inferenceRequests.budgetType,
        status: inferenceRequests.status,
        credits: inferenceRequests.creditsCharged,
        apiMicrodollars: inferenceRequests.apiMicrodollarsCharged,
        uncachedInputTokens: inferenceRequests.uncachedInputTokens,
        cachedInputTokens: inferenceRequests.cachedInputTokens,
        cacheWriteTokens: inferenceRequests.cacheWriteTokens,
        outputTokens: inferenceRequests.outputTokens,
        reasoningTokens: inferenceRequests.reasoningTokens,
        errorCode: inferenceRequests.errorCode,
        startedAt: inferenceRequests.startedAt,
        completedAt: inferenceRequests.completedAt,
      })
      .from(inferenceRequests)
      .leftJoin(users, eq(inferenceRequests.userId, users.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(inferenceRequests.createdAt))
      .limit(limit + 1)
      .offset((page - 1) * limit);
    const hasMore = rows.length > limit;
    return {
      data: rows.slice(0, limit).map((row) => ({
        ...row,
        credits: Number(row.credits),
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      nextPage: hasMore ? page + 1 : null,
    };
  }

  async activityFilters() {
    const [userRows, modelRows] = await Promise.all([
      this.db
        .selectDistinct({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
        })
        .from(inferenceRequests)
        .innerJoin(users, eq(inferenceRequests.userId, users.id))
        .orderBy(asc(users.name), asc(users.email)),
      this.db
        .selectDistinct({ model: inferenceRequests.publicModelId })
        .from(inferenceRequests)
        .orderBy(asc(inferenceRequests.publicModelId)),
    ]);
    return {
      users: userRows,
      models: modelRows.map((row) => row.model),
    };
  }

  async listPolicies() {
    return this.db.select().from(inferenceLimitPolicies).orderBy(inferenceLimitPolicies.policyType);
  }

  async setDefault(userId: string, input: InferenceLimitPolicyInput) {
    validatePolicy(input);
    await this.db
      .insert(inferenceLimitPolicies)
      .values({ policyType: 'default', userId: null, ...dbPolicy(input), createdBy: userId })
      .onConflictDoUpdate({
        target: inferenceLimitPolicies.policyType,
        targetWhere: sql`${inferenceLimitPolicies.policyType} = 'default'`,
        set: { ...dbPolicy(input), updatedAt: new Date() },
      });
    await this.changed(userId, 'default', input);
    publishInferenceUsageChanged(this.eventBus, { targetUserId: null, reason: 'limits' });
    return this.listPolicies();
  }

  async setUser(userId: string, targetUserId: string, input: InferenceLimitPolicyInput) {
    validatePolicy(input);
    const target = await this.db.query.users.findFirst({
      where: and(eq(users.id, targetUserId), isNull(users.deletedAt)),
    });
    if (!target) throw new AppError(404, 'INFERENCE_LIMIT_USER_NOT_FOUND', 'User not found');
    await this.db
      .insert(inferenceLimitPolicies)
      .values({ policyType: 'user', userId: targetUserId, ...dbPolicy(input), createdBy: userId })
      .onConflictDoUpdate({
        target: inferenceLimitPolicies.userId,
        targetWhere: sql`${inferenceLimitPolicies.userId} IS NOT NULL`,
        set: { ...dbPolicy(input), updatedAt: new Date() },
      });
    await this.changed(userId, targetUserId, input);
    publishInferenceUsageChanged(this.eventBus, { targetUserId, reason: 'limits' });
    return this.listPolicies();
  }

  async removeUser(userId: string, targetUserId: string): Promise<void> {
    await this.db
      .delete(inferenceLimitPolicies)
      .where(and(eq(inferenceLimitPolicies.policyType, 'user'), eq(inferenceLimitPolicies.userId, targetUserId)));
    await this.audit.log({
      userId,
      action: 'inference.limit.delete',
      resourceType: 'inference_limit_policy',
      resourceId: targetUserId,
    });
    publishInferenceUsageChanged(this.eventBus, { targetUserId, reason: 'limits' });
  }

  private async changed(userId: string, target: string, input: InferenceLimitPolicyInput) {
    await this.audit.log({
      userId,
      action: 'inference.limit.update',
      resourceType: 'inference_limit_policy',
      resourceId: target,
      details: {
        enabled: input.enabled,
        credits5hEnabled: input.credits5hEnabled,
        credits7dEnabled: input.credits7dEnabled,
        credits30dEnabled: input.credits30dEnabled,
        billingTimezone: input.billingTimezone,
      },
    });
  }
}

function percentage(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function subscriptionPercentage(used: number, limit: number): number {
  return percentage(used, limit * SUBSCRIPTION_CHAT_BUDGET_FRACTION);
}

function validatePolicy(input: InferenceLimitPolicyInput) {
  const values = [input.credits5h, input.credits7d, input.credits30d, input.apiMonthlyMicrodollars];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new AppError(400, 'INFERENCE_LIMIT_INVALID', 'Inference limits must be non-negative numbers');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.billingTimezone }).format();
  } catch {
    throw new AppError(400, 'INFERENCE_TIMEZONE_INVALID', 'Billing timezone is invalid');
  }
}

function dbPolicy(input: InferenceLimitPolicyInput) {
  return {
    enabled: input.enabled,
    credits5hEnabled: input.credits5hEnabled,
    credits5h: String(input.credits5h),
    credits7dEnabled: input.credits7dEnabled,
    credits7d: String(input.credits7d),
    credits30dEnabled: input.credits30dEnabled,
    credits30d: String(input.credits30d),
    apiMonthlyMicrodollars: input.apiMonthlyMicrodollars,
    billingTimezone: input.billingTimezone,
  };
}

export const __testOnly = { percentage, subscriptionPercentage, validatePolicy };
