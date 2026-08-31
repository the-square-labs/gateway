import { EventEmitter } from 'node:events';
import { createChildLogger } from '@/lib/logger.js';
import type { CacheService } from '@/services/cache.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

const logger = createChildLogger('NodeMonitoring');
const CONTAINER_STATS_KEY_PREFIX = 'container-stats:';
const CONTAINER_STATS_MAX = 30;
const CONTAINER_STATS_TTL = 600; // 10 minutes
const NODE_MONITORING_HISTORY_KEY_PREFIX = 'node-monitoring-history:v1:';
const NODE_MONITORING_HISTORY_TTL = 3_600; // 1 hour
const NODE_MONITORING_HISTORY_MAX = 60;

export const NODE_MONITORING_CADENCE_MS = {
  background: 10_000,
  stream: 5_000,
  focused: 2_000,
} as const;

export interface MonitoringSnapshot {
  timestamp: string;
  health: any;
  stats: any;
  traffic: any;
}

export function compactMonitoringHistorySnapshot(snapshot: any): MonitoringSnapshot {
  const health = snapshot?.health ?? {};
  const stats = snapshot?.stats ?? {};
  const traffic = snapshot?.traffic ?? null;
  return {
    timestamp: snapshot?.timestamp,
    health: {
      nginxRunning: health.nginxRunning,
      configValid: health.configValid,
      nginxUptimeSeconds: health.nginxUptimeSeconds,
      workerCount: health.workerCount,
      nginxVersion: health.nginxVersion,
      nginxRssBytes: health.nginxRssBytes,
      cpuPercent: health.cpuPercent,
      loadAverage1m: health.loadAverage1m,
      loadAverage5m: health.loadAverage5m,
      loadAverage15m: health.loadAverage15m,
      systemMemoryUsedBytes: health.systemMemoryUsedBytes,
      systemMemoryTotalBytes: health.systemMemoryTotalBytes,
      systemMemoryAvailableBytes: health.systemMemoryAvailableBytes,
      swapUsedBytes: health.swapUsedBytes,
      swapTotalBytes: health.swapTotalBytes,
      diskReadBytes: health.diskReadBytes,
      diskWriteBytes: health.diskWriteBytes,
      diskMounts: Array.isArray(health.diskMounts)
        ? health.diskMounts.map((mount: any) => ({
            mountPoint: mount.mountPoint,
            filesystem: mount.filesystem,
            device: mount.device,
            totalBytes: mount.totalBytes,
            usedBytes: mount.usedBytes,
            freeBytes: mount.freeBytes,
            usagePercent: mount.usagePercent,
          }))
        : undefined,
      diskUsagePercent: health.diskUsagePercent,
      networkRxBytes: health.networkRxBytes,
      networkTxBytes: health.networkTxBytes,
      networkInterfaces: health.networkInterfaces,
      gpuDevices: Array.isArray(health.gpuDevices) ? health.gpuDevices : undefined,
    },
    stats: {
      activeConnections: stats.activeConnections,
      accepts: stats.accepts,
      handled: stats.handled,
      requests: stats.requests,
      reading: stats.reading,
      writing: stats.writing,
      waiting: stats.waiting,
    },
    traffic,
  };
}

export class NodeMonitoringService extends EventEmitter {
  private history = new Map<string, MonitoringSnapshot[]>();
  private clientCounts = new Map<string, number>();
  private focusedClientCounts = new Map<string, number>();
  private pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private pollCadences = new Map<string, number>();
  private backgroundInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_HISTORY = NODE_MONITORING_HISTORY_MAX;
  private readonly BACKGROUND_POLL_INTERVAL = NODE_MONITORING_CADENCE_MS.background;
  private readonly STREAM_POLL_INTERVAL = NODE_MONITORING_CADENCE_MS.stream;
  private readonly ACTIVE_POLL_INTERVAL = NODE_MONITORING_CADENCE_MS.focused;

  constructor(
    private registry: NodeRegistryService,
    private cache?: CacheService
  ) {
    super();
    this.setMaxListeners(100);
    this.startBackgroundPolling();
  }

  /**
   * Background polling: collect health/stats for ALL connected nodes every 10s.
   * This ensures history is pre-populated before a user opens the monitoring page.
   * Stream consumers use 5s polling; an actively viewed Monitoring tab uses 2s.
   */
  private startBackgroundPolling(): void {
    // Delay start to let nodes connect first
    setTimeout(() => {
      this.backgroundInterval = setInterval(() => {
        const connectedNodes = this.registry.getConnectedNodeIds();
        for (const nodeId of connectedNodes) {
          // Skip nodes that already have stream-driven polling (2s or 5s)
          if (this.pollIntervals.has(nodeId)) continue;
          this.pollOnce(nodeId);
        }
      }, this.BACKGROUND_POLL_INTERVAL);
      logger.info('Background monitoring started for all connected nodes');
    }, 5000);
  }

  async getHistory(nodeId: string): Promise<MonitoringSnapshot[]> {
    let persisted: MonitoringSnapshot[] = [];
    if (this.cache) {
      try {
        const values = await this.cache.getClient().lrange(`${NODE_MONITORING_HISTORY_KEY_PREFIX}${nodeId}`, 0, -1);
        persisted = values.flatMap((value) => {
          try {
            return [JSON.parse(value) as MonitoringSnapshot];
          } catch {
            return [];
          }
        });
      } catch {
        // Redis is a read-model accelerator; retain the process-local fallback.
      }
    }
    const local = (this.history.get(nodeId) ?? []).map(compactMonitoringHistorySnapshot);
    const byTimestamp = new Map(persisted.map((snapshot) => [snapshot.timestamp, snapshot]));
    for (const snapshot of local) byTimestamp.set(snapshot.timestamp, snapshot);
    return [...byTimestamp.values()]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-this.MAX_HISTORY);
  }

  pushSnapshot(nodeId: string, health: any, stats: any, traffic?: any): void {
    const snapshot: MonitoringSnapshot = {
      timestamp: new Date().toISOString(),
      health,
      stats,
      traffic: traffic ?? null,
    };
    let buf = this.history.get(nodeId);
    if (!buf) {
      buf = [];
      this.history.set(nodeId, buf);
    }
    buf.push(snapshot);
    if (buf.length > this.MAX_HISTORY) buf.splice(0, buf.length - this.MAX_HISTORY);
    this.emit('snapshot', { nodeId, snapshot });

    if (this.cache) {
      const key = `${NODE_MONITORING_HISTORY_KEY_PREFIX}${nodeId}`;
      const entry = JSON.stringify(compactMonitoringHistorySnapshot(snapshot));
      this.cache
        .getClient()
        .multi()
        .rpush(key, entry)
        .ltrim(key, -this.MAX_HISTORY, -1)
        .expire(key, NODE_MONITORING_HISTORY_TTL)
        .exec()
        .catch(() => {
          /* retain the process-local fallback when Redis is unavailable */
        });
    }

    // Store per-container stats in Redis for sparkline history
    if (this.cache && health?.containerStats) {
      for (const stat of health.containerStats as any[]) {
        if (stat.metricsAvailable === false || stat.metrics_available === false) continue;
        const cid = stat.containerId ?? stat.container_id;
        if (!cid) continue;
        const key = CONTAINER_STATS_KEY_PREFIX + cid;
        const entry = JSON.stringify({ ...stat, timestamp: Date.now() });
        this.cache
          .getClient()
          .lpush(key, entry)
          .then(() => {
            this.cache!.getClient().ltrim(key, 0, CONTAINER_STATS_MAX - 1);
            this.cache!.getClient().expire(key, CONTAINER_STATS_TTL);
          })
          .catch(() => {
            /* ignore redis errors */
          });
      }
    }
  }

  async getContainerStatsHistory(containerId: string): Promise<Record<string, unknown>[]> {
    if (!this.cache) return [];
    try {
      const raw = await this.cache.getClient().lrange(CONTAINER_STATS_KEY_PREFIX + containerId, 0, -1);
      return raw.map((s) => JSON.parse(s)).reverse(); // oldest first
    } catch {
      return [];
    }
  }

  getLatestContainerStats(nodeId: string, containerId: string): Record<string, unknown> | null {
    const report = this.registry.getNode(nodeId)?.lastHealthReport;
    const stats = (report as any)?.containerStats;
    if (!Array.isArray(stats)) return null;
    return (
      (stats.find((item: any) => (item.containerId ?? item.container_id) === containerId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  registerClient(nodeId: string, options: { focused?: boolean } = {}): void {
    const count = (this.clientCounts.get(nodeId) ?? 0) + 1;
    this.clientCounts.set(nodeId, count);
    if (options.focused) {
      this.focusedClientCounts.set(nodeId, (this.focusedClientCounts.get(nodeId) ?? 0) + 1);
    }
    this.syncPolling(nodeId);
  }

  unregisterClient(nodeId: string, options: { focused?: boolean } = {}): void {
    const count = Math.max(0, (this.clientCounts.get(nodeId) ?? 0) - 1);
    if (count === 0) this.clientCounts.delete(nodeId);
    else this.clientCounts.set(nodeId, count);

    if (options.focused) {
      const focusedCount = Math.max(0, (this.focusedClientCounts.get(nodeId) ?? 0) - 1);
      if (focusedCount === 0) this.focusedClientCounts.delete(nodeId);
      else this.focusedClientCounts.set(nodeId, focusedCount);
    }
    this.syncPolling(nodeId);
  }

  private async pollOnce(nodeId: string): Promise<void> {
    try {
      const node = this.registry.getNode(nodeId);
      if (!node) return;
      if (this.registry.isNodeUpdateInProgress(nodeId)) return;

      try {
        node.commandStream.write({ commandId: '', requestHealth: {} }, (err: any) => {
          if (err) logger.debug('Health poll write failed', { nodeId, error: err.message });
        });
        node.commandStream.write({ commandId: '', requestStats: {} }, (err: any) => {
          if (err) logger.debug('Stats poll write failed', { nodeId, error: err.message });
        });
      } catch {
        // Stream may be closed
      }

      // Wait for daemon to respond and control.ts to update the registry
      await new Promise((r) => setTimeout(r, 1000));

      const health = node.lastHealthReport;
      const stats = node.lastStatsReport;
      if (health) {
        // Traffic stats: nginx nodes only
        if (node.type === 'nginx') {
          try {
            node.commandStream.write(
              { commandId: `traffic-${Date.now()}`, requestTrafficStats: { tailLines: 200 } },
              (err: any) => {
                if (err) logger.debug('Traffic stats write failed', { nodeId, error: err.message });
              }
            );
          } catch {
            // Stream may be closed
          }
        }
        const traffic = node.type === 'nginx' ? (node.lastTrafficStats ?? null) : null;
        this.pushSnapshot(nodeId, health, stats, traffic);
      }
    } catch (err) {
      logger.debug('Polling error', { nodeId, error: (err as Error).message });
    }
  }

  private syncPolling(nodeId: string): void {
    const clientCount = this.clientCounts.get(nodeId) ?? 0;
    if (clientCount === 0) {
      this.stopPolling(nodeId);
      return;
    }

    const cadence =
      (this.focusedClientCounts.get(nodeId) ?? 0) > 0 ? this.ACTIVE_POLL_INTERVAL : this.STREAM_POLL_INTERVAL;
    if (this.pollCadences.get(nodeId) === cadence) return;

    this.stopPolling(nodeId);
    this.startPolling(nodeId, cadence);
  }

  private startPolling(nodeId: string, cadence: number): void {
    if (this.pollIntervals.has(nodeId)) return;
    logger.debug('Starting stream-driven polling for node', { nodeId, cadence });

    this.pollOnce(nodeId);
    this.pollCadences.set(nodeId, cadence);
    this.pollIntervals.set(
      nodeId,
      setInterval(() => this.pollOnce(nodeId), cadence)
    );
  }

  private stopPolling(nodeId: string): void {
    const interval = this.pollIntervals.get(nodeId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(nodeId);
      this.pollCadences.delete(nodeId);
      logger.debug('Stopped polling for node', { nodeId });
    }
  }

  destroy(): void {
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    this.pollCadences.clear();
    this.clientCounts.clear();
    this.focusedClientCounts.clear();
  }
}
