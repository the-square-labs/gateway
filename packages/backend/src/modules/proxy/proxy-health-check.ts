import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { formatHostPort } from '@/lib/network-endpoint.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { HealthCheckBodyMatchMode } from './proxy.service-helpers.js';
import { matchesExpectedBody } from './proxy.service-helpers.js';

interface ProxyHealthLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

export function runImmediateProxyHealthCheck({
  db,
  hostId,
  logger,
  nodeDispatch,
}: {
  db: DrizzleClient;
  hostId: string;
  logger: ProxyHealthLogger;
  nodeDispatch?: NodeDispatchService;
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
      try {
        if (host.upstreamKind !== 'manual' && host.secureLinkMigratedAt != null) {
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
          if (probe.ok) status = 'online';
          else if (!host.healthCheckExpectedStatus && probe.httpStatus && probe.httpStatus < 500) status = 'degraded';
          else status = 'offline';
        } else {
          if (!url) throw new Error('Proxy upstream endpoint is unavailable');
          const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow',
          });
          clearTimeout(timeout);

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

      const persisted = await db
        .update(proxyHosts)
        .set({ healthStatus: status, lastHealthCheckAt: new Date() })
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
    } catch (err) {
      logger.debug('Immediate health check failed', { hostId, error: err });
    }
  }, 2000);
}
