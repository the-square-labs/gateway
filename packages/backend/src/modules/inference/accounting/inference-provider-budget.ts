import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { inferenceRequests, inferenceUsageLedger } from '@/db/schema/index.js';
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
  const requestConditions = [
    inArray(inferenceRequests.connectionId, connectionIds),
    eq(inferenceRequests.budgetType, 'api'),
  ];
  if (excludeRequestId) requestConditions.push(ne(inferenceRequests.id, excludeRequestId));

  const settled = await database
    .select({
      connectionId: inferenceRequests.connectionId,
      microdollars: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)`,
    })
    .from(inferenceUsageLedger)
    .innerJoin(inferenceRequests, eq(inferenceUsageLedger.requestId, inferenceRequests.id))
    .where(
      and(
        ...requestConditions,
        eq(inferenceUsageLedger.entryType, 'settlement'),
        gte(inferenceUsageLedger.occurredAt, monthStart)
      )
    )
    .groupBy(inferenceRequests.connectionId);

  const active = await database
    .select({
      connectionId: inferenceRequests.connectionId,
      microdollars: sql<number>`COALESCE(SUM(${inferenceRequests.apiMicrodollarsCharged}), 0)`,
    })
    .from(inferenceRequests)
    .where(
      and(
        ...requestConditions,
        inArray(inferenceRequests.status, ['reserved', 'running']),
        gte(inferenceRequests.startedAt, monthStart)
      )
    )
    .groupBy(inferenceRequests.connectionId);

  const result = new Map<string, number>();
  for (const row of [...settled, ...active]) {
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
  requestId: string,
  now = new Date()
): Promise<void> {
  const limit = connection.apiMonthlyLimitMicrodollars;
  if (limit === null) return;
  const spent = (await providerApiMonthlySpend(database, [connection.id], now, requestId)).get(connection.id) ?? 0;
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
