import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { resolvePagesRouteProbeDomain, resolveProxyHealthCheckUrl } from '@/modules/proxy/proxy-health-check.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

const logger = createChildLogger('HealthCheckJob');

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_CONCURRENCY = 8;
// A daemon accepts at most four asynchronous commands at once. Reserve one slot
// for interactive/synchronization work while scheduled probes are in flight.
const SECURE_LINK_PROBE_CONCURRENCY_PER_NODE = 3;
const DAEMON_BUSY_ERROR = 'daemon is busy handling long-running commands; retry shortly';
const SLOW_BASELINE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours of history for baseline avg
const SLOW_RESPONSE_FLOOR_MS = 250;

type HealthStatus = 'online' | 'offline' | 'degraded' | 'unknown';

interface HealthEntry {
  ts: string;
  status: string;
  responseMs?: number;
  slow?: boolean;
}

function healthCheckDue(host: typeof proxyHosts.$inferSelect, now: number): boolean {
  if (!host.lastHealthCheckAt) return true;
  const intervalMs = Math.max(5, host.healthCheckInterval ?? 30) * 1000;
  return now - new Date(host.lastHealthCheckAt).getTime() >= intervalMs;
}

async function allSettledBounded<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export class HealthCheckJob {
  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  private relayUnavailable = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly nodeDispatch?: NodeDispatchService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    (bus as Partial<EventBusService>).subscribe?.('system.relay.health.changed', (payload) => {
      this.relayUnavailable = (payload as { state?: unknown } | null)?.state === 'critical';
    });
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  async run(): Promise<void> {
    // Query proxy hosts with health checks enabled
    const candidates = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.healthCheckEnabled, true),
        eq(proxyHosts.enabled, true),
        eq(proxyHosts.maintenanceEnabled, false)
      ),
    });
    const hosts = candidates.filter((host) => healthCheckDue(host, Date.now()));

    if (hosts.length === 0) {
      logger.debug('No proxy health checks are due');
      return;
    }

    logger.info(`Running health checks for ${hosts.length} host(s)`);

    const check = async (host: typeof proxyHosts.$inferSelect) => {
      const relayBacked =
        (host.upstreamKind === 'docker_container' || host.upstreamKind === 'docker_deployment') &&
        host.secureLinkMigratedAt != null;
      if (relayBacked && this.relayUnavailable) {
        await this.recordRelayUnavailable(host);
        return { hostId: host.id, status: 'skipped' as const };
      }
      const previousStatus = host.healthStatus as HealthStatus;
      const { status: checkStatus, responseMs } = await this.checkHost(host);

      if (relayBacked && this.relayUnavailable) {
        await this.recordRelayUnavailable(host);
        return { hostId: host.id, status: 'skipped' as const };
      }
      if (checkStatus === 'skipped') {
        await this.recordProbeIndeterminate(host);
        return { hostId: host.id, status: 'skipped' as const };
      }
      if (checkStatus === 'unknown') {
        await this.recordProbeUnknown(host);
        return { hostId: host.id, status: 'unknown' as const };
      }

      const now = Date.now();
      const existingHistory: HealthEntry[] = (host.healthHistory as HealthEntry[]) ?? [];

      // Compute slow flag: compare response time against baseline average
      let slow = false;
      if (checkStatus === 'online' && responseMs != null) {
        const threshold = host.healthCheckSlowThreshold ?? 3;
        if (threshold > 0) {
          const baselineCutoff = now - SLOW_BASELINE_WINDOW_MS;
          const baselineTimes = existingHistory
            .filter((h) => h.status === 'online' && h.responseMs != null && new Date(h.ts).getTime() >= baselineCutoff)
            .map((h) => h.responseMs!);
          if (baselineTimes.length >= 5) {
            // need enough samples for a meaningful baseline
            const avgMs = baselineTimes.reduce((a, b) => a + b, 0) / baselineTimes.length;
            slow = responseMs >= Math.max(avgMs * threshold, SLOW_RESPONSE_FLOOR_MS);
          }
        }
      }

      // Push new entry
      const entry: HealthEntry = { ts: new Date(now).toISOString(), status: checkStatus };
      if (responseMs != null) entry.responseMs = responseMs;
      if (slow) entry.slow = true;
      const history = compactHealthHistory([...existingHistory, entry], { nowMs: now });

      // Derive the stored healthStatus field from the check
      const previousProbeFailed = existingHistory.at(-1)?.status === 'offline';
      const transientFailure =
        checkStatus === 'offline' &&
        (previousStatus === 'online' || previousStatus === 'degraded') &&
        !previousProbeFailed;
      const newStatus: HealthStatus =
        checkStatus === 'online' ? (slow ? 'degraded' : 'online') : transientFailure ? previousStatus : 'offline';

      // Write to DB
      const persisted = await this.db
        .update(proxyHosts)
        .set({
          healthStatus: newStatus,
          lastHealthCheckAt: new Date(),
          healthHistory: history,
        })
        .where(
          and(
            eq(proxyHosts.id, host.id),
            eq(proxyHosts.enabled, true),
            eq(proxyHosts.healthCheckEnabled, true),
            eq(proxyHosts.maintenanceEnabled, false)
          )
        )
        .returning({ id: proxyHosts.id });

      if (persisted.length === 0) {
        logger.debug('Discarded health result because host state changed', { hostId: host.id });
        return { hostId: host.id, status: 'skipped' as const };
      }

      if (!transientFailure) {
        await this.evaluator?.observeStatefulEvent(
          'proxy',
          newStatus === 'online' ? 'health.online' : newStatus === 'offline' ? 'health.offline' : 'health.degraded',
          {
            type: 'proxy',
            id: host.id,
            name: host.domainNames?.[0] ?? host.id,
          },
          { health_status: newStatus }
        );
      }

      // Keep alerts/logging transition-based, but publish every persisted sample so
      // an open detail page can advance its health history without a reload.
      let healthAction = 'health.sampled';
      if (previousStatus !== newStatus) {
        logger.info(`Health status changed for ${host.domainNames?.join(', ') || host.id}`, {
          hostId: host.id,
          previousStatus,
          newStatus,
          forwardHost: host.forwardHost,
        });
        healthAction =
          newStatus === 'online' ? 'health.online' : newStatus === 'offline' ? 'health.offline' : 'health.degraded';
      }
      this.eventBus?.publish('proxy.host.changed', {
        id: host.id,
        action: healthAction,
        domain: host.domainNames?.[0],
        health_status: newStatus,
      });

      return { hostId: host.id, status: newStatus };
    };

    const directHosts: typeof hosts = [];
    const daemonHostsByNode = new Map<string, typeof hosts>();
    for (const host of hosts) {
      const relayBacked =
        (host.upstreamKind === 'docker_container' || host.upstreamKind === 'docker_deployment') &&
        host.secureLinkMigratedAt != null;
      if (!relayBacked && host.upstreamKind !== 'pages') {
        directHosts.push(host);
        continue;
      }
      const nodeKey = host.nodeId ?? '__missing_node__';
      const nodeHosts = daemonHostsByNode.get(nodeKey) ?? [];
      nodeHosts.push(host);
      daemonHostsByNode.set(nodeKey, nodeHosts);
    }

    const resultGroups = await Promise.all([
      allSettledBounded(directHosts, HEALTH_CHECK_CONCURRENCY, check),
      ...Array.from(daemonHostsByNode.values(), (nodeHosts) =>
        allSettledBounded(nodeHosts, SECURE_LINK_PROBE_CONCURRENCY_PER_NODE, check)
      ),
    ]);
    const results = resultGroups.flat();

    // Summarize results
    let online = 0;
    let offline = 0;
    let degraded = 0;
    let errors = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        switch (result.value.status) {
          case 'online':
            online++;
            break;
          case 'offline':
            offline++;
            break;
          case 'degraded':
            degraded++;
            break;
        }
      } else {
        errors++;
        logger.error('Health check execution failed', { error: result.reason });
      }
    }

    if (offline > 0 || degraded > 0 || errors > 0) {
      logger.info('Health check summary', { online, offline, degraded, errors, total: hosts.length });
    }
  }

  private async recordRelayUnavailable(host: typeof proxyHosts.$inferSelect): Promise<void> {
    const now = Date.now();
    const existingHistory: HealthEntry[] = (host.healthHistory as HealthEntry[]) ?? [];
    const healthHistory = compactHealthHistory(
      [...existingHistory, { ts: new Date(now).toISOString(), status: 'unknown' }],
      { nowMs: now }
    );
    const persisted = await this.db
      .update(proxyHosts)
      .set({ lastHealthCheckAt: new Date(now), healthHistory })
      .where(
        and(
          eq(proxyHosts.id, host.id),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.healthCheckEnabled, true),
          eq(proxyHosts.maintenanceEnabled, false)
        )
      )
      .returning({ id: proxyHosts.id });
    if (persisted.length > 0) {
      this.eventBus?.publish('proxy.host.changed', {
        id: host.id,
        action: 'health.sampled',
        domain: host.domainNames?.[0],
        health_status: host.healthStatus,
      });
    }
  }

  private async recordProbeIndeterminate(host: typeof proxyHosts.$inferSelect): Promise<void> {
    await this.db
      .update(proxyHosts)
      .set({ lastHealthCheckAt: new Date() })
      .where(
        and(
          eq(proxyHosts.id, host.id),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.healthCheckEnabled, true),
          eq(proxyHosts.maintenanceEnabled, false)
        )
      );
  }

  private async recordProbeUnknown(host: typeof proxyHosts.$inferSelect): Promise<void> {
    const now = Date.now();
    const existingHistory: HealthEntry[] = (host.healthHistory as HealthEntry[]) ?? [];
    const healthHistory = compactHealthHistory(
      [...existingHistory, { ts: new Date(now).toISOString(), status: 'unknown' }],
      { nowMs: now }
    );
    const persisted = await this.db
      .update(proxyHosts)
      .set({ healthStatus: 'unknown', lastHealthCheckAt: new Date(now), healthHistory })
      .where(
        and(
          eq(proxyHosts.id, host.id),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.healthCheckEnabled, true),
          eq(proxyHosts.maintenanceEnabled, false)
        )
      )
      .returning({ id: proxyHosts.id });
    if (persisted.length > 0) {
      this.eventBus?.publish('proxy.host.changed', {
        id: host.id,
        action: 'health.unknown',
        domain: host.domainNames?.[0],
        health_status: 'unknown',
      });
    }
  }

  private async checkHost(
    host: typeof proxyHosts.$inferSelect
  ): Promise<{ status: 'online' | 'offline' | 'skipped' | 'unknown'; responseMs?: number }> {
    if (host.upstreamKind === 'pages') {
      const domain = resolvePagesRouteProbeDomain(host);
      if (!host.nodeId || !this.nodeDispatch || !domain) return { status: 'unknown' };
      try {
        const result = await this.nodeDispatch.probePagesRoute(host.nodeId, {
          routeId: host.id,
          domain,
          tls: host.sslEnabled ?? false,
          path: host.healthCheckUrl || '/',
          expectedStatus: host.healthCheckExpectedStatus,
          expectedBody: host.healthCheckExpectedBody,
          bodyMatchMode: host.healthCheckBodyMatchMode,
          timeoutSeconds: Math.ceil(HEALTH_CHECK_TIMEOUT_MS / 1000),
        });
        if (result.skipped) {
          logger.debug('Pages Route health probe is unavailable', {
            hostId: host.id,
            nodeId: host.nodeId,
            domain,
            error: result.error,
          });
          return { status: 'unknown' };
        }
        if (!result.ok && result.error === DAEMON_BUSY_ERROR) {
          logger.debug('Pages Route health probe deferred', {
            hostId: host.id,
            nodeId: host.nodeId,
            domain,
            error: result.error,
          });
          return { status: 'skipped' };
        }
        if (!result.ok) {
          logger.warn('Pages Route health probe failed', {
            hostId: host.id,
            nodeId: host.nodeId,
            domain,
            httpStatus: result.httpStatus,
            error: result.error,
          });
        }
        return { status: result.ok ? 'online' : 'offline', responseMs: result.responseMs };
      } catch (error) {
        logger.warn('Pages Route health probe command failed', {
          hostId: host.id,
          nodeId: host.nodeId,
          domain,
          error,
        });
        return { status: 'offline' };
      }
    }
    if (
      (host.upstreamKind === 'docker_container' || host.upstreamKind === 'docker_deployment') &&
      host.secureLinkMigratedAt != null
    ) {
      if (!host.nodeId || !this.nodeDispatch) return { status: 'offline' };
      try {
        const result = await this.nodeDispatch.probeProxySecureLink(host.nodeId, {
          linkId: host.id,
          scheme: host.forwardScheme ?? 'http',
          path: host.healthCheckUrl || '/',
          expectedStatus: host.healthCheckExpectedStatus,
          expectedBody: host.healthCheckExpectedBody,
          bodyMatchMode: host.healthCheckBodyMatchMode,
          timeoutSeconds: Math.ceil(HEALTH_CHECK_TIMEOUT_MS / 1000),
        });
        if (!result.ok && result.error === DAEMON_BUSY_ERROR) {
          logger.debug('Secure Link health probe deferred because daemon is busy', {
            hostId: host.id,
            nodeId: host.nodeId,
            domain: host.domainNames?.[0],
          });
          return { status: 'skipped' };
        }
        if (!result.ok) {
          logger.warn('Secure Link health probe failed', {
            hostId: host.id,
            nodeId: host.nodeId,
            domain: host.domainNames?.[0],
            httpStatus: result.httpStatus,
            error: result.error,
          });
        }
        return { status: result.ok ? 'online' : 'offline', responseMs: result.responseMs };
      } catch (error) {
        logger.warn('Secure Link health probe command failed', {
          hostId: host.id,
          nodeId: host.nodeId,
          domain: host.domainNames?.[0],
          error,
        });
        return { status: 'offline' };
      }
    }
    const url = resolveProxyHealthCheckUrl(host);
    if (!url) return { status: 'offline' };

    const start = performance.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'follow',
        });

        const responseMs = Math.round(performance.now() - start);

        let passed = true;

        if (host.healthCheckExpectedStatus) {
          // Custom expected status code
          if (response.status !== host.healthCheckExpectedStatus) passed = false;
        } else {
          // Default: 2xx = pass
          if (response.status < 200 || response.status >= 300) passed = false;
        }

        // Body content matching
        if (passed && host.healthCheckExpectedBody) {
          try {
            const body = await response.text();
            if (!body.includes(host.healthCheckExpectedBody)) passed = false;
          } catch {
            passed = false;
          }
        }

        return { status: passed ? 'online' : 'offline', responseMs };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        logger.debug(`Health check timed out for ${host.forwardHost}:${host.forwardPort}`);
      } else {
        logger.debug(`Health check failed for ${host.forwardHost}:${host.forwardPort}`, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return { status: 'offline' };
    }
  }
}
