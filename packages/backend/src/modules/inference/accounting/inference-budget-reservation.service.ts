import type { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { EffectiveInferenceLimits, InferenceBudgetUsage } from './inference-budget-policy.js';

const RESERVATION_TTL_MS = 15 * 60_000;
const RESERVATION_HEARTBEAT_MS = 60_000;
const UNLIMITED_RESERVATION_LIMIT = Number.MAX_SAFE_INTEGER;

export type InferenceBudgetDimension = 'credits5h' | 'credits7d' | 'credits30d' | 'apiMonthlyMicrodollars';

export interface BudgetReservationAmounts {
  credits5h: number;
  credits7d: number;
  credits30d: number;
  apiMonthlyMicrodollars: number;
}

export interface BudgetReservation {
  id: string;
  userId: string;
  amounts: BudgetReservationAmounts;
  expiresAt: Date;
}

const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local reservation = ARGV[2]
for i = 1, 4 do
  local zkey = KEYS[(i - 1) * 2 + 1]
  local hkey = KEYS[(i - 1) * 2 + 2]
  local expired = redis.call('ZRANGEBYSCORE', zkey, '-inf', now)
  for _, member in ipairs(expired) do redis.call('HDEL', hkey, member) end
  if #expired > 0 then redis.call('ZREM', zkey, unpack(expired)) end
  local values = redis.call('HVALS', hkey)
  local live = 0
  for _, value in ipairs(values) do live = live + tonumber(value) end
  local existing = tonumber(redis.call('HGET', hkey, reservation) or '0')
  local amount = tonumber(ARGV[2 + i])
  local spent = tonumber(ARGV[6 + i])
  local limit = tonumber(ARGV[10 + i])
  if spent + live - existing + amount > limit then return i end
end
local expiry = tonumber(ARGV[15])
for i = 1, 4 do
  local zkey = KEYS[(i - 1) * 2 + 1]
  local hkey = KEYS[(i - 1) * 2 + 2]
  local amount = tonumber(ARGV[2 + i])
  if amount > 0 then
    redis.call('ZADD', zkey, expiry, reservation)
    redis.call('HSET', hkey, reservation, amount)
    redis.call('PEXPIRE', zkey, expiry - now + 60000)
    redis.call('PEXPIRE', hkey, expiry - now + 60000)
  end
end
return 0
`;

const RELEASE_SCRIPT = `
for i = 1, 4 do
  redis.call('ZREM', KEYS[(i - 1) * 2 + 1], ARGV[1])
  redis.call('HDEL', KEYS[(i - 1) * 2 + 2], ARGV[1])
end
return 1
`;

const RENEW_SCRIPT = `
local found = 0
local now = tonumber(ARGV[2])
local expiry = tonumber(ARGV[3])
for i = 1, 4 do
  local zkey = KEYS[(i - 1) * 2 + 1]
  local hkey = KEYS[(i - 1) * 2 + 2]
  if redis.call('HEXISTS', hkey, ARGV[1]) == 1 then
    found = 1
    redis.call('ZADD', zkey, expiry, ARGV[1])
    redis.call('PEXPIRE', zkey, expiry - now + 60000)
    redis.call('PEXPIRE', hkey, expiry - now + 60000)
  end
end
return found
`;

@injectable()
export class InferenceBudgetReservationService {
  private readonly renewals = new Map<string, NodeJS.Timeout>();

  constructor(@inject(TOKENS.RedisClient) private readonly redis: Redis) {}

  async reserve(input: {
    reservationId: string;
    userId: string;
    amounts: BudgetReservationAmounts;
    usage: InferenceBudgetUsage;
    limits: EffectiveInferenceLimits;
    isCompaction: boolean;
  }): Promise<BudgetReservation> {
    const now = Date.now();
    const expiresAt = new Date(now + RESERVATION_TTL_MS);
    const dimensions: InferenceBudgetDimension[] = ['credits5h', 'credits7d', 'credits30d', 'apiMonthlyMicrodollars'];
    const limits = dimensions.map((dimension) => reservationLimit(dimension, input.limits, input.isCompaction));
    let result: unknown;
    try {
      result = await this.redis.eval(
        RESERVE_SCRIPT,
        8,
        ...reservationKeys(input.userId),
        now,
        input.reservationId,
        ...dimensions.map((dimension) => input.amounts[dimension]),
        ...dimensions.map((dimension) => input.usage[dimension]),
        ...limits,
        expiresAt.getTime()
      );
    } catch (error) {
      throw new InferenceProtocolError(503, 'reservation_unavailable', 'Budget admission is temporarily unavailable', {
        cause: error,
      });
    }
    const rejected = Number(result);
    if (rejected > 0) {
      const dimension = dimensions[rejected - 1]!;
      const recoveryAt = recoveryFor(dimension, input.usage);
      throw new InferenceProtocolError(
        429,
        dimension === 'apiMonthlyMicrodollars' ? 'api_budget_exhausted' : 'subscription_budget_exhausted',
        'Inference budget exhausted',
        { recoveryAt: recoveryAt.toISOString(), dimension: publicDimension(dimension) }
      );
    }
    const reservation = { id: input.reservationId, userId: input.userId, amounts: input.amounts, expiresAt };
    this.startRenewal(reservation);
    return reservation;
  }

  async release(reservation: Pick<BudgetReservation, 'id' | 'userId'>): Promise<void> {
    this.stopRenewal(reservation);
    try {
      await this.redis.eval(RELEASE_SCRIPT, 8, ...reservationKeys(reservation.userId), reservation.id);
    } catch {
      // The reservation has a bounded TTL. Keeping it on Redis failure is fail-closed.
    }
  }

  async isActive(reservation: Pick<BudgetReservation, 'id' | 'userId'>): Promise<boolean> {
    const keys = reservationKeys(reservation.userId);
    const values = await Promise.all([1, 3, 5, 7].map((index) => this.redis.hexists(keys[index]!, reservation.id)));
    return values.some((value) => value === 1);
  }

  private startRenewal(reservation: BudgetReservation): void {
    this.stopRenewal(reservation);
    const timer = setInterval(() => {
      void this.renew(reservation).catch(() => undefined);
    }, RESERVATION_HEARTBEAT_MS);
    timer.unref();
    this.renewals.set(renewalKey(reservation), timer);
  }

  private stopRenewal(reservation: Pick<BudgetReservation, 'id' | 'userId'>): void {
    const key = renewalKey(reservation);
    const timer = this.renewals.get(key);
    if (timer) clearInterval(timer);
    this.renewals.delete(key);
  }

  private async renew(reservation: BudgetReservation): Promise<void> {
    const now = Date.now();
    const expiresAt = new Date(now + RESERVATION_TTL_MS);
    const found = await this.redis.eval(
      RENEW_SCRIPT,
      8,
      ...reservationKeys(reservation.userId),
      reservation.id,
      now,
      expiresAt.getTime()
    );
    if (Number(found) === 0) this.stopRenewal(reservation);
    else reservation.expiresAt = expiresAt;
  }
}

function renewalKey(reservation: Pick<BudgetReservation, 'id' | 'userId'>): string {
  return `${reservation.userId}:${reservation.id}`;
}

function reservationKeys(userId: string): string[] {
  const prefix = `inference:budget:{${userId}}`;
  return ['5h', '7d', '30d', 'api'].flatMap((dimension) => [
    `${prefix}:${dimension}:expiries`,
    `${prefix}:${dimension}:amounts`,
  ]);
}

function reservationLimit(
  dimension: InferenceBudgetDimension,
  limits: EffectiveInferenceLimits,
  isCompaction: boolean
): number {
  const value = limits[dimension];
  if (dimension === 'credits5h' && !limits.credits5hEnabled) return UNLIMITED_RESERVATION_LIMIT;
  if (dimension === 'credits7d' && !limits.credits7dEnabled) return UNLIMITED_RESERVATION_LIMIT;
  if (dimension === 'credits30d' && !limits.credits30dEnabled) return UNLIMITED_RESERVATION_LIMIT;
  if (dimension === 'apiMonthlyMicrodollars' || isCompaction) return value;
  return value * 0.95;
}

function recoveryFor(dimension: InferenceBudgetDimension, usage: InferenceBudgetUsage): Date {
  if (dimension === 'apiMonthlyMicrodollars') return usage.recoveryAt.apiMonthly;
  return usage.recoveryAt[dimension];
}

function publicDimension(dimension: InferenceBudgetDimension): string {
  if (dimension === 'apiMonthlyMicrodollars') return 'monthly';
  return dimension.replace('credits', '').toLowerCase();
}

export const __testOnly = { reservationKeys, reservationLimit, publicDimension };
