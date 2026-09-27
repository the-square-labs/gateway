import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  nodes,
  proxyAdditionalSecureLinks,
  relayInstances,
} from '@/db/schema/index.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { AVAILABILITY_LEASE_CAPABILITY } from './lease-constants.js';
import type { LeaseMemberRow } from './lease-store.js';
import type { LeaseVoterCandidate } from './lease-voters.js';

export interface LeaseParticipant extends LeaseVoterCandidate {
  kind: 'docker' | 'nginx' | 'relay';
  /** Node id of the daemon; for relays the relay daemon's node, null for the local relay. */
  nodeId: string | null;
}

export interface LeaseParticipants {
  relays: LeaseParticipant[];
  daemons: LeaseParticipant[];
  byId: Map<string, LeaseParticipant>;
}

/**
 * A9: only relays in the operator's own enrolled pools vote. Every relay pool Gateway knows today is enrolled by the
 * operator; a managed or third-party pool type must return false here so it never joins the voter set.
 */
export function isOperatorOwnedRelayPool(_poolId: string): boolean {
  return true;
}

function persistedCapabilities(value: unknown): string[] {
  const list = (value as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * A member can take part in the lease only with the capability, a reported identity key and, for docker daemons, a
 * fresh watchdog heartbeat (A12.4).
 */
export function leaseMemberCapable(
  kind: 'docker' | 'nginx' | 'relay',
  advertised: boolean,
  member: LeaseMemberRow | undefined
): boolean {
  if (!advertised || !member?.identityPublicKey) return false;
  return kind !== 'docker' || member.watchdogReady;
}

/** Relays, docker and nginx daemons with what the lease needs to know about each. */
export async function loadLeaseParticipants(
  db: DrizzleClient,
  registry: Pick<NodeRegistryService, 'getNode'>,
  members: Map<string, LeaseMemberRow>
): Promise<LeaseParticipants> {
  const [relayRows, daemonRows, candidateRows, ingressRows] = await Promise.all([
    db
      .select({
        id: relayInstances.id,
        kind: relayInstances.kind,
        poolId: relayInstances.poolId,
        nodeId: relayInstances.nodeId,
        state: relayInstances.state,
        capabilities: relayInstances.capabilities,
        hostIdentityId: nodes.hostIdentityId,
      })
      .from(relayInstances)
      .leftJoin(nodes, eq(nodes.id, relayInstances.nodeId))
      .where(ne(relayInstances.state, 'joining')),
    db
      .select({
        id: nodes.id,
        type: nodes.type,
        status: nodes.status,
        lastSeenAt: nodes.lastSeenAt,
        hostIdentityId: nodes.hostIdentityId,
        capabilities: nodes.capabilities,
      })
      .from(nodes)
      .where(inArray(nodes.type, ['docker', 'nginx'])),
    db
      .selectDistinct({ nodeId: dockerAvailabilityPlacements.nodeId })
      .from(dockerAvailabilityPlacements)
      .innerJoin(dockerAvailabilityPolicies, eq(dockerAvailabilityPolicies.id, dockerAvailabilityPlacements.policyId))
      .where(
        and(
          ne(dockerAvailabilityPolicies.mode, 'single'),
          inArray(dockerAvailabilityPlacements.desiredState, ['serving', 'standby', 'draining'])
        )
      ),
    db
      .selectDistinct({ nodeId: proxyAdditionalSecureLinks.sourceNodeId })
      .from(proxyAdditionalSecureLinks)
      .where(eq(proxyAdditionalSecureLinks.purpose, 'availability_member')),
  ]);
  const candidateNodes = new Set(candidateRows.map(({ nodeId }) => nodeId));
  const ingressNodes = new Set(ingressRows.map(({ nodeId }) => nodeId));
  const relays: LeaseParticipant[] = relayRows
    .filter((relay) => isOperatorOwnedRelayPool(relay.poolId))
    .map((relay) => {
      const member = members.get(relay.id);
      const advertised = (relay.capabilities?.features ?? []).includes(AVAILABILITY_LEASE_CAPABILITY);
      return {
        id: relay.id,
        role: 'relay' as const,
        kind: 'relay' as const,
        nodeId: relay.nodeId,
        hostKey: relay.hostIdentityId ?? relay.nodeId ?? `relay:${relay.id}`,
        local: relay.kind === 'local',
        capable: leaseMemberCapable('relay', advertised, member),
        publicKey: member?.identityPublicKey ?? null,
        online: ['synchronizing', 'ready', 'draining'].includes(relay.state),
      };
    });
  const daemons: LeaseParticipant[] = daemonRows.map((node) => {
    const member = members.get(node.id);
    const connected = registry.getNode(node.id);
    const advertised = connected
      ? connected.capabilities.has(AVAILABILITY_LEASE_CAPABILITY)
      : persistedCapabilities(node.capabilities).includes(AVAILABILITY_LEASE_CAPABILITY);
    const kind = node.type === 'nginx' ? ('nginx' as const) : ('docker' as const);
    return {
      id: node.id,
      role: 'daemon' as const,
      kind,
      nodeId: node.id,
      hostKey: node.hostIdentityId ?? node.id,
      capable: leaseMemberCapable(kind, advertised, member),
      publicKey: member?.identityPublicKey ?? null,
      online: Boolean(connected) || node.status === 'online',
      offlineSince: connected || node.status === 'online' ? null : (node.lastSeenAt?.getTime() ?? null),
      hostsCandidate: candidateNodes.has(node.id),
      hostsIngress: ingressNodes.has(node.id),
    };
  });
  const byId = new Map<string, LeaseParticipant>();
  for (const participant of [...relays, ...daemons]) byId.set(participant.id, participant);
  return { relays, daemons, byId };
}
