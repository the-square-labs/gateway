import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { inferenceRequestAttempts, inferenceRequests, inferenceUsageLedger } from '@/db/schema/index.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';

type ProviderApiLimit = {
  id: string;
  apiMonthlyLimitMicrodollars: number | null;
};

export async function providerApiMonthlySpend(
  database: DrizzleExecutor,
  connectionIds: string[],
  now = new Date(),
  excludeRequestId?: string
): Promise<Map<string, number>> {
  if (connectionIds.length === 0) return new Map();
  const monthStart = utcMonthStart(now);
  const settledConnectionId = sql<string>`coalesce(${inferenceRequestAttempts.connectionId}, ${inferenceRequests.connectionId})`;
  const settledConditions = [inArray(settledConnectionId, connectionIds), eq(inferenceUsageLedger.budgetType, 'api')];
  if (excludeRequestId) settledConditions.push(ne(inferenceRequests.id, excludeRequestId));

  const settled = await database
    .select({
      connectionId: settledConnectionId,
      microdollars: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)`,
    })
    .from(inferenceUsageLedger)
    .innerJoin(inferenceRequests, eq(inferenceUsageLedger.requestId, inferenceRequests.id))
    .leftJoin(inferenceRequestAttempts, eq(inferenceUsageLedger.attemptId, inferenceRequestAttempts.id))
    .where(
      and(
        ...settledConditions,
        eq(inferenceUsageLedger.entryType, 'settlement'),
        gte(inferenceUsageLedger.occurredAt, monthStart)
      )
    )
    .groupBy(settledConnectionId);

  const activeCoreConditions = [
    inArray(inferenceRequestAttempts.connectionId, connectionIds),
    eq(inferenceRequestAttempts.budgetType, 'api'),
    inArray(inferenceRequestAttempts.status, ['pending', 'running']),
    inArray(inferenceRequests.status, ['reserved', 'running']),
    gte(inferenceRequestAttempts.startedAt, monthStart),
  ];
  if (excludeRequestId) activeCoreConditions.push(ne(inferenceRequests.id, excludeRequestId));
  const activeCore = await database
    .select({
      connectionId: inferenceRequestAttempts.connectionId,
      microdollars: sql<number>`COALESCE(SUM(${inferenceRequestAttempts.reservedApiMicrodollars}), 0)`,
    })
    .from(inferenceRequestAttempts)
    .innerJoin(inferenceRequests, eq(inferenceRequestAttempts.requestId, inferenceRequests.id))
    .where(and(...activeCoreConditions))
    .groupBy(inferenceRequestAttempts.connectionId);

  // Legacy executor reservations live on the request row. Exclude requests
  // that already have a core attempt so core estimates are not counted twice.
  const legacyConditions = [
    inArray(inferenceRequests.connectionId, connectionIds),
    eq(inferenceRequests.budgetType, 'api'),
    inArray(inferenceRequests.status, ['reserved', 'running']),
    gte(inferenceRequests.startedAt, monthStart),
    isNull(inferenceRequestAttempts.id),
  ];
  if (excludeRequestId) legacyConditions.push(ne(inferenceRequests.id, excludeRequestId));
  const activeLegacy = await database
    .select({
      connectionId: inferenceRequests.connectionId,
      microdollars: sql<number>`COALESCE(SUM(${inferenceRequests.apiMicrodollarsCharged}), 0)`,
    })
    .from(inferenceRequests)
    .leftJoin(
      inferenceRequestAttempts,
      and(
        eq(inferenceRequestAttempts.requestId, inferenceRequests.id),
        isNotNull(inferenceRequestAttempts.coreAttemptId)
      )
    )
    .where(and(...legacyConditions))
    .groupBy(inferenceRequests.connectionId);

  const result = new Map<string, number>();
  for (const row of [...settled, ...activeCore, ...activeLegacy]) {
    if (!row.connectionId) continue;
    const value = Number(row.microdollars);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InferenceProtocolError(503, 'budget_policy_unavailable', 'Provider API budget usage is unavailable');
    }
    result.set(row.connectionId, (result.get(row.connectionId) ?? 0) + value);
  }
  return result;
}

export async function assertProviderApiBudget(
  database: DrizzleExecutor,
  connection: ProviderApiLimit,
  requestedMicrodollars: number,
  excludeRequestId?: string,
  now = new Date()
): Promise<void> {
  const limit = connection.apiMonthlyLimitMicrodollars;
  if (limit === null) return;
  const spent =
    (await providerApiMonthlySpend(database, [connection.id], now, excludeRequestId)).get(connection.id) ?? 0;
  if (providerApiBudgetAvailable(spent, requestedMicrodollars, limit)) return;
  throw new InferenceProtocolError(429, 'provider_api_budget_exhausted', 'Provider monthly API budget exhausted', {
    recoveryAt: nextUtcMonth(now).toISOString(),
    spentMicrodollars: spent,
    limitMicrodollars: limit,
  });
}

export function providerApiBudgetAvailable(spent: number, requested: number, limit: number | null): boolean {
  return limit === null || spent + requested <= limit;
}

export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
