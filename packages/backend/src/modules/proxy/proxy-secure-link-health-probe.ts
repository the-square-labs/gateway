import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyAdditionalSecureLinks } from '@/db/schema/index.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

export const SECURE_LINK_PROBE_BUSY_ERROR = 'daemon is busy handling long-running commands; retry shortly';

export interface SecureLinkRouteProbeHost {
  id: string;
  nodeId: string | null;
  forwardScheme?: 'http' | 'https' | null;
  healthCheckUrl?: string | null;
  healthCheckExpectedStatus?: number | null;
  healthCheckExpectedBody?: string | null;
  healthCheckBodyMatchMode?: string | null;
}

export interface SecureLinkRouteProbeResult {
  ok: boolean;
  /** The daemon had no free command slot: the sample is indeterminate, not a failure. */
  busy: boolean;
  httpStatus?: number;
  responseMs?: number;
  /** Per-link failures, in probe order. */
  failures: Array<{ linkId: string; httpStatus?: number; responseMs?: number; error: string }>;
}

/**
 * The Secure Link sockets nginx serves each route through, keyed by proxy host. An Availability route is served by
 * its member links (the route's own socket is not opened); lease mode keeps standby members dormant until their
 * candidate holds the lease, so members that are not dormant are tried first. Hosts without members are absent.
 */
export async function loadAvailabilityRouteProbeLinks(
  db: DrizzleClient,
  proxyHostIds: string[]
): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  if (proxyHostIds.length === 0) return links;
  const rows = await db.query.proxyAdditionalSecureLinks.findMany({
    columns: { id: true, proxyHostId: true, availabilityOwnerKey: true, dormant: true },
    where: and(
      inArray(proxyAdditionalSecureLinks.proxyHostId, [...new Set(proxyHostIds)]),
      eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
      eq(proxyAdditionalSecureLinks.status, 'active')
    ),
    orderBy: [asc(proxyAdditionalSecureLinks.name)],
  });
  const ordered = [...rows.filter((row) => !row.dormant), ...rows.filter((row) => row.dormant)];
  for (const row of ordered) {
    if (row.availabilityOwnerKey !== `proxy-host:${row.proxyHostId}`) continue;
    const hostLinks = links.get(row.proxyHostId) ?? [];
    hostLinks.push(row.id);
    links.set(row.proxyHostId, hostLinks);
  }
  return links;
}

/**
 * Probes a route through the nginx daemon's Secure Link sockets: the route's own link, or its Availability members
 * when it has any. The route is healthy as soon as one member answers; members are probed one at a time so the
 * scheduled job's per-daemon command budget still holds.
 */
export async function probeSecureLinkRoute(
  nodeDispatch: Pick<NodeDispatchService, 'probeProxySecureLink'>,
  host: SecureLinkRouteProbeHost & { nodeId: string },
  memberLinkIds: readonly string[] | undefined,
  timeoutSeconds: number
): Promise<SecureLinkRouteProbeResult> {
  const linkIds = memberLinkIds && memberLinkIds.length > 0 ? memberLinkIds : [host.id];
  const failures: SecureLinkRouteProbeResult['failures'] = [];
  for (const linkId of linkIds) {
    try {
      const result = await nodeDispatch.probeProxySecureLink(host.nodeId, {
        linkId,
        scheme: host.forwardScheme ?? 'http',
        path: host.healthCheckUrl || '/',
        expectedStatus: host.healthCheckExpectedStatus,
        expectedBody: host.healthCheckExpectedBody,
        bodyMatchMode: host.healthCheckBodyMatchMode,
        timeoutSeconds,
      });
      if (result.ok) {
        return { ok: true, busy: false, httpStatus: result.httpStatus, responseMs: result.responseMs, failures };
      }
      if (result.error === SECURE_LINK_PROBE_BUSY_ERROR) return { ok: false, busy: true, failures };
      failures.push({
        linkId,
        httpStatus: result.httpStatus,
        responseMs: result.responseMs,
        error: result.error ?? `unexpected response ${result.httpStatus ?? 'status'}`,
      });
    } catch (error) {
      failures.push({ linkId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const last = failures.at(-1);
  return { ok: false, busy: false, httpStatus: last?.httpStatus, responseMs: last?.responseMs, failures };
}
