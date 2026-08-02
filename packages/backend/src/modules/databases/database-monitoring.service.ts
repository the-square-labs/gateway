import { EventEmitter } from 'node:events';
import { createChildLogger } from '@/lib/logger.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type {
  DatabaseConnectionConfig,
  DatabaseConnectionService,
  DatabaseHealthStatus,
  DatabaseType,
} from './databases.service.js';
import type { ManagedDatabaseRuntimeStats, ManagedDatabaseService } from './managed-databases.service.js';

const logger = createChildLogger('DatabaseMonitoringService');

const HISTORY_PREFIX = 'database-monitoring:';
const HISTORY_MAX = 60;
const HISTORY_TTL_SECONDS = 600;

export interface DatabaseMetricSnapshot {
  timestamp: string;
  databaseId: string;
  type: DatabaseType;
  name: string;
  status: DatabaseHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}

export class DatabaseMonitoringService extends EventEmitter {
  private evaluator?: NotificationEvaluatorService;
  private readonly clientCounts = new Map<string, number>();
  private readonly pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private backgroundInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly databaseService: DatabaseConnectionService,
    private readonly cacheService: CacheService | null,
    private readonly managedDatabaseService?: ManagedDatabaseService
  ) {
    super();
    this.setMaxListeners(100);
    this.startBackgroundPolling();
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  async getHistory(databaseId: string): Promise<DatabaseMetricSnapshot[]> {
    if (!this.cacheService) return [];
    try {
      const raw = await this.cacheService.getClient().lrange(HISTORY_PREFIX + databaseId, 0, -1);
      return raw.map((entry) => JSON.parse(entry) as DatabaseMetricSnapshot).reverse();
    } catch {
      return [];
    }
  }

  registerClient(databaseId: string): void {
    const count = (this.clientCounts.get(databaseId) ?? 0) + 1;
    this.clientCounts.set(databaseId, count);
    if (count === 1) this.startPolling(databaseId);
  }

  unregisterClient(databaseId: string): void {
    const count = Math.max(0, (this.clientCounts.get(databaseId) ?? 0) - 1);
    this.clientCounts.set(databaseId, count);
    if (count === 0) this.stopPolling(databaseId);
  }

  destroy(): void {
    if (this.backgroundInterval) clearInterval(this.backgroundInterval);
    for (const interval of this.pollIntervals.values()) clearInterval(interval);
    this.pollIntervals.clear();
  }

  private startBackgroundPolling() {
    setTimeout(() => {
      this.backgroundInterval = setInterval(() => {
        this.databaseService
          .listAllRows()
          .then((rows) => {
            for (const row of rows) {
              if (this.pollIntervals.has(row.id)) continue;
              void this.pollOnce(row.id);
            }
          })
          .catch((error) => {
            logger.warn('Background database polling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 10_000);
    }, 5000);
  }

  private startPolling(databaseId: string) {
    if (this.pollIntervals.has(databaseId)) return;
    void this.pollOnce(databaseId);
    this.pollIntervals.set(
      databaseId,
      setInterval(() => void this.pollOnce(databaseId), 5000)
    );
  }

  private stopPolling(databaseId: string) {
    const interval = this.pollIntervals.get(databaseId);
    if (!interval) return;
    clearInterval(interval);
    this.pollIntervals.delete(databaseId);
  }

  private async pollOnce(databaseId: string) {
    try {
      const connection = await this.databaseService.get(databaseId);
      if (connection.managed?.status === 'paused') return;
      const config = await this.databaseService.getDecryptedConfig(databaseId);
      const snapshot =
        config.type === 'postgres'
          ? await this.collectPostgresSnapshot(databaseId, connection.name)
          : config.type === 'clickhouse'
            ? await this.collectClickHouseSnapshot(databaseId, connection.name, config.database)
            : await this.collectRedisSnapshot(databaseId, connection.name, config);

      const managedRuntime = this.managedDatabaseService
        ? await this.managedDatabaseService.getRuntimeStatsByDatabaseConnectionId(databaseId).catch((error) => {
            logger.debug('Managed database runtime stats unavailable', {
              databaseId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
        : null;
      if (managedRuntime) this.attachManagedRuntimeMetrics(snapshot, managedRuntime);

      await this.pushHistory(snapshot);
      await this.databaseService.updateHealth(databaseId, {
        status: snapshot.status,
        responseMs: snapshot.responseMs,
        lastError: snapshot.status === 'offline' ? 'Database is unreachable' : null,
      });
      await this.evaluator?.evaluateDatabaseSnapshot(snapshot);
      await this.evaluator?.observeStatefulEvent(
        this.notificationCategory(snapshot.type),
        snapshot.status === 'online'
          ? 'health.online'
          : snapshot.status === 'degraded'
            ? 'health.degraded'
            : 'health.offline',
        { type: 'database', id: databaseId, name: connection.name },
        { health_status: snapshot.status }
      );
      this.emit('snapshot', { databaseId, snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Monitoring failed';
      logger.debug('Database monitoring poll failed', { databaseId, error: message });
      const connection = await this.databaseService.get(databaseId).catch(() => null);
      await this.databaseService.updateHealth(databaseId, {
        status: 'offline',
        lastError: message,
        forceHistory: true,
      });
      if (connection) {
        await this.evaluator?.observeStatefulEvent(
          this.notificationCategory(connection.type),
          'health.offline',
          { type: 'database', id: databaseId, name: connection.name },
          { health_status: 'offline', error: message }
        );
      }
    }
  }

  private async pushHistory(snapshot: DatabaseMetricSnapshot) {
    if (!this.cacheService) return;
    const client = this.cacheService.getClient();
    const key = HISTORY_PREFIX + snapshot.databaseId;
    await client.lpush(key, JSON.stringify(snapshot));
    await client.ltrim(key, 0, HISTORY_MAX - 1);
    await client.expire(key, HISTORY_TTL_SECONDS);
  }

  private attachManagedRuntimeMetrics(snapshot: DatabaseMetricSnapshot, runtime: ManagedDatabaseRuntimeStats) {
    snapshot.metrics.managed_cpu_percent = runtime.cpuPercent;
    snapshot.metrics.managed_memory_usage_bytes = runtime.memoryUsageBytes;
    snapshot.metrics.managed_memory_limit_bytes = runtime.memoryLimitBytes;
    snapshot.metrics.managed_swap_usage_bytes = runtime.swapUsageBytes;
    snapshot.metrics.managed_swap_limit_bytes = runtime.swapLimitBytes;
    snapshot.metrics.managed_pids = runtime.pids;
  }

  private async getLatestSnapshot(databaseId: string): Promise<DatabaseMetricSnapshot | null> {
    const history = await this.getHistory(databaseId);
    return history.at(-1) ?? null;
  }

  private async collectPostgresSnapshot(databaseId: string, name: string): Promise<DatabaseMetricSnapshot> {
    const pool = await this.databaseService.getPostgresPool(databaseId);
    const started = Date.now();
    const previousSnapshot = await this.getLatestSnapshot(databaseId);
    const versionResult = await pool.query<{ server_version_num: string }>('show server_version_num');
    const serverVersion = Number(versionResult.rows[0]?.server_version_num ?? 0);
    // PostgreSQL 17 moved checkpoint counters out of pg_stat_bgwriter into
    // pg_stat_checkpointer. Keep the total metric compatible with both view
    // layouts so a successful connection is never marked offline just because
    // a non-essential monitoring query changed between major versions.
    const blocksWrittenQuery =
      serverVersion >= 170_000
        ? `select (bgwriter.buffers_clean + checkpointer.buffers_written)::text as blocks_written
             from pg_stat_bgwriter bgwriter
             cross join pg_stat_checkpointer checkpointer`
        : `select (buffers_checkpoint + buffers_clean + buffers_backend)::text as blocks_written
             from pg_stat_bgwriter`;
    const [pingResult, statsResult, dbSizeResult, lockResult, bgwriterResult] = await Promise.all([
      pool.query('select 1'),
      pool.query<{
        active_connections: string;
        total_connections: string;
        max_connections: string;
        long_running_queries: string;
        idle_connections: string;
      }>(
        `select
           sum(case when state = 'active' then 1 else 0 end)::text as active_connections,
           sum(case when state = 'idle' then 1 else 0 end)::text as idle_connections,
           count(*)::text as total_connections,
           sum(case when state = 'active' and now() - query_start > interval '1 minute' then 1 else 0 end)::text as long_running_queries,
           current_setting('max_connections')::text as max_connections
         from pg_stat_activity
        where datname = current_database()`
      ),
      pool.query<{
        database_size: string;
        xact_commit: string;
        xact_rollback: string;
        blks_read: string;
        blks_hit: string;
      }>(
        `select
           pg_database_size(current_database())::text as database_size,
           xact_commit::text as xact_commit,
           xact_rollback::text as xact_rollback,
           blks_read::text as blks_read,
           blks_hit::text as blks_hit
         from pg_stat_database
        where datname = current_database()`
      ),
      pool.query<{ lock_count: string }>(
        `select count(*)::text as lock_count
         from pg_locks l
         join pg_database d on d.oid = l.database
        where d.datname = current_database()`
      ),
      pool.query<{ blocks_written: string }>(blocksWrittenQuery),
    ]);
    void pingResult;
    const responseMs = Date.now() - started;
    const activeConnections = Number(statsResult.rows[0]?.active_connections ?? 0);
    const idleConnections = Number(statsResult.rows[0]?.idle_connections ?? 0);
    const totalConnections = Number(statsResult.rows[0]?.total_connections ?? 0);
    const maxConnections = Number(statsResult.rows[0]?.max_connections ?? 0);
    const longRunningQueries = Number(statsResult.rows[0]?.long_running_queries ?? 0);
    const lockCount = Number(lockResult.rows[0]?.lock_count ?? 0);
    const activeConnectionsPct = maxConnections > 0 ? (activeConnections / maxConnections) * 100 : 0;
    const totalConnectionsPct = maxConnections > 0 ? (totalConnections / maxConnections) * 100 : 0;
    const xactCommit = Number(dbSizeResult.rows[0]?.xact_commit ?? 0);
    const xactRollback = Number(dbSizeResult.rows[0]?.xact_rollback ?? 0);
    const xactTotal = xactCommit + xactRollback;
    const blocksReadTotal = Number(dbSizeResult.rows[0]?.blks_read ?? 0);
    const blocksHitTotal = Number(dbSizeResult.rows[0]?.blks_hit ?? 0);
    const blocksWrittenTotal = Number(bgwriterResult.rows[0]?.blocks_written ?? 0);
    const cacheHitRatio =
      blocksReadTotal + blocksHitTotal > 0 ? (blocksHitTotal / (blocksReadTotal + blocksHitTotal)) * 100 : null;
    const previousAt = previousSnapshot ? Date.parse(previousSnapshot.timestamp) : null;
    const elapsedSeconds =
      previousAt && Number.isFinite(previousAt) ? Math.max((Date.now() - previousAt) / 1000, 1) : null;
    const previousXactTotal = Number(previousSnapshot?.metrics.xact_total ?? 0);
    const previousBlocksReadTotal = Number(previousSnapshot?.metrics.blocks_read_total ?? 0);
    const previousBlocksWrittenTotal = Number(previousSnapshot?.metrics.blocks_written_total ?? 0);
    const transactionRate =
      elapsedSeconds != null ? Math.max(0, (xactTotal - previousXactTotal) / elapsedSeconds) : null;
    const readBlocksPerSec =
      elapsedSeconds != null ? Math.max(0, (blocksReadTotal - previousBlocksReadTotal) / elapsedSeconds) : null;
    const writeBlocksPerSec =
      elapsedSeconds != null ? Math.max(0, (blocksWrittenTotal - previousBlocksWrittenTotal) / elapsedSeconds) : null;
    const status: DatabaseHealthStatus = responseMs >= 1000 ? 'degraded' : 'online';
    return {
      timestamp: new Date().toISOString(),
      databaseId,
      type: 'postgres',
      name,
      status,
      responseMs,
      metrics: {
        latency_ms: responseMs,
        active_connections: activeConnections,
        idle_connections: idleConnections,
        total_connections: totalConnections,
        max_connections: maxConnections,
        active_connections_pct: activeConnectionsPct,
        total_connections_pct: totalConnectionsPct,
        long_running_queries: longRunningQueries,
        lock_count: lockCount,
        transaction_rate: transactionRate,
        cache_hit_ratio: cacheHitRatio,
        read_blocks_per_sec: readBlocksPerSec,
        write_blocks_per_sec: writeBlocksPerSec,
        database_size_bytes: Number(dbSizeResult.rows[0]?.database_size ?? 0),
        database_size_mb: Number(dbSizeResult.rows[0]?.database_size ?? 0) / (1024 * 1024),
        xact_total: xactTotal,
        blocks_read_total: blocksReadTotal,
        blocks_written_total: blocksWrittenTotal,
      },
    };
  }

  private async collectRedisSnapshot(
    databaseId: string,
    name: string,
    config: Extract<DatabaseConnectionConfig, { type: 'redis' }>
  ): Promise<DatabaseMetricSnapshot> {
    const client = await this.databaseService.getRedisClient(databaseId);
    const started = Date.now();
    await client.ping();
    const infoRaw = await client.info('memory');
    const clientsRaw = await client.info('clients');
    const statsRaw = await client.info('stats');
    const dbSize = await client.dbsize();
    const responseMs = Date.now() - started;
    const info = this.parseRedisInfo(infoRaw);
    const clients = this.parseRedisInfo(clientsRaw);
    const stats = this.parseRedisInfo(statsRaw);
    const usedMemory = Number(info.used_memory ?? 0);
    const maxMemory = Number(info.maxmemory ?? 0);
    const memoryPct = maxMemory > 0 ? (usedMemory / maxMemory) * 100 : 0;
    const status: DatabaseHealthStatus = responseMs >= 1000 ? 'degraded' : 'online';
    return {
      timestamp: new Date().toISOString(),
      databaseId,
      type: 'redis',
      name,
      status,
      responseMs,
      metrics: {
        latency_ms: responseMs,
        used_memory_bytes: usedMemory,
        maxmemory_bytes: maxMemory,
        memory_pct: memoryPct,
        connected_clients: Number(clients.connected_clients ?? 0),
        instantaneous_ops_per_sec: Number(stats.instantaneous_ops_per_sec ?? 0),
        key_count: dbSize,
        redis_db: config.db,
      },
    };
  }

  private async collectClickHouseSnapshot(
    databaseId: string,
    name: string,
    database: string
  ): Promise<DatabaseMetricSnapshot> {
    const client = await this.databaseService.getClickHouseClient(databaseId);
    const started = Date.now();
    const ping = await client.ping();
    if (!ping.success) throw ping.error;
    const previousSnapshot = await this.getLatestSnapshot(databaseId);
    const queryRows = async <T extends Record<string, unknown>>(
      metricGroup: string,
      query: string,
      queryParams?: Record<string, unknown>
    ) => {
      try {
        const result = await client.query({
          query,
          format: 'JSONEachRow',
          query_params: queryParams,
          clickhouse_settings: { max_execution_time: 5, readonly: '1', log_queries: 0 },
        });
        return await result.json<T>();
      } catch (error) {
        logger.debug('ClickHouse monitoring metric group unavailable', {
          databaseId,
          metricGroup,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    };
    const [partsRows, processRows, activityRows, diskRows] = await Promise.all([
      queryRows<{
        rows: string;
        bytes: string;
        active_parts: string;
      }>(
        'parts',
        `SELECT sum(rows) AS rows, sum(bytes_on_disk) AS bytes, count() AS active_parts
           FROM system.parts
          WHERE active AND database = {database: String}`,
        { database }
      ),
      queryRows<{ running_queries: string; memory_usage: string }>(
        'processes',
        `SELECT count() AS running_queries, sum(memory_usage) AS memory_usage FROM system.processes`
      ),
      queryRows<{ merges: string; pending_mutations: string; query_total: string }>(
        'activity',
        `SELECT
           (SELECT count() FROM system.merges WHERE database = {database: String}) AS merges,
           (SELECT count() FROM system.mutations WHERE database = {database: String} AND NOT is_done) AS pending_mutations,
           (SELECT sum(value) FROM system.events WHERE event = 'Query') AS query_total`,
        { database }
      ),
      queryRows<{ disk_total: string; disk_free: string; disk_unreserved: string }>(
        'disks',
        `SELECT
           sum(total_space) AS disk_total,
           sum(free_space) AS disk_free,
           sum(unreserved_space) AS disk_unreserved
         FROM system.disks`
      ),
    ]);
    const responseMs = Date.now() - started;
    const parts = partsRows[0];
    const processes = processRows[0];
    const activity = activityRows[0];
    const disks = diskRows[0];
    const queryTotal = Number(activity?.query_total ?? 0);
    const previousQueryTotal = Number(previousSnapshot?.metrics.query_total ?? 0);
    const previousAt = previousSnapshot ? Date.parse(previousSnapshot.timestamp) : null;
    const elapsedSeconds =
      previousAt && Number.isFinite(previousAt) ? Math.max((Date.now() - previousAt) / 1000, 1) : null;
    const queryRate = elapsedSeconds == null ? null : Math.max(0, (queryTotal - previousQueryTotal) / elapsedSeconds);
    const diskTotal = Number(disks?.disk_total ?? 0);
    const diskFree = Number(disks?.disk_free ?? 0);
    const diskUnreserved = Number(disks?.disk_unreserved ?? disks?.disk_free ?? 0);
    const status: DatabaseHealthStatus = responseMs >= 1000 ? 'degraded' : 'online';
    return {
      timestamp: new Date().toISOString(),
      databaseId,
      type: 'clickhouse',
      name,
      status,
      responseMs,
      metrics: {
        latency_ms: responseMs,
        database_size_bytes: parts ? Number(parts.bytes ?? 0) : null,
        database_size_mb: parts ? Number(parts.bytes ?? 0) / (1024 * 1024) : null,
        row_count: parts ? Number(parts.rows ?? 0) : null,
        active_parts: parts ? Number(parts.active_parts ?? 0) : null,
        running_queries: processes ? Number(processes.running_queries ?? 0) : null,
        memory_usage_bytes: processes ? Number(processes.memory_usage ?? 0) : null,
        active_merges: activity ? Number(activity.merges ?? 0) : null,
        pending_mutations: activity ? Number(activity.pending_mutations ?? 0) : null,
        query_rate: queryRate,
        query_total: activity ? queryTotal : null,
        disk_total_bytes: disks ? diskTotal : null,
        disk_free_bytes: disks ? diskFree : null,
        disk_unreserved_bytes: disks ? diskUnreserved : null,
        disk_available_mb: disks ? diskUnreserved / (1024 * 1024) : null,
        disk_used_pct: disks && diskTotal > 0 ? ((diskTotal - diskFree) / diskTotal) * 100 : null,
      },
    };
  }

  private notificationCategory(type: DatabaseType) {
    if (type === 'postgres') return 'database_postgres' as const;
    if (type === 'clickhouse') return 'database_clickhouse' as const;
    return 'database_redis' as const;
  }

  private parseRedisInfo(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#') || !line.includes(':')) continue;
      const [key, value] = line.trim().split(':', 2);
      out[key] = value;
    }
    return out;
  }
}
