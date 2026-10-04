/** Docker daemons whose shared secure-link connector serves egress (storage, database and container links). */
export const SECURE_LINK_EGRESS_CAPABILITY = 'secure_link_egress_v1';

/** One connector egress listener as a SyncRelayGrants ACK reports it (C2), keyed by the route's owner id. */
export interface SecureLinkEgressStatus {
  state: 'ready' | 'pending' | 'error';
  address?: string;
  port?: number;
  error?: string;
  routeGeneration: number;
}

/** The `egressStatuses` of a SyncRelayGrants ACK; empty for a daemon without connector egress. */
export function parseRelayGrantEgressStatuses(detail: string | undefined): Record<string, SecureLinkEgressStatus> {
  if (!detail) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return {};
  }
  const statuses = (parsed as { egressStatuses?: unknown } | null)?.egressStatuses;
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return {};
  const result: Record<string, SecureLinkEgressStatus> = {};
  for (const [ownerId, value] of Object.entries(statuses as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const status = value as Record<string, unknown>;
    const state = status.state;
    if (state !== 'ready' && state !== 'pending' && state !== 'error') continue;
    result[ownerId] = {
      state,
      ...(typeof status.address === 'string' ? { address: status.address } : {}),
      ...(typeof status.port === 'number' ? { port: status.port } : {}),
      ...(typeof status.error === 'string' && status.error ? { error: status.error } : {}),
      routeGeneration: Number(status.routeGeneration ?? 0),
    };
  }
  return result;
}
