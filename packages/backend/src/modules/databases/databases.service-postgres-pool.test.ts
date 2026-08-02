import { describe, expect, it, vi } from 'vitest';

const poolState = vi.hoisted(() => ({
  instances: [] as Array<{ emit: (event: string, error: Error) => boolean; end: ReturnType<typeof vi.fn> }>,
}));

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  class FakePool extends EventEmitter {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);

    constructor() {
      super();
      poolState.instances.push(this);
    }
  }
  return { default: { Pool: FakePool } };
});

import { DatabaseConnectionService } from './databases.service.js';

describe('DatabaseConnectionService Postgres pools', () => {
  it('consumes an idle-client error and evicts the broken pool for a reconnect', async () => {
    poolState.instances.length = 0;
    const service = new DatabaseConnectionService({} as never, { log: vi.fn() } as never, {} as never);
    vi.spyOn(service, 'getDecryptedConfig').mockResolvedValue({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'app',
      username: 'app',
      password: 'password',
      sslEnabled: false,
    });

    await service.getPostgresPool('managed-db');
    const pool = poolState.instances[0]!;

    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    await Promise.resolve();

    expect((service as any).postgresPools.has('managed-db')).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
