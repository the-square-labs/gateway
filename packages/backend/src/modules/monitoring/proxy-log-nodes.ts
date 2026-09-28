import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { resolveIngressNodes } from '@/modules/ingress-groups/ingress-nodes.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { RelayedLogEntry } from './log-relay.service.js';
import { requestNginxHostLogHistory, subscribeNginxHostLogs } from './nginx-log-subscriptions.js';

/**
 * Logs of a route come from every node that serves it: its node, or each member of its ingress group. Each member
 * keeps its own nginx logs, so a group route's log view merges the members' lines by time.
 */
export async function resolveProxyLogNodes(db: DrizzleClient, hostId: string): Promise<string[]> {
  const [host] = await db
    .select({ nodeId: proxyHosts.nodeId, ingressGroupId: proxyHosts.ingressGroupId })
    .from(proxyHosts)
    .where(eq(proxyHosts.id, hostId))
    .limit(1);
  return host ? resolveIngressNodes(db, host) : [];
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** Milliseconds of an nginx access (`28/Sep/2026:19:00:00 +0000`) or error (`2026/09/28 19:00:00`) log time. */
export function nginxLogTime(timestamp: string): number {
  const access = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(timestamp);
  if (access) {
    const [, day, month, year, hour, minute, second, sign, offsetHours, offsetMinutes] = access;
    const offset = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000 * (sign === '-' ? -1 : 1);
    const month0 = MONTHS[month!];
    if (month0 === undefined) return Number.NaN;
    return Date.UTC(Number(year), month0, Number(day), Number(hour), Number(minute), Number(second)) - offset;
  }
  const error = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(timestamp);
  if (error) {
    const [, year, month, day, hour, minute, second] = error;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  return Date.parse(timestamp);
}

/**
 * Merges each node's chronological lines into one timeline. A line without a readable time keeps its place after
 * the previous line of its node; lines of equal time keep node order.
 */
export function mergeNodeLogEntries(lists: readonly RelayedLogEntry[][]): RelayedLogEntry[] {
  if (lists.length <= 1) return [...(lists[0] ?? [])];
  const keyed = lists.flatMap((entries, list) => {
    let previous = Number.NEGATIVE_INFINITY;
    return entries.map((entry, index) => {
      const parsed = nginxLogTime(entry.timestamp);
      previous = Number.isNaN(parsed) ? previous : parsed;
      return { entry, time: previous, list, index };
    });
  });
  keyed.sort((left, right) => left.time - right.time || left.list - right.list || left.index - right.index);
  return keyed.map((item) => item.entry);
}

/** The last `tailLines` lines of a route from each of its nodes, merged; ok when at least one node answered. */
export async function requestProxyLogHistory(
  registry: NodeRegistryService,
  nodeIds: readonly string[],
  hostId: string,
  tailLines: number
): Promise<{ ok: true; entries: RelayedLogEntry[] } | { ok: false; message: string }> {
  if (nodeIds.length === 1) return requestNginxHostLogHistory(registry, nodeIds[0]!, hostId, tailLines);
  const results = await Promise.all(
    nodeIds.map((nodeId) => requestNginxHostLogHistory(registry, nodeId, hostId, tailLines))
  );
  const answered = results.flatMap((result) => (result.ok ? [result.entries] : []));
  if (answered.length === 0) {
    const failure = results.find((result) => !result.ok) as { ok: false; message: string } | undefined;
    return { ok: false, message: failure?.message ?? 'No ingress node of this route is connected' };
  }
  return { ok: true, entries: mergeNodeLogEntries(answered).slice(-Math.max(1, Math.floor(tailLines))) };
}

/** Live lines of a route from each of its nodes; ok when at least one node accepted the subscription. */
export function subscribeProxyLogs(
  registry: NodeRegistryService,
  nodeIds: readonly string[],
  hostId: string
): { ok: true; cleanup: () => void } | { ok: false; message: string } {
  if (nodeIds.length === 1) return subscribeNginxHostLogs(registry, nodeIds[0]!, hostId, 0);
  const subscriptions = nodeIds.map((nodeId) => subscribeNginxHostLogs(registry, nodeId, hostId, 0));
  const active = subscriptions.flatMap((subscription) => (subscription.ok ? [subscription] : []));
  if (active.length === 0) {
    const failure = subscriptions.find((subscription) => !subscription.ok) as
      | { ok: false; message: string }
      | undefined;
    return { ok: false, message: failure?.message ?? 'No ingress node of this route is connected' };
  }
  return {
    ok: true,
    cleanup: () => {
      for (const subscription of active) subscription.cleanup();
    },
  };
}
