import { and, eq, inArray } from 'drizzle-orm';
import { nodes, proxyAdditionalSecureLinks, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { ProxyAdditionalSecureLinkRow } from './proxy-secure-link.service.js';

export { __testOnly } from './proxy.service-helpers.js';

import {
  isDockerUpstream,
  logger,
  type ProxyHostRow,
  type ProxyHostTrafficRuntime,
  type ProxySecureLinkRuntimeSample,
  type ProxySecureLinkRuntimeSnapshot,
  SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES,
  SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES,
  SECURE_LINK_RUNTIME_CACHE_PREFIX,
  SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS,
  SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS,
  SECURE_LINK_TRAFFIC_WINDOW_SECONDS,
} from './proxy.service.core.js';
import { ProxyServiceLifecycle } from './proxy.service.lifecycle.js';

const SECURE_LINK_TELEMETRY_STALE_AFTER_MS = 30_000;

export abstract class ProxyServiceSecureLinks extends ProxyServiceLifecycle {
  protected async requireManagedProxyHost(id: string): Promise<ProxyHostRow> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.type !== 'proxy' || host.rawConfigEnabled) {
      throw new AppError(
        409,
        'ADDITIONAL_SECURE_LINK_UNAVAILABLE',
        'Additional Secure Links require a managed proxy host'
      );
    }
    return host;
  }

  async getProxySecureLinkStatus(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
      columns: {
        id: true,
        isSystem: true,
        upstreamKind: true,
        nodeId: true,
        dockerNodeId: true,
        secureLinkGeneration: true,
        secureLinkStatus: true,
        secureLinkLastError: true,
        secureLinkMigratedAt: true,
        healthCheckEnabled: true,
        healthCheckInterval: true,
        rateLimitEnabled: true,
        rateLimitMode: true,
        rateLimitOptions: true,
      },
    });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (!isDockerUpstream(host.upstreamKind)) {
      throw new AppError(409, 'SECURE_LINK_NOT_APPLICABLE', 'Proxy host does not use a Docker Secure Link');
    }

    const nodeIds = [host.nodeId, host.dockerNodeId].filter((nodeId): nodeId is string => Boolean(nodeId));
    const [linkNodes, cachedHistory, additionalBindings] = await Promise.all([
      nodeIds.length
        ? this.db
            .select({ id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName, status: nodes.status })
            .from(nodes)
            .where(inArray(nodes.id, nodeIds))
        : Promise.resolve([]),
      this.getSecureLinkRuntimeHistory(host.id),
      this.secureLinks?.listAdditional?.(host.id) ?? Promise.resolve([]),
    ]);
    let history = cachedHistory;
    let latestSnapshot = history.at(-1);
    let runtime = latestSnapshot?.runtime ?? null;
    let traffic = latestSnapshot?.traffic ?? null;

    const focusedSample = this.sampleSecureLinkRuntime(host, SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES);
    if (!runtime || !traffic) {
      // A partial cached sample must not be exposed as a current "telemetry
      // unavailable" state. Collect Relay and Nginx telemetry as one snapshot
      // on the first incomplete read; subsequent reads stay cache-fast.
      try {
        const refreshed = await focusedSample;
        history = refreshed.history;
        latestSnapshot = refreshed.snapshot;
        runtime = latestSnapshot.runtime;
        traffic = latestSnapshot.traffic;
      } catch (error) {
        logger.debug('Focused Proxy Secure Link telemetry collection failed', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      void focusedSample.catch((error) => {
        logger.debug('Focused Proxy Secure Link telemetry collection failed', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const nodeById = new Map(linkNodes.map((node) => [node.id, node]));
    const sourceNode = host.nodeId ? nodeById.get(host.nodeId) : undefined;
    const targetNode = host.dockerNodeId ? nodeById.get(host.dockerNodeId) : undefined;
    const rateLimitMode = host.rateLimitMode ?? (host.rateLimitEnabled ? 'custom' : 'inherit');
    const rateLimitOptions = (host.rateLimitOptions ?? {}) as {
      requestsPerSecond?: number;
      burst?: number;
      connectionsPerIp?: number;
    };
    const rateLimitEnabled = rateLimitMode !== 'disabled';
    const additionalLinks = await Promise.all(
      additionalBindings.map(async (binding) => {
        const historyKey = this.additionalSecureLinkRuntimeKey(binding.id);
        let bindingHistory = await this.getSecureLinkRuntimeHistory(historyKey);
        let bindingRuntime = bindingHistory.at(-1)?.runtime ?? null;
        if (binding.status === 'active') {
          const focusedSample = this.sampleAdditionalSecureLinkRuntime(binding);
          if (!bindingRuntime) {
            try {
              const refreshed = await focusedSample;
              bindingHistory = refreshed.history;
              bindingRuntime = refreshed.snapshot.runtime;
            } catch (error) {
              logger.debug('Focused additional Secure Link telemetry collection failed', {
                hostId: host.id,
                bindingId: binding.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            void focusedSample.catch((error) => {
              logger.debug('Focused additional Secure Link telemetry collection failed', {
                hostId: host.id,
                bindingId: binding.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
        return {
          id: binding.id,
          name: binding.name,
          status: binding.status,
          generation: binding.generation,
          targetContainer: binding.targetContainer,
          forwardScheme: binding.forwardScheme,
          lastError: binding.lastError,
          runtime: bindingRuntime,
          history: bindingHistory.map(({ timestamp, runtime: snapshotRuntime }) => ({
            timestamp,
            runtime: snapshotRuntime,
          })),
        };
      })
    );
    const telemetrySampledAt = latestSnapshot?.timestamp ?? null;
    const telemetrySampledAtMs = telemetrySampledAt ? Date.parse(telemetrySampledAt) : Number.NaN;
    const telemetryStale =
      telemetrySampledAt != null &&
      (!Number.isFinite(telemetrySampledAtMs) ||
        Date.now() - telemetrySampledAtMs > SECURE_LINK_TELEMETRY_STALE_AFTER_MS);
    return {
      state: host.secureLinkStatus,
      generation: host.secureLinkGeneration,
      sourceNodeId: host.nodeId,
      targetNodeId: host.dockerNodeId,
      transport: 'grpc-http2-mtls',
      migratedAt: host.secureLinkMigratedAt?.toISOString() ?? null,
      lastError: host.secureLinkLastError,
      telemetrySampledAt,
      telemetryStale,
      healthCheck: {
        enabled: host.healthCheckEnabled,
        intervalSeconds: host.healthCheckInterval ?? 30,
      },
      sourceNode: sourceNode
        ? { id: sourceNode.id, name: sourceNode.displayName || sourceNode.hostname, status: sourceNode.status }
        : null,
      targetNode: targetNode
        ? { id: targetNode.id, name: targetNode.displayName || targetNode.hostname, status: targetNode.status }
        : null,
      rateLimit: {
        mode: rateLimitMode,
        enabled: rateLimitEnabled,
        requestsPerSecond:
          rateLimitMode === 'custom' ? (rateLimitOptions.requestsPerSecond ?? 1000) : rateLimitEnabled ? 1000 : 0,
        burst: rateLimitMode === 'custom' ? (rateLimitOptions.burst ?? 3000) : rateLimitEnabled ? 3000 : 0,
        connectionsPerIp:
          rateLimitMode === 'custom' ? (rateLimitOptions.connectionsPerIp ?? 1000) : rateLimitEnabled ? 1000 : 0,
      },
      runtime,
      traffic,
      history,
      additionalLinks,
    };
  }

  /**
   * Collects the same runtime snapshots that the focused Link Runtime page
   * requests, but for every enabled active Secure Link. This background path
   * keeps monitoring history independent from browser sessions.
   */
  collectSecureLinkRuntimeSnapshots(): Promise<void> {
    if (this.secureLinkRuntimeBackgroundInFlight) return this.secureLinkRuntimeBackgroundInFlight;
    if (this.dockerReconcileRunning) {
      this.secureLinkRuntimeCollectionPending = true;
      return Promise.resolve();
    }

    this.secureLinkRuntimeCollectionPending = false;
    const task = this.collectSecureLinkRuntimeSnapshotsOnce().finally(() => {
      if (this.secureLinkRuntimeBackgroundInFlight === task) {
        this.secureLinkRuntimeBackgroundInFlight = null;
      }
    });
    this.secureLinkRuntimeBackgroundInFlight = task;
    return task;
  }

  protected async collectSecureLinkRuntimeSnapshotsOnce(): Promise<void> {
    if (!this.secureLinks) return;
    const [hosts, additionalBindings] = await Promise.all([
      this.db.query.proxyHosts.findMany({
        where: and(
          eq(proxyHosts.isSystem, false),
          eq(proxyHosts.enabled, true),
          inArray(proxyHosts.upstreamKind, ['docker_container', 'docker_deployment']),
          eq(proxyHosts.secureLinkStatus, 'active')
        ),
        columns: { id: true, nodeId: true },
      }),
      this.db.query.proxyAdditionalSecureLinks?.findMany
        ? this.db.query.proxyAdditionalSecureLinks.findMany({
            where: and(
              eq(proxyAdditionalSecureLinks.purpose, 'user_managed'),
              eq(proxyAdditionalSecureLinks.status, 'active')
            ),
          })
        : Promise.resolve([]),
    ]);

    // Keep daemon and Relay fan-out bounded when an installation has many
    // Secure Links. A slow route cannot create overlapping background rounds.
    const concurrency = 4;
    for (let offset = 0; offset < hosts.length; offset += concurrency) {
      const batch = hosts.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(
        batch.map((host) => this.sampleSecureLinkRuntime(host, SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES))
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.debug('Background Proxy Secure Link telemetry collection failed', {
            hostId: batch[index]?.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    }

    for (let offset = 0; offset < additionalBindings.length; offset += concurrency) {
      const batch = additionalBindings.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(batch.map((binding) => this.sampleAdditionalSecureLinkRuntime(binding)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.debug('Background additional Secure Link telemetry collection failed', {
            bindingId: batch[index]?.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    }
  }

  protected sampleSecureLinkRuntime(
    host: { id: string; nodeId: string | null },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSample> {
    const active = this.secureLinkRuntimeSamplesInFlight.get(host.id);
    if (active) return active;

    const task = this.collectSecureLinkRuntimeSnapshot(host, trafficTailLines)
      .then(async (snapshot) => {
        const current = await this.getSecureLinkRuntimeHistory(host.id);
        const previous = current.at(-1);
        if (previous && (snapshot.runtime == null || snapshot.traffic == null)) {
          return { snapshot: previous, history: current };
        }
        const history = this.recordSecureLinkRuntimeSnapshot(host.id, snapshot);
        await this.persistSecureLinkRuntimeHistory(host.id, history);
        return { snapshot, history };
      })
      .finally(() => {
        if (this.secureLinkRuntimeSamplesInFlight.get(host.id) === task) {
          this.secureLinkRuntimeSamplesInFlight.delete(host.id);
        }
      });
    this.secureLinkRuntimeSamplesInFlight.set(host.id, task);
    return task;
  }

  protected additionalSecureLinkRuntimeKey(bindingId: string): string {
    return `additional:${bindingId}`;
  }

  protected sampleAdditionalSecureLinkRuntime(
    binding: Pick<ProxyAdditionalSecureLinkRow, 'id'>
  ): Promise<ProxySecureLinkRuntimeSample> {
    const historyKey = this.additionalSecureLinkRuntimeKey(binding.id);
    const active = this.secureLinkRuntimeSamplesInFlight.get(historyKey);
    if (active) return active;

    const task = (this.secureLinks?.getRuntime(binding.id) ?? Promise.resolve(null))
      .then(async (runtime) => {
        const snapshot: ProxySecureLinkRuntimeSnapshot = {
          timestamp: new Date().toISOString(),
          runtime,
          traffic: null,
        };
        await this.getSecureLinkRuntimeHistory(historyKey);
        const history = this.recordSecureLinkRuntimeSnapshot(historyKey, snapshot);
        await this.persistSecureLinkRuntimeHistory(historyKey, history);
        return { snapshot, history };
      })
      .finally(() => {
        if (this.secureLinkRuntimeSamplesInFlight.get(historyKey) === task) {
          this.secureLinkRuntimeSamplesInFlight.delete(historyKey);
        }
      });
    this.secureLinkRuntimeSamplesInFlight.set(historyKey, task);
    return task;
  }

  protected queueSecureLinkRuntimeSample(host: { id: string; nodeId: string | null }): void {
    if (!this.secureLinks || !host.nodeId) return;
    void this.sampleSecureLinkRuntime(host, SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES).catch((error) => {
      logger.debug('Initial Proxy Secure Link telemetry collection failed', {
        hostId: host.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  protected async collectSecureLinkRuntimeSnapshot(
    host: {
      id: string;
      nodeId: string | null;
    },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSnapshot> {
    const [runtime, trafficResult] = await Promise.all([
      this.secureLinks?.getRuntime(host.id).catch((error) => {
        logger.debug('Proxy Secure Link route telemetry is unavailable', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }) ?? Promise.resolve(null),
      host.nodeId
        ? this.nodeDispatch
            .requestTrafficStats(host.nodeId, trafficTailLines, {
              hostId: host.id,
              windowSeconds: SECURE_LINK_TRAFFIC_WINDOW_SECONDS,
            })
            .catch((error) => {
              logger.debug('Proxy Secure Link HTTP telemetry is unavailable', {
                hostId: host.id,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            })
        : Promise.resolve(null),
    ]);

    let traffic: ProxyHostTrafficRuntime | null = null;
    if (trafficResult?.success && trafficResult.detail) {
      try {
        const parsed = JSON.parse(trafficResult.detail) as ProxyHostTrafficRuntime;
        // Older daemons ignore host_id and return node-global data. Never
        // present that fallback as telemetry for one Secure Link.
        if (parsed.hostId === host.id) traffic = parsed;
      } catch {
        traffic = null;
      }
    }

    return { timestamp: new Date().toISOString(), runtime, traffic };
  }

  protected recordSecureLinkRuntimeSnapshot(
    hostId: string,
    snapshot: ProxySecureLinkRuntimeSnapshot
  ): ProxySecureLinkRuntimeSnapshot[] {
    const current = this.secureLinkRuntimeHistory.get(hostId) ?? [];
    const previous = current.at(-1);
    const relayRestarted =
      previous?.runtime != null &&
      snapshot.runtime != null &&
      (previous.runtime.metricsSince !== snapshot.runtime.metricsSince ||
        Number(snapshot.runtime.openedTotal) < Number(previous.runtime.openedTotal));
    const retained = relayRestarted ? [] : current;
    const previousTimestamp = retained.at(-1)?.timestamp;
    const elapsed = previousTimestamp
      ? new Date(snapshot.timestamp).getTime() - new Date(previousTimestamp).getTime()
      : Number.POSITIVE_INFINITY;
    const updated =
      elapsed < SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS
        ? [...retained.slice(0, -1), snapshot]
        : [...retained, snapshot].slice(-60);
    this.secureLinkRuntimeHistory.set(hostId, updated);
    return [...updated];
  }

  protected async getSecureLinkRuntimeHistory(hostId: string): Promise<ProxySecureLinkRuntimeSnapshot[]> {
    const current = this.secureLinkRuntimeHistory.get(hostId);
    if (current) return [...current];
    if (!this.cache) return [];

    try {
      const cached = await this.cache.get<ProxySecureLinkRuntimeSnapshot[]>(
        `${SECURE_LINK_RUNTIME_CACHE_PREFIX}${hostId}`
      );
      const history = Array.isArray(cached)
        ? cached
            .filter(
              (snapshot): snapshot is ProxySecureLinkRuntimeSnapshot =>
                snapshot != null &&
                typeof snapshot === 'object' &&
                typeof (snapshot as ProxySecureLinkRuntimeSnapshot).timestamp === 'string'
            )
            .slice(-60)
        : [];
      this.secureLinkRuntimeHistory.set(hostId, history);
      return [...history];
    } catch (error) {
      logger.debug('Proxy Secure Link runtime history cache is unavailable', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  protected async persistSecureLinkRuntimeHistory(
    hostId: string,
    history: ProxySecureLinkRuntimeSnapshot[]
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(
        `${SECURE_LINK_RUNTIME_CACHE_PREFIX}${hostId}`,
        history,
        SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS
      );
    } catch (error) {
      logger.debug('Failed to persist Proxy Secure Link runtime history', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------
}
