import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { formatHostPort } from '@/lib/network-endpoint.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { HealthCheckBodyMatchMode } from './proxy.service-helpers.js';
import { matchesExpectedBody } from './proxy.service-helpers.js';

interface ProxyHealthLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

interface HealthEntry {
  ts: string;
  status: string;
  responseMs?: number;
}

export function runImmediateProxyHealthCheck({
  db,
  hostId,
  logger,
  nodeDispatch,
  eventBus,
}: {
  db: DrizzleClient;
  hostId: string;
  logger: ProxyHealthLogger;
  nodeDispatch?: NodeDispatchService;
  eventBus?: EventBusService;
}): void {
  // Run after a short delay to allow nginx reload to complete.
  setTimeout(async () => {
    try {
      const host = await db.query.proxyHosts.findFirst({
        where: eq(proxyHosts.id, hostId),
      });
      if (
        !host?.enabled ||
        !host.healthCheckEnabled ||
        host.maintenanceEnabled ||
        (host.secureLinkMigratedAt == null && (!host.forwardHost || !host.forwardPort))
      )
        return;

      const scheme = host.forwardScheme || 'http';
      const path = host.healthCheckUrl || '/';
      const url =
        host.forwardHost && host.forwardPort
          ? `${scheme}://${formatHostPort(host.forwardHost, host.forwardPort)}${path}`
          : null;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      let status: 'online' | 'offline' | 'degraded' = 'offline';
      let responseMs: number | undefined;
      try {
        if (
          (host.upstreamKind === 'docker_container' || host.upstreamKind === 'docker_deployment') &&
          host.secureLinkMigratedAt != null
        ) {
          if (!host.nodeId || !nodeDispatch) throw new Error('Secure Link health probe is unavailable');
          const probe = await nodeDispatch.probeProxySecureLink(host.nodeId, {
            linkId: host.id,
            scheme,
            path,
            expectedStatus: host.healthCheckExpectedStatus,
            expectedBody: host.healthCheckExpectedBody,
            bodyMatchMode: host.healthCheckBodyMatchMode,
            timeoutSeconds: 10,
          });
          clearTimeout(timeout);
          responseMs = probe.responseMs;
          if (probe.ok) status = 'online';
          else if (!host.healthCheckExpectedStatus && probe.httpStatus && probe.httpStatus < 500) status = 'degraded';
          else status = 'offline';
        } else {
          if (!url) throw new Error('Proxy upstream endpoint is unavailable');
          const startedAt = Date.now();
          const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow',
          });
          clearTimeout(timeout);
          responseMs = Date.now() - startedAt;

          const expectedStatus = host.healthCheckExpectedStatus;
          if (expectedStatus) {
            status = response.status === expectedStatus ? 'online' : 'offline';
          } else {
            if (response.status >= 200 && response.status < 300) status = 'online';
            else if (response.status >= 500) status = 'offline';
            else status = 'degraded';
          }

          const expectedBody = host.healthCheckExpectedBody;
          const bodyMatchMode = (host.healthCheckBodyMatchMode as HealthCheckBodyMatchMode | null) ?? 'includes';
          if (expectedBody && status === 'online') {
            const body = await response.text();
            if (!matchesExpectedBody(body, expectedBody, bodyMatchMode)) status = 'degraded';
          }
        }
      } catch {
        clearTimeout(timeout);
        status = 'offline';
      }

      const now = Date.now();
      const entry: HealthEntry = { ts: new Date(now).toISOString(), status };
      if (responseMs != null) entry.responseMs = responseMs;
      const existingHistory = (host.healthHistory as HealthEntry[] | null) ?? [];
      const healthHistory = compactHealthHistory([...existingHistory, entry], { nowMs: now });

      const persisted = await db
        .update(proxyHosts)
        .set({ healthStatus: status, lastHealthCheckAt: new Date(now), healthHistory })
        .where(
          and(
            eq(proxyHosts.id, hostId),
            eq(proxyHosts.enabled, true),
            eq(proxyHosts.healthCheckEnabled, true),
            eq(proxyHosts.maintenanceEnabled, false)
          )
        )
        .returning({ id: proxyHosts.id });

      if (persisted.length === 0) return;

      logger.debug('Immediate health check complete', { hostId, status });
      eventBus?.publish('proxy.host.changed', {
        id: hostId,
        action: `health.${status}`,
        domain: host.domainNames?.[0],
        health_status: status,
      });
    } catch (err) {
      logger.debug('Immediate health check failed', { hostId, error: err });
    }
  }, 2000);
}
