import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  expiresAt: Date;
  data: T;
}

export type OperationLeaseClaim<T> =
  | { acquired: true; token: string }
  | { acquired: false; key: string; lease: OperationLease<T> };

/** Lease key for one resource of a namespace; long ids are hashed. */
export function operationLeaseKey(namespace: string, id: string): string {
  const key = `${namespace}:${id}`;
  if (key.length <= MAX_KEY_LENGTH) return key;
  return `${namespace}:sha256:${createHash('sha256').update(id).digest('hex')}`;
}

function isLive(lease: OperationLease<unknown>, now: number): boolean {
  return lease.expiresAt.getTime() > now;
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
 * lapses after `ttlMs`. Housekeeping deletes rows long past their expiry.
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
    return this.db.transaction(async (tx) => {
      await this.lock(tx, sorted);
      const current = await this.readRows<T>(tx, sorted);
      const now = Date.now();
      for (const key of sorted) {
        const lease = current.get(key);
        if (lease && isLive(lease, now) && !options.replaceable?.(lease, key)) {
          return { acquired: false as const, key, lease };
        }
      }
      const token = randomUUID();
      const lease: OperationLease<T> = {
        token,
        holder: options.holder ?? OPERATION_LEASE_PROCESS,
        expiresAt: new Date(now + this.ttlMs),
        data,
      };
      for (const key of sorted) await this.write(tx, key, lease);
      return { acquired: true as const, token };
    });
  }

  /** The lease stored under `key`, live or not. Takes no lock. */
  async read<T>(key: string): Promise<OperationLease<T> | null> {
    return (await this.readRows<T>(this.db, [key])).get(key) ?? null;
  }

  /** Extends the expiry of the keys `token` still holds; returns those keys. */
  async renew(keys: readonly string[], token: string): Promise<string[]> {
    const sorted = [...new Set(keys)].sort();
    if (sorted.length === 0) return [];
    return this.db.transaction(async (tx) => {
      await this.lock(tx, sorted);
      const current = await this.readRows<unknown>(tx, sorted);
      const expiresAt = new Date(Date.now() + this.ttlMs);
      const renewed: string[] = [];
      for (const key of sorted) {
        const lease = current.get(key);
        if (lease?.token !== token) continue;
        await this.write(tx, key, { ...lease, expiresAt });
        renewed.push(key);
      }
      return renewed;
    });
  }

  /**
   * Ends `token`'s lease on the keys it still holds. With `finish`, the row
   * stays for `retainMs` carrying `finish.data` (for callers waiting on the
   * outcome); otherwise it is deleted.
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
      const expiresAt = new Date(Date.now() + finish.retainMs);
      for (const key of owned) {
        await this.write(tx, key, { ...current.get(key)!, expiresAt, data: finish.data });
      }
    });
  }

  /**
   * Renews `token`'s lease on the current `keys()` every heartbeat until
   * `stop`. `onLost` gets a key the token no longer holds (its lease lapsed and
   * another process took it); the holder's own compare-and-set writes still
   * protect the resource then.
   */
  hold(keys: () => readonly string[], token: string, onLost?: (key: string) => void): { stop(): void } {
    let stopped = false;
    let running = false;
    const timer = setInterval(() => {
      if (stopped || running) return;
      const wanted = [...keys()];
      if (wanted.length === 0) return;
      running = true;
      void this.renew(wanted, token)
        .then((renewed) => {
          if (stopped) return;
          // A key released meanwhile was given up, not lost.
          const current = keys();
          for (const key of wanted) if (!renewed.includes(key) && current.includes(key)) onLost?.(key);
        })
        .catch((error) =>
          logger.warn('Could not renew an operation lease', {
            keys: wanted,
            error: error instanceof Error ? error.message : String(error),
          })
        )
        .finally(() => {
          running = false;
        });
    }, this.heartbeatMs);
    timer.unref?.();
    return {
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
      })
      .from(operationLeases)
      .where(inArray(operationLeases.key, [...keys]));
    return new Map<string, OperationLease<T>>(
      rows.map((row) => [
        row.key,
        { token: row.token, holder: row.holder, expiresAt: new Date(row.expiresAt), data: row.data as T },
      ])
    );
  }

  private async write(tx: DrizzleExecutor, key: string, lease: OperationLease<unknown>) {
    const values = { token: lease.token, holder: lease.holder, data: lease.data, expiresAt: lease.expiresAt };
    await tx
      .insert(operationLeases)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: operationLeases.key, set: values });
  }
}
