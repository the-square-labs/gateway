import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { operationLeases } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('OperationLease');

/** Advisory lock namespace (`pg_advisory_xact_lock(namespace, key)`) of lease rows. */
const OPERATION_LEASE_LOCK_NAMESPACE = 1_869_636_965;
/** Longer keys are hashed, so an index entry stays small (a certificate can name many domains). */
const MAX_KEY_LENGTH = 255;

/** This backend process: the default lease holder, recorded for diagnostics. Ownership is the lease token. */
export const OPERATION_LEASE_PROCESS = `${os.hostname()}:${process.pid}`;

export interface OperationLease<T> {
  token: string;
  holder: string;
  /** When the lease lapses, by the database clock. Decide liveness with `live`, never with a process clock. */
  expiresAt: Date;
  /** Whether the lease had not expired when it was read, by the database clock. */
  live: boolean;
  data: T;
}

export type OperationLeaseClaim<T> =
  | {
      acquired: true;
      token: string;
      /**
       * `performance.now()` taken before the claim was sent: the lease lasts
       * at least `ttlMs` from then. Pass it to `hold` as `since`.
       */
      claimedAt: number;
    }
  | { acquired: false; key: string; lease: OperationLease<T> };

/** Why a held lease stopped protecting its operation: the reason of `OperationLeaseHold.signal`. */
export class OperationLeaseLostError extends Error {
  readonly code = 'OPERATION_LEASE_LOST';

  constructor(
    readonly keys: readonly string[],
    /** `taken-over`: another token holds a key now. `unconfirmed`: no renewal confirmed the lease for a full TTL. */
    readonly kind: 'taken-over' | 'unconfirmed'
  ) {
    super(
      kind === 'taken-over'
        ? 'The operation lease was taken over by another holder'
        : 'The operation lease could not be renewed before it expired'
    );
    this.name = 'OperationLeaseLostError';
  }
}

/** A lease held by `OperationLeaseStore.hold`. Once it is lost, the operation must stop acting as the owner. */
export interface OperationLeaseHold {
  /** Aborted, with an `OperationLeaseLostError`, once the lease is lost. */
  readonly signal: AbortSignal;
  /**
   * Whether the lease is lost: a renewal found a key held by another token,
   * or no renewal confirmed the lease for a full TTL (its expiry may have
   * passed in the database, and another process may own the keys). Reading it
   * checks the second case at once, so it holds even when the heartbeat has
   * not run yet (a blocked event loop).
   */
  readonly lost: boolean;
  /**
   * Renews at once. True while the token still holds every current key: no
   * other process can take them for a full TTL from now. False once the lease
   * is lost (or the hold was stopped). Rejects when the database cannot be
   * reached; the lease is then not confirmed.
   */
  confirm(): Promise<boolean>;
  stop(): void;
}

/** Lease key for one resource of a namespace; long ids are hashed. */
export function operationLeaseKey(namespace: string, id: string): string {
  const key = `${namespace}:${id}`;
  if (key.length <= MAX_KEY_LENGTH) return key;
  return `${namespace}:sha256:${createHash('sha256').update(id).digest('hex')}`;
}

/**
 * The database clock. Lease expiry is computed and compared on it only: the
 * clocks of backend processes may differ by more than a lease's lifetime.
 * `statement_timestamp()`, not `now()`, so a statement that waited for a lock
 * still reads the time it ran at.
 */
const DATABASE_NOW = sql`statement_timestamp()`;

/** The expiry of a lease that lasts `ms` from now, by the database clock. */
function expiresIn(ms: number): SQL {
  return sql`${DATABASE_NOW} + (${Math.max(0, Math.round(ms))}::double precision * interval '1 millisecond')`;
}

/**
 * True while `token` holds a live lease on `key`, by the database clock. AND
 * it into the WHERE of a write that only the lease's owner may make: the write
 * then lands only while the operation still owns the lease, checked in the
 * same statement (no gap in which another process could take it over).
 */
export function operationLeaseHeld(key: string, token: string): SQL {
  return sql`exists (select 1 from ${operationLeases} where ${operationLeases.key} = ${key} and ${operationLeases.token} = ${token} and ${operationLeases.expiresAt} > ${DATABASE_NOW})`;
}

/**
 * Leases that make an operation exclusive across backend processes, not only
 * within one: rows of `operation_leases` (key, token, holder, data, expiry).
 *
 * Every change to a lease row runs in a short transaction that takes
 * `pg_advisory_xact_lock` on the key, reads the row and then writes it: claims
 * are check-then-write without a race. No database lock or connection is held
 * while the leased operation itself runs (network calls included); the holder
 * renews the expiry instead (`hold`), so the lease of a process that stopped
 * lapses after `ttlMs`. Expiry is written and compared by the database clock
 * only. Housekeeping deletes rows long past their expiry.
 */
export class OperationLeaseStore {
  readonly ttlMs: number;
  readonly heartbeatMs: number;

  constructor(
    private readonly db: DrizzleClient,
    options: { ttlMs?: number; heartbeatMs?: number } = {}
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.ttlMs / 3));
  }

  /**
   * Claims every key for one new token, or none. A live lease on any key
   * refuses the claim (and is returned), unless `replaceable` allows taking it
   * over, for example an operation that has finished already.
   */
  async claim<T>(
    keys: readonly string[],
    data: T,
    options: {
      /** Recorded on the lease; defaults to this process. */
      holder?: string;
      replaceable?: (lease: OperationLease<T>, key: string) => boolean;
    } = {}
  ): Promise<OperationLeaseClaim<T>> {
    const sorted = [...new Set(keys)].sort();
    const claimedAt = performance.now();
    return this.db.transaction(async (tx) => {
      await this.lock(tx, sorted);
      const current = await this.readRows<T>(tx, sorted);
      for (const key of sorted) {
        const lease = current.get(key);
        if (lease?.live && !options.replaceable?.(lease, key)) {
          return { acquired: false as const, key, lease };
        }
      }
      const token = randomUUID();
      const lease = { token, holder: options.holder ?? OPERATION_LEASE_PROCESS, data };
      for (const key of sorted) await this.write(tx, key, lease, this.ttlMs);
      return { acquired: true as const, token, claimedAt };
    });
  }

  /** The lease stored under `key`, live or not (see `live`). Takes no lock. */
  async read<T>(key: string): Promise<OperationLease<T> | null> {
    return (await this.readRows<T>(this.db, [key])).get(key) ?? null;
  }

  /**
   * Extends the expiry of the keys `token` still holds to a full TTL from now;
   * returns those keys. A lease that lapsed without anyone taking it over is
   * still the token's: nobody else acted as its owner meanwhile.
   */
  async renew(keys: readonly string[], token: string): Promise<string[]> {
    const sorted = [...new Set(keys)].sort();
    if (sorted.length === 0) return [];
    return this.db.transaction(async (tx) => {
      await this.lock(tx, sorted);
      const current = await this.readRows<unknown>(tx, sorted);
      const renewed: string[] = [];
      for (const key of sorted) {
        const lease = current.get(key);
        if (lease?.token !== token) continue;
        await this.write(tx, key, lease, this.ttlMs);
        renewed.push(key);
      }
      return renewed;
    });
  }

  /**
   * Ends `token`'s lease on the keys it still holds. With `finish`, the row
   * stays for `retainMs` (by the database clock) carrying `finish.data`, for
   * callers waiting on the outcome; otherwise it is deleted.
   */
  async release<T>(keys: readonly string[], token: string, finish?: { data: T; retainMs: number }): Promise<void> {
    const sorted = [...new Set(keys)].sort();
    if (sorted.length === 0) return;
    await this.db.transaction(async (tx) => {
      await this.lock(tx, sorted);
      const current = await this.readRows<unknown>(tx, sorted);
      const owned = sorted.filter((key) => current.get(key)?.token === token);
      if (owned.length === 0) return;
      if (!finish) {
        await tx
          .delete(operationLeases)
          .where(and(inArray(operationLeases.key, owned), eq(operationLeases.token, token)));
        return;
      }
      for (const key of owned) {
        await this.write(tx, key, { ...current.get(key)!, data: finish.data }, finish.retainMs);
      }
    });
  }

  /**
   * Renews `token`'s lease on the current `keys()` every heartbeat until
   * `stop`, and reports when it is lost: a renewal finds a key that another
   * token holds now, or renewals have not confirmed the lease for a full TTL
   * (the database was unreachable, or the event loop blocked), so another
   * process may have taken it. Then `onLost` gets each lost key, `signal` is
   * aborted, `lost` turns true and renewals stop: the running operation must
   * no longer act as the owner. Check `lost` (or `confirm()`) before a step
   * only the owner may take; guard owner-only writes with `operationLeaseHeld`.
   *
   * `since` is the claim's `claimedAt`: the lease is known to last a TTL from
   * then, not from this call.
   */
  hold(
    keys: () => readonly string[],
    token: string,
    onLost?: (key: string) => void,
    options: { since?: number } = {}
  ): OperationLeaseHold {
    const ttlMs = this.ttlMs;
    const controller = new AbortController();
    // Local elapsed time since a renewal known to have extended the lease was
    // sent: the lease lasts at least a TTL from then by any clock.
    let confirmedAt = options.since ?? performance.now();
    let stopped = false;
    let renewing = false;

    const lose = (lostKeys: readonly string[], kind: OperationLeaseLostError['kind']) => {
      if (stopped || controller.signal.aborted) return;
      clearInterval(timer);
      logger.warn('An operation lease was lost; its operation no longer owns the keys', { keys: lostKeys, kind });
      controller.abort(new OperationLeaseLostError(lostKeys, kind));
      for (const key of lostKeys) onLost?.(key);
    };
    const isLost = () => {
      if (!stopped && !controller.signal.aborted && performance.now() - confirmedAt >= ttlMs) {
        const current = [...keys()];
        if (current.length > 0) lose(current, 'unconfirmed');
      }
      return controller.signal.aborted;
    };
    const renewNow = async (): Promise<boolean> => {
      const wanted = [...keys()];
      if (wanted.length === 0) return !controller.signal.aborted;
      const sentAt = performance.now();
      const renewed = await this.renew(wanted, token);
      if (controller.signal.aborted) return false;
      // A key released meanwhile was given up, not lost.
      const current = keys();
      const lostKeys = wanted.filter((key) => !renewed.includes(key) && current.includes(key));
      if (lostKeys.length > 0) {
        lose(lostKeys, 'taken-over');
        return false;
      }
      confirmedAt = Math.max(confirmedAt, sentAt);
      return true;
    };

    const timer = setInterval(() => {
      if (stopped || isLost() || renewing) return;
      renewing = true;
      void renewNow()
        .catch((error) =>
          logger.warn('Could not renew an operation lease', {
            keys: [...keys()],
            error: error instanceof Error ? error.message : String(error),
          })
        )
        .finally(() => {
          renewing = false;
        });
    }, this.heartbeatMs);
    timer.unref?.();

    return {
      signal: controller.signal,
      get lost() {
        return isLost();
      },
      async confirm() {
        if (stopped || isLost()) return false;
        return renewNow();
      },
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async lock(tx: DrizzleExecutor, sortedKeys: readonly string[]) {
    for (const key of sortedKeys) {
      await tx.execute(sql`select pg_advisory_xact_lock(${OPERATION_LEASE_LOCK_NAMESPACE}, hashtext(${key}))`);
    }
  }

  private async readRows<T>(executor: DrizzleExecutor, keys: readonly string[]) {
    const rows = await executor
      .select({
        key: operationLeases.key,
        token: operationLeases.token,
        holder: operationLeases.holder,
        data: operationLeases.data,
        expiresAt: operationLeases.expiresAt,
        live: sql<boolean>`${operationLeases.expiresAt} > ${DATABASE_NOW}`,
      })
      .from(operationLeases)
      .where(inArray(operationLeases.key, [...keys]));
    return new Map<string, OperationLease<T>>(
      rows.map((row) => [
        row.key,
        {
          token: row.token,
          holder: row.holder,
          expiresAt: new Date(row.expiresAt),
          live: row.live === true,
          data: row.data as T,
        },
      ])
    );
  }

  /** Writes a lease row that expires `ttlMs` from now by the database clock. */
  private async write(
    tx: DrizzleExecutor,
    key: string,
    lease: Pick<OperationLease<unknown>, 'token' | 'holder' | 'data'>,
    ttlMs: number
  ) {
    const values = { token: lease.token, holder: lease.holder, data: lease.data, expiresAt: expiresIn(ttlMs) };
    await tx
      .insert(operationLeases)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: operationLeases.key, set: values });
  }
}
