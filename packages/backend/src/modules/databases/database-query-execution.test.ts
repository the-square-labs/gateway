import { afterEach, describe, expect, it, vi } from 'vitest';
import { executePostgresSql } from './database-query-execution.js';

describe('executePostgresSql interactive budget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shares the remaining request budget between remaining statements', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'select 1') {
          now += 10_000;
          return { command: 'SELECT', rowCount: 1, fields: [], rows: [{ value: 1 }] };
        }
        if (sql === 'select 2') {
          return { command: 'SELECT', rowCount: 1, fields: [], rows: [{ value: 2 }] };
        }
        return {};
      }),
      release: vi.fn(),
    };
    const context = {
      withPostgresPool: async (_id: string, _operation: string, run: (pool: unknown) => Promise<unknown>) =>
        run({ connect: vi.fn().mockResolvedValue(client) }),
      withRedisClient: vi.fn(),
      auditLog: vi.fn().mockResolvedValue(undefined),
      emitChange: vi.fn(),
    };

    await executePostgresSql(context as never, 'db-1', 'select 1; select 2', 'user-1', {
      deadlineMs: 300_000,
    });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SET statement_timeout = 150000',
      'select 1',
      'SET statement_timeout = 290000',
      'select 2',
      'RESET statement_timeout',
    ]);
  });

  it('cancels the active Postgres backend when the HTTP request is aborted', async () => {
    const abortController = new AbortController();
    let rejectQuery: ((error: Error) => void) | undefined;
    const client = {
      processID: 42,
      query: vi.fn((sql: string) => {
        if (sql === 'select pg_sleep(60)') {
          return new Promise((_resolve, reject) => {
            rejectQuery = reject;
          });
        }
        return Promise.resolve({});
      }),
      release: vi.fn(),
    };
    const cancelQuery = vi.fn(async () => {
      rejectQuery?.(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
      return { rows: [{ pg_cancel_backend: true }] };
    });
    const context = {
      withPostgresPool: async (_id: string, _operation: string, run: (pool: unknown) => Promise<unknown>) =>
        run({ connect: vi.fn().mockResolvedValue(client), query: cancelQuery }),
      withRedisClient: vi.fn(),
      auditLog: vi.fn().mockResolvedValue(undefined),
      emitChange: vi.fn(),
    };

    const running = executePostgresSql(context as never, 'db-1', 'select pg_sleep(60)', 'user-1', {
      deadlineMs: Date.now() + 300_000,
      signal: abortController.signal,
    });
    const cancelled = expect(running).rejects.toMatchObject({
      statusCode: 499,
      code: 'DATABASE_QUERY_CANCELLED',
    });
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledWith('select pg_sleep(60)'));
    abortController.abort();

    await cancelled;
    expect(cancelQuery).toHaveBeenCalledWith('select pg_cancel_backend($1)', [42]);
    expect(client.release).toHaveBeenCalled();
  });
});
