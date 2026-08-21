import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceProviderConnections, inferenceProviderSettings, inferenceQuotaSnapshots } from '@/db/schema/index.js';
import type { InferenceConnectionStatus, InferenceRoutingStrategy } from '@/db/schema/inference-providers.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';

const AFFINITY_TTL_SECONDS = 24 * 60 * 60;
const NEW_THREAD_FLOOR = 0.1;
const EMERGENCY_FLOOR = 0.03;

export interface InferenceRoutingInput {
  providerId: string;
  allowedConnectionIds?: string[];
  affinityKey?: string;
  preferredConnectionId?: string;
  existingThread: boolean;
}

export interface InferenceRoutingSelection {
  connectionId: string;
  providerId: string;
  remainingFraction: number | null;
}

interface Candidate {
  id: string;
  providerId: string;
  order: number;
  status: string;
  remainingFraction: number | null;
  minimumRemainingFraction: number;
}

@injectable()
export class InferenceRoutingService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    @inject(TOKENS.RedisClient) private readonly redis: Redis
  ) {}

  async select(input: InferenceRoutingInput): Promise<InferenceRoutingSelection> {
    const candidates = await this.loadCandidates(input);
    const preferred = await this.preferred(input);
    const usable = candidates.filter((candidate) => isUsable(candidate, input.existingThread || Boolean(preferred)));
    if (usable.length === 0) {
      throw new InferenceProtocolError(
        503,
        'provider_capacity_unavailable',
        'No provider connection has usable capacity'
      );
    }

    const sticky = preferred ? usable.find((candidate) => candidate.id === preferred) : undefined;
    const selected = sticky ?? (await this.choose(input.providerId, input.affinityKey, usable));
    if (input.affinityKey) {
      await this.redis.set(this.affinityKey(input.affinityKey), selected.id, 'EX', AFFINITY_TTL_SECONDS);
    }
    return {
      connectionId: selected.id,
      providerId: selected.providerId,
      remainingFraction: selected.remainingFraction,
    };
  }

  async clearAffinity(affinityKey: string): Promise<void> {
    await this.redis.del(this.affinityKey(affinityKey));
  }

  async markCooldown(connectionId: string, seconds: number, reason = 'Provider requested cooldown'): Promise<void> {
    await Promise.all([
      this.redis.set(`inference:provider-cooldown:${connectionId}`, reason, 'EX', Math.max(1, seconds)),
      this.db
        .update(inferenceProviderConnections)
        .set({ status: 'cooldown', healthReason: reason, updatedAt: new Date() })
        .where(eq(inferenceProviderConnections.id, connectionId)),
    ]);
  }

  private async preferred(input: InferenceRoutingInput): Promise<string | undefined> {
    if (input.preferredConnectionId) return input.preferredConnectionId;
    if (!input.affinityKey) return undefined;
    return (await this.redis.get(this.affinityKey(input.affinityKey))) ?? undefined;
  }

  private async choose(
    providerId: string,
    affinityKey: string | undefined,
    candidates: Candidate[]
  ): Promise<Candidate> {
    const settings = await this.db.query.inferenceProviderSettings.findFirst({
      where: eq(inferenceProviderSettings.providerId, providerId),
    });
    const strategy: InferenceRoutingStrategy = settings?.routingStrategy ?? 'balanced';
    if (strategy === 'sequential') {
      return firstSequentialCandidate(candidates);
    }
    const seed = affinityKey ?? crypto.randomUUID();
    if (strategy === 'even') return highestScore(seed, candidates, () => 1);
    return quotaWeightedCandidate(seed, candidates);
  }

  private async loadCandidates(input: InferenceRoutingInput): Promise<Candidate[]> {
    const conditions = [
      eq(inferenceProviderConnections.providerId, input.providerId),
      eq(inferenceProviderConnections.enabled, true),
      isNull(inferenceProviderConnections.deletedAt),
    ];
    if (input.allowedConnectionIds?.length) {
      conditions.push(inArray(inferenceProviderConnections.id, input.allowedConnectionIds));
    }
    const connections = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(and(...conditions));
    const rows = await Promise.all(
      connections.map(async (connection): Promise<Candidate | null> => {
        const cooldownActive = Boolean(await this.redis.exists(`inference:provider-cooldown:${connection.id}`));
        if (cooldownActive) return null;
        const connectionStatus = statusAfterCooldown(connection.status, cooldownActive);
        if (connectionStatus !== connection.status) {
          await this.db
            .update(inferenceProviderConnections)
            .set({ status: connectionStatus, healthReason: null, updatedAt: new Date() })
            .where(
              and(
                eq(inferenceProviderConnections.id, connection.id),
                eq(inferenceProviderConnections.status, 'cooldown')
              )
            );
        }
        const quotas = await this.db.query.inferenceQuotaSnapshots.findMany({
          where: and(
            eq(inferenceQuotaSnapshots.connectionId, connection.id),
            eq(inferenceQuotaSnapshots.status, 'fresh')
          ),
          orderBy: [desc(inferenceQuotaSnapshots.fetchedAt)],
        });
        const latestQuotas = latestQuotaWindows(quotas);
        const remainingFractions = latestQuotas.flatMap((quota) =>
          quota.remainingFraction === null || quota.remainingFraction === undefined
            ? []
            : [Number(quota.remainingFraction)]
        );
        return {
          id: connection.id,
          providerId: connection.providerId,
          order: connection.routingOrder,
          status:
            latestQuotas.length > 0 && latestQuotas.some((quota) => quota.validUntil.getTime() <= Date.now())
              ? 'stale'
              : connectionStatus,
          remainingFraction: remainingFractions.length ? Math.min(...remainingFractions) : null,
          minimumRemainingFraction: connection.minimumRemainingPercent / 100,
        };
      })
    );
    return rows.filter((row): row is Candidate => row !== null);
  }

  private affinityKey(value: string): string {
    return `inference:affinity:${createHash('sha256').update(value).digest('hex')}`;
  }
}

function isUsable(candidate: Candidate, existingThread: boolean): boolean {
  if (['disabled', 'unavailable', 'reauth_required', 'cooldown', 'stale'].includes(candidate.status)) return false;
  if (candidate.remainingFraction === null) return true;
  return (
    candidate.remainingFraction >=
    Math.max(candidate.minimumRemainingFraction, existingThread ? EMERGENCY_FLOOR : NEW_THREAD_FLOOR)
  );
}

function latestQuotaWindows(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>) {
  const latestFetchedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.fetchedAt.getTime()),
    Number.NEGATIVE_INFINITY
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.fetchedAt.getTime() !== latestFetchedAt) return false;
    const key = `${row.dimension}:${row.modelBucket ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusAfterCooldown(status: InferenceConnectionStatus, cooldownActive: boolean): InferenceConnectionStatus {
  return status === 'cooldown' && !cooldownActive ? 'healthy' : status;
}

function uniformScore(seed: string, candidate: Candidate): number {
  const digest = createHash('sha256').update(`${seed}:${candidate.id}`).digest();
  return (digest.readUInt32BE(0) + 1) / 0x1_0000_0000;
}

/** Deterministic weighted rendezvous score. Larger weights win proportionally more keys. */
function weightedScore(seed: string, candidate: Candidate, weight: number): number {
  return Math.log(uniformScore(seed, candidate)) / Math.max(Number.EPSILON, weight);
}

function highestScore(seed: string, candidates: Candidate[], weightFor: (candidate: Candidate) => number): Candidate {
  return [...candidates].sort(
    (a, b) => weightedScore(seed, b, weightFor(b)) - weightedScore(seed, a, weightFor(a)) || a.id.localeCompare(b.id)
  )[0]!;
}

function quotaWeightedCandidate(seed: string, candidates: Candidate[]): Candidate {
  const knownCandidates = candidates.filter((candidate) => candidate.remainingFraction !== null);
  if (knownCandidates.length === 0) return highestScore(seed, candidates, () => 1);
  return highestScore(seed, knownCandidates, (candidate) => candidate.remainingFraction!);
}

function firstSequentialCandidate(candidates: Candidate[]): Candidate {
  return [...candidates].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0]!;
}

export function canFailOver(error: unknown, emittedOutput: boolean): boolean {
  if (emittedOutput) return false;
  if (!(error instanceof InferenceProtocolError)) return false;
  if (
    [
      'duplicate_request',
      'invalid_request_error',
      'model_not_found',
      'reservation_unavailable',
      'budget_policy_unavailable',
    ].includes(error.code)
  )
    return false;
  return [401, 408, 409, 429, 502, 503, 504].includes(error.status);
}

export const __testOnly = {
  uniformScore,
  weightedScore,
  quotaWeightedCandidate,
  highestScore,
  firstSequentialCandidate,
  isUsable,
  statusAfterCooldown,
  latestQuotaWindows,
  NEW_THREAD_FLOOR,
  EMERGENCY_FLOOR,
};
