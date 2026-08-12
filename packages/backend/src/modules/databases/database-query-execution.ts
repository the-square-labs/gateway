import type Redis from 'ioredis';
import type pg from 'pg';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { hashDatabasePreview } from './database-connection-view.js';
import type { DatabaseOperation } from './database-error-mapping.js';
import {
  inferPostgresIntent,
  inferRedisSingleCommandIntent,
  splitPostgresStatements,
  splitRedisCommands,
  tokenizeRedisCommand,
} from './database-query-intent.js';
import { compactCommandResult, compactPostgresRows, estimateJsonBytes } from './database-result-compaction.js';
import type { SqlExecutionOptions } from './sql-database-adapter.js';

const DEFAULT_QUERY_BUDGET_MS = 15_000;
const POSTGRES_RESULT_SET_MAX = 10;
const POSTGRES_RESPONSE_MAX_BYTES = 768 * 1024;
const REDIS_COMMAND_MAX_COUNT = 20;
const REDIS_RESPONSE_MAX_BYTES = 512 * 1024;

export interface DatabaseQueryExecutionContext {
  withPostgresPool<T>(id: string, operation: DatabaseOperation, fn: (pool: pg.Pool) => Promise<T>): Promise<T>;
  withRedisClient<T>(id: string, operation: DatabaseOperation, fn: (client: Redis) => Promise<T>): Promise<T>;
  auditLog(entry: Parameters<AuditService['log']>[0]): Promise<void>;
  emitChange(id: string, action: string, extra?: Record<string, unknown>): void;
}

export async function executePostgresSql(
  context: DatabaseQueryExecutionContext,
  id: string,
  sqlText: string,
  userId: string,
  options: SqlExecutionOptions = {}
) {
  const maxRows = Math.min(Math.max(Math.trunc(options.maxRows ?? 500), 1), 2000);
  const statements = splitPostgresStatements(sqlText);
  const deadlineMs = options.deadlineMs ?? Date.now() + DEFAULT_QUERY_BUDGET_MS;
  if (statements.length > POSTGRES_RESULT_SET_MAX) {
    throw new AppError(
      400,
      'POSTGRES_STATEMENT_LIMIT_EXCEEDED',
      `Postgres SQL execution is limited to ${POSTGRES_RESULT_SET_MAX} statements per request`
    );
  }

  return context.withPostgresPool(id, 'query', async (pool) => {
    const client = await pool.connect();
    const entries: Array<pg.QueryResult & { durationMs: number }> = [];
    let responseTruncated = false;
    let cancelled = options.signal?.aborted ?? false;
    const processId = (client as pg.PoolClient & { processID?: number }).processID;
    const cancel = () => {
      cancelled = true;
      if (processId != null) {
        void pool.query('select pg_cancel_backend($1)', [processId]).catch(() => {});
      }
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      for (const [index, statement] of statements.entries()) {
        if (cancelled) {
          throw new AppError(499, 'DATABASE_QUERY_CANCELLED', 'Interactive query cancelled');
        }
        const remainingMs = deadlineMs - Date.now();
        const remainingStatements = statements.length - index;
        const statementTimeoutMs = Math.floor(remainingMs / remainingStatements);
        if (statementTimeoutMs <= 0) {
          throw new AppError(408, 'DATABASE_QUERY_BUDGET_EXCEEDED', 'Interactive query budget exhausted');
        }
        await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
        const start = Date.now();
        let entry: pg.QueryResult;
        try {
          entry = await client.query(statement);
        } catch (error) {
          if (cancelled || options.signal?.aborted) {
            throw new AppError(499, 'DATABASE_QUERY_CANCELLED', 'Interactive query cancelled');
          }
          throw error;
        }
        if (index < POSTGRES_RESULT_SET_MAX) {
          entries.push({ ...entry, durationMs: Date.now() - start });
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
    const results = [];
    for (const entry of entries) {
      const compacted = compactPostgresRows(entry.rows, maxRows);
      const next = {
        command: entry.command,
        rowCount: entry.rowCount ?? 0,
        durationMs: entry.durationMs,
        fields: entry.fields?.map((field: { name: string }) => field.name) ?? [],
        rows: compacted.rows,
        truncated: compacted.truncated,
        maxRows,
      };
      if (estimateJsonBytes([...results, next]) > POSTGRES_RESPONSE_MAX_BYTES) {
        responseTruncated = true;
        break;
      }
      results.push(next);
    }
    const intent = inferPostgresIntent(sqlText);
    await context.auditLog({
      userId,
      action: 'database.postgres.query',
      resourceType: 'database',
      resourceId: id,
      details: {
        intent,
        statementCount: statements.length,
        statementHash: hashDatabasePreview(sqlText),
        statementPreview: sqlText.trim().slice(0, 160),
      },
    });
    context.emitChange(id, 'query.executed', {
      provider: 'postgres',
      intent,
      statementCount: statements.length,
    });
    return { results, truncated: responseTruncated, resultLimit: POSTGRES_RESULT_SET_MAX };
  });
}

export async function executeRedisCommand(
  context: DatabaseQueryExecutionContext,
  id: string,
  commandText: string,
  userId: string
) {
  return context.withRedisClient(id, 'query', async (client) => {
    const commands = splitRedisCommands(commandText);
    const results = [];
    const intents = new Set<'read' | 'write' | 'admin'>();
    let responseTruncated = commands.length > REDIS_COMMAND_MAX_COUNT;
    for (const command of commands.slice(0, REDIS_COMMAND_MAX_COUNT)) {
      const parts = tokenizeRedisCommand(command);
      const commandName = parts[0]!.toUpperCase();
      const rawResult = await client.call(parts[0]!, ...parts.slice(1));
      const { result, truncated } = compactCommandResult(rawResult);
      const next = { command: commandName, result, truncated };
      if (estimateJsonBytes([...results, next]) > REDIS_RESPONSE_MAX_BYTES) {
        responseTruncated = true;
        break;
      }
      results.push(next);
      intents.add(inferRedisSingleCommandIntent(command));
    }
    const intent = intents.has('admin') ? 'admin' : intents.has('write') ? 'write' : 'read';
    await context.auditLog({
      userId,
      action: 'database.redis.command.execute',
      resourceType: 'database',
      resourceId: id,
      details: {
        intent,
        commandCount: commands.length,
        commands: results.slice(0, 5).map((entry) => entry.command),
        commandHash: hashDatabasePreview(commandText),
        commandPreview: commandText.slice(0, 160),
      },
    });
    context.emitChange(id, 'query.executed', {
      provider: 'redis',
      intent,
      commandCount: commands.length,
      commands: results.slice(0, 5).map((entry) => entry.command),
    });
    return { results, truncated: responseTruncated, commandLimit: REDIS_COMMAND_MAX_COUNT };
  });
}
