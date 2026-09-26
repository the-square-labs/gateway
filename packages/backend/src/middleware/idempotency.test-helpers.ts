import { vi } from 'vitest';
import { container } from '@/container.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { CacheService } from '@/services/cache.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { IDEMPOTENCY_REDIS_SCRIPTS } from './idempotency.js';

interface Entry {
  value: string;
  expiresAt: number;
}

/** Just enough of ioredis for the idempotency store: SET PX NX, GET, and its three scripts. */
export class MemoryIdempotencyRedis {
  readonly entries = new Map<string, Entry>();
  commands = 0;

  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, _px: 'PX', ttlMs: number, nx?: 'NX'): Promise<'OK' | null> {
    this.commands += 1;
    if (nx === 'NX' && this.read(key) !== null) return null;
    this.entries.set(key, { value, expiresAt: Date.now() + Number(ttlMs) });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.commands += 1;
    return this.read(key);
  }

  async eval(script: string, _numKeys: number, key: string, ...args: string[]): Promise<number> {
    this.commands += 1;
    const [expected] = args;
    if (this.read(key) !== expected) return 0;
    if (script === IDEMPOTENCY_REDIS_SCRIPTS.complete) {
      this.entries.set(key, { value: args[1]!, expiresAt: Date.now() + Number(args[2]) });
      return 1;
    }
    if (script === IDEMPOTENCY_REDIS_SCRIPTS.release) {
      this.entries.delete(key);
      return 1;
    }
    if (script === IDEMPOTENCY_REDIS_SCRIPTS.extend) {
      this.entries.get(key)!.expiresAt = Date.now() + Number(args[1]);
      return 1;
    }
    throw new Error('Unexpected script');
  }

  records(): unknown[] {
    return [...this.entries.keys()].map((key) => JSON.parse(this.read(key) ?? 'null'));
  }

  /** Everything Redis holds, as one string, to prove plaintext never lands there. */
  dump(): string {
    return [...this.entries.values()].map((entry) => entry.value).join('\n');
  }
}

/** Redis that is down: every command fails. */
export class FailingIdempotencyRedis {
  commands = 0;

  async set(): Promise<never> {
    this.commands += 1;
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
  }

  async get(): Promise<never> {
    this.commands += 1;
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
  }

  async eval(): Promise<never> {
    this.commands += 1;
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
  }
}

export function registerIdempotencyRedis(redis: MemoryIdempotencyRedis | FailingIdempotencyRedis): void {
  container.registerInstance(CacheService, { getClient: () => redis } as unknown as CacheService);
}

/** The master-key encryption idempotency results are sealed with, plus a recording audit log. */
export function registerIdempotencyRuntime(): { auditLog: ReturnType<typeof vi.fn> } {
  container.registerInstance(CryptoService, new CryptoService('11'.repeat(32)));
  const auditLog = vi.fn().mockResolvedValue(true);
  container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);
  return { auditLog };
}
