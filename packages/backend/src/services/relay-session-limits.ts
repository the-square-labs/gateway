interface RelaySessionLimitOwner {
  ownerKind: string;
  maxConcurrentSessions: number;
}

// Proxy routes carry ordinary HTTP, SSE and WebSocket traffic. Keep the cap
// above the verified 400-client load while still bounding leaked sessions.
export const PROXY_RELAY_MAX_CONCURRENT_SESSIONS = 1024;

export function effectiveRelayMaxConcurrentSessions(owner: RelaySessionLimitOwner): number {
  if (owner.ownerKind !== 'proxy_host_secure_link') return owner.maxConcurrentSessions;
  return Math.max(owner.maxConcurrentSessions, PROXY_RELAY_MAX_CONCURRENT_SESSIONS);
}
