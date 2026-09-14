import { EventEmitter } from 'node:events';
import { createChildLogger } from '@/lib/logger.js';
import type { CacheService } from '@/services/cache.service.js';
import type { ManagedStorageMetricsProvider } from './managed-storage-metrics-provider.js';
import type {
  ObjectStorageConnectionView,
  ObjectStorageHealthStatus,
  ObjectStorageService,
} from './object-storage.service.js';

const logger = createChildLogger('ObjectStorageMonitoringService');

const HISTORY_PREFIX = 'object-storage-monitoring:';
const HISTORY_MAX = 60;
const HISTORY_TTL_SECONDS = 600;
const SLOW_THRESHOLD_MS = 2_000;
// Each poll is a billable S3 ListBuckets against the provider, so the fleet-wide
// background sweep is deliberately slow. Connections with an open detail view are
// polled far more frequently via registerClient()/ACTIVE_POLL_MS.
const BACKGROUND_POLL_MS = 60_000;
const ACTIVE_POLL_MS = 5_000;

export interface StorageMetricSnapshot {
  timestamp: string;
  storageId: string;
  provider: string;
  name: string;
  status: ObjectStorageHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}

export class ObjectStorageMonitoringService extends EventEmitter {
  private readonly clientCounts = new Map<string, number>();
  private readonly pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private backgroundStart: ReturnType<typeof setTimeout> | null = null;
  private backgroundInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly storageService: ObjectStorageService,
    private readonly cacheService: CacheService | null,
    // Optional so existing call sites keep compiling; when absent, snapshots
    // carry only the latency and bucket-count metrics they always have.
    private readonly managedMetrics?: ManagedStorageMetricsProvider
  ) {
    super();
    this.setMaxListeners(100);
    this.startBackgroundPolling();
  }

  /**
   * Resource metrics for a managed cluster, read from the node health reports
   * the daemon already streams in. Failures are swallowed: a missing metric
   * must never turn a healthy storage connection into a failed poll.
   */
  private async resourceMetrics(connection: ObjectStorageConnectionView): Promise<Record<string, number | null>> {
    if (!this.managedMetrics || !connection.managed) return {};
    try {
      return (await this.managedMetrics.getMetrics(connection.managed.id)) ?? {};
    } catch (error) {
      logger.debug('Managed storage metrics unavailable', {
        storageId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  async getHistory(storageId: string): Promise<StorageMetricSnapshot[]> {
    if (!this.cacheService) return [];
    try {
      const raw = await this.cacheService.getClient().lrange(HISTORY_PREFIX + storageId, 0, -1);
      return raw.map((entry) => JSON.parse(entry) as StorageMetricSnapshot).reverse();
    } catch {
      return [];
    }
  }

  registerClient(storageId: string): void {
    const count = (this.clientCounts.get(storageId) ?? 0) + 1;
    this.clientCounts.set(storageId, count);
    if (count === 1) this.startPolling(storageId);
  }

  unregisterClient(storageId: string): void {
    const count = Math.max(0, (this.clientCounts.get(storageId) ?? 0) - 1);
    this.clientCounts.set(storageId, count);
    if (count === 0) this.stopPolling(storageId);
  }

  destroy(): void {
    if (this.backgroundStart) clearTimeout(this.backgroundStart);
    if (this.backgroundInterval) clearInterval(this.backgroundInterval);
    for (const interval of this.pollIntervals.values()) clearInterval(interval);
    this.pollIntervals.clear();
  }

  private startBackgroundPolling() {
    this.backgroundStart = setTimeout(() => {
      this.backgroundInterval = setInterval(() => {
        this.storageService
          .listAllRows()
          .then((rows) => {
            for (const row of rows) {
              if (this.pollIntervals.has(row.id)) continue;
              void this.pollOnce(row.id);
            }
          })
          .catch((error) => {
            logger.warn('Background storage polling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, BACKGROUND_POLL_MS);
    }, 5000);
  }

  private startPolling(storageId: string) {
    if (this.pollIntervals.has(storageId)) return;
    void this.pollOnce(storageId);
    this.pollIntervals.set(
      storageId,
      setInterval(() => void this.pollOnce(storageId), ACTIVE_POLL_MS)
    );
  }

  private stopPolling(storageId: string) {
    const interval = this.pollIntervals.get(storageId);
    if (!interval) return;
    clearInterval(interval);
    this.pollIntervals.delete(storageId);
  }

  private async pollOnce(storageId: string) {
    let connection: ObjectStorageConnectionView | null = null;
    try {
      connection = await this.storageService.get(storageId);
      const started = Date.now();
      const buckets = await this.storageService.listBuckets(storageId);
      const responseMs = Date.now() - started;
      const status: ObjectStorageHealthStatus = responseMs > SLOW_THRESHOLD_MS ? 'degraded' : 'online';
      const snapshot: StorageMetricSnapshot = {
        timestamp: new Date().toISOString(),
        storageId,
        provider: connection.provider,
        name: connection.name,
        status,
        responseMs,
        metrics: {
          latency_ms: responseMs,
          bucket_count: buckets.length,
          ...(await this.resourceMetrics(connection)),
        },
      };
      await this.pushHistory(snapshot);
      await this.storageService.updateHealth(storageId, { status, responseMs, lastError: null });
      this.emit('snapshot', { storageId, snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Monitoring failed';
      logger.debug('Storage monitoring poll failed', { storageId, error: message });
      await this.storageService
        .updateHealth(storageId, { status: 'offline', lastError: message, forceHistory: true })
        .catch(() => {});
      const snapshot: StorageMetricSnapshot = {
        timestamp: new Date().toISOString(),
        storageId,
        provider: connection?.provider ?? 'other',
        name: connection?.name ?? storageId,
        status: 'offline',
        responseMs: 0,
        metrics: { latency_ms: null, bucket_count: null },
      };
      await this.pushHistory(snapshot).catch(() => {});
      this.emit('snapshot', { storageId, snapshot });
    }
  }

  private async pushHistory(snapshot: StorageMetricSnapshot) {
    if (!this.cacheService) return;
    const client = this.cacheService.getClient();
    const key = HISTORY_PREFIX + snapshot.storageId;
    await client.lpush(key, JSON.stringify(snapshot));
    await client.ltrim(key, 0, HISTORY_MAX - 1);
    await client.expire(key, HISTORY_TTL_SECONDS);
  }
}
