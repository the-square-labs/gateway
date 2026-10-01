interface RelaySessionLimitOwner {
  ownerKind: string;
  maxConcurrentSessions: number;
}

// Proxy routes carry ordinary HTTP, SSE and WebSocket traffic. Keep the cap
// above the verified 400-client load while still bounding leaked sessions.
export const PROXY_RELAY_MAX_CONCURRENT_SESSIONS = 1024;

// One managed database link or storage link carries every connection of its
// workload: both slots of a deployment during a rollout and every container of
// a Compose service or Availability placement share it. Managed Postgres allows
// 100 connections, so the database stays the outer limit with its own error.
// Daemons size their host listener from the grant claim this value goes into.
export const MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS = 64;

const MANAGED_LINK_ROUTE_OWNER_KINDS = new Set(['managed_database_binding', 'managed_storage_binding']);

export function effectiveRelayMaxConcurrentSessions(owner: RelaySessionLimitOwner): number {
  if (owner.ownerKind === 'proxy_host_secure_link') {
    return Math.max(owner.maxConcurrentSessions, PROXY_RELAY_MAX_CONCURRENT_SESSIONS);
  }
  if (MANAGED_LINK_ROUTE_OWNER_KINDS.has(owner.ownerKind)) {
    return Math.max(owner.maxConcurrentSessions, MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS);
  }
  return owner.maxConcurrentSessions;
}
