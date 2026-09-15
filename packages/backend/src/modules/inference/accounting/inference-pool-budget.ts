import { and, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  inferenceModelSources,
  inferenceModels,
  inferenceProviderConnections,
  inferenceQuotaSnapshots,
} from '@/db/schema/index.js';
import { dynamicBurnMultiplier, quotaWindowDuration } from './inference-budget-policy.js';

type PoolAccount = { connectionId: string; providerId: string; accountExternalId?: string | null; modelIds?: string[] };
type PoolQuota = Pick<
  typeof inferenceQuotaSnapshots.$inferSelect,
  | 'connectionId'
  | 'dimension'
  | 'modelBucket'
  | 'remainingFraction'
  | 'limitValue'
  | 'resetAt'
  | 'fetchedAt'
  | 'validUntil'
>;

/** A model has one subscription pool price, independent of the selected route. */
export async function modelPoolBurnMultiplier(
  database: Pick<DrizzleExecutor, 'select'>,
  modelId: string,
  now: Date,
  isCompaction = false
): Promise<number> {
  if (isCompaction) return 1;
  const sources = await database
    .select({
      connectionId: inferenceModelSources.connectionId,
      providerId: inferenceProviderConnections.providerId,
      accountExternalId: inferenceProviderConnections.accountExternalId,
      publicModelId: inferenceModels.publicId,
      upstreamModelId: inferenceModelSources.upstreamModelId,
    })
    .from(inferenceModelSources)
    .innerJoin(inferenceProviderConnections, eq(inferenceProviderConnections.id, inferenceModelSources.connectionId))
    .innerJoin(inferenceModels, eq(inferenceModels.id, inferenceModelSources.modelId))
    .where(
      and(
        eq(inferenceModelSources.modelId, modelId),
        eq(inferenceModelSources.enabled, true),
        eq(inferenceModelSources.sourceType, 'subscription'),
        eq(inferenceProviderConnections.enabled, true),
        isNull(inferenceProviderConnections.deletedAt),
        notInArray(inferenceProviderConnections.status, ['disabled', 'reauth_required', 'pending'])
      )
    );
  const accounts: PoolAccount[] = sources.map((source) => ({
    ...source,
    modelIds: [modelId, source.publicModelId, source.upstreamModelId],
  }));
  if (accounts.length === 0) return 1;
  // Only the newest synchronization batch for EACH account, not the pool's
  // latest timestamp and not all historical quota snapshots on every request.
  const rows = await database
    .select({
      connectionId: inferenceQuotaSnapshots.connectionId,
      dimension: inferenceQuotaSnapshots.dimension,
      modelBucket: inferenceQuotaSnapshots.modelBucket,
      remainingFraction: inferenceQuotaSnapshots.remainingFraction,
      limitValue: inferenceQuotaSnapshots.limitValue,
      resetAt: inferenceQuotaSnapshots.resetAt,
      fetchedAt: inferenceQuotaSnapshots.fetchedAt,
      validUntil: inferenceQuotaSnapshots.validUntil,
    })
    .from(inferenceQuotaSnapshots)
    .where(
      or(
        ...[...new Set(accounts.map((account) => account.connectionId))].map((connectionId) =>
          and(
            eq(inferenceQuotaSnapshots.connectionId, connectionId),
            // Constant per-account subqueries permit one indexed latest lookup,
            // rather than a correlated subquery evaluated for every historical row.
            sql`${inferenceQuotaSnapshots.fetchedAt} = (select q.fetched_at from inference_quota_snapshots q where q.connection_id = ${connectionId} order by q.fetched_at desc limit 1)`
          )
        )
      )
    );
  return poolBurnMultiplier(accounts, rows, now);
}

export function poolBurnMultiplier(accounts: PoolAccount[], rows: PoolQuota[], now: Date): number {
  const groups = new Map<
    string,
    { connectionId: string; providerId: string; ids: Set<string>; modelIds: Set<string> }
  >();
  for (const account of accounts) {
    const key = JSON.stringify([account.providerId, account.accountExternalId || account.connectionId]);
    const group = groups.get(key) ?? {
      connectionId: key,
      providerId: account.providerId,
      ids: new Set<string>(),
      modelIds: new Set<string>(),
    };
    group.ids.add(account.connectionId);
    for (const modelId of account.modelIds ?? []) group.modelIds.add(modelId);
    groups.set(key, group);
  }
  const uniqueAccounts = [...groups.values()];
  const byAccount = new Map<string, PoolQuota[]>();
  for (const account of uniqueAccounts) {
    const accountRows = rows.filter((row) => row.connectionId !== null && account.ids.has(row.connectionId));
    const latest = Math.max(...accountRows.map((row) => row.fetchedAt.getTime()));
    byAccount.set(
      account.connectionId,
      accountRows.filter(
        (row) =>
          row.fetchedAt.getTime() === latest && (row.modelBucket === null || account.modelIds.has(row.modelBucket))
      )
    );
  }
  const dimensions = new Set(
    uniqueAccounts.flatMap((account) => (byAccount.get(account.connectionId) ?? []).map((row) => row.dimension))
  );
  const windows = [...dimensions].map((dimension) => {
    const duration = quotaWindowDuration(dimension);
    const members = uniqueAccounts.flatMap((account) => {
      const accountRows = byAccount.get(account.connectionId) ?? [];
      // Collapse simultaneous bucket constraints before pooling, so duplicate
      // source aliases/buckets never give one account extra weight.
      const candidates = accountRows.filter((row) => row.dimension === dimension);
      if (candidates.length === 0 && accountRows.length > 0) return [];
      const remaining = (row: PoolQuota) =>
        row.validUntil.getTime() <= now.getTime() ||
        (row.resetAt !== null && row.resetAt.getTime() <= now.getTime()) ||
        row.remainingFraction === null
          ? 0
          : Math.max(0, Math.min(1, Number(row.remainingFraction)));
      // Simultaneous global/model constraints can reset at different times.
      // Preserve the conservative envelope (minimum remainder, maximum time),
      // not an arbitrary row selected by remainder alone.
      const time = (row: PoolQuota) =>
        row.resetAt ? Math.max(0, Math.min(1, (row.resetAt.getTime() - now.getTime()) / duration)) : 1;
      const sameBucket = candidates.every((row) => row.modelBucket === candidates[0]?.modelBucket);
      const capacities = candidates.map((row) => Number(row.limitValue));
      const comparable =
        candidates.length > 0 && sameBucket && capacities.every((value) => Number.isFinite(value) && value > 0);
      return [
        {
          providerId: account.providerId,
          bucket: sameBucket ? (candidates[0]?.modelBucket ?? null) : null,
          capacity: comparable ? Math.min(...capacities) : 0,
          remaining: candidates.length > 0 ? Math.min(...candidates.map(remaining)) : 0,
          time: candidates.length > 0 ? Math.max(...candidates.map(time)) : 1,
        },
      ];
    });
    // Absolute quotas are comparable only within the same provider/bucket and
    // when every member reports a capacity. Otherwise one account is one share.
    const weighted = members.every(
      (m) =>
        Number.isFinite(m.capacity) &&
        m.capacity > 0 &&
        m.providerId === members[0]?.providerId &&
        m.bucket === members[0]?.bucket
    );
    let capacity = 0,
      remaining = 0,
      time = 0;
    for (const member of members) {
      const weight = weighted ? member.capacity : 1;
      capacity += weight;
      remaining += member.remaining * weight;
      time += member.time * weight;
    }
    return {
      dimension,
      remainingFraction: capacity > 0 ? remaining / capacity : 0,
      resetAt: new Date(now.getTime() + duration * (capacity > 0 ? time / capacity : 1)),
      validUntil: new Date(now.getTime() + 1),
    };
  });
  return dynamicBurnMultiplier(windows, now);
}
