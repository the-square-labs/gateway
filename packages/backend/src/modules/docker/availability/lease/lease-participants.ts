import { eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, relayInstances } from '@/db/schema/index.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { AVAILABILITY_LEASE_CAPABILITY } from './lease-constants.js';
import type { LeaseMemberRow } from './lease-store.js';
import type { LeaseVoterCandidateNode, LeaseWitnessCandidate } from './lease-voters.js';

export interface LeaseParticipant {
  id: string;
  role: 'relay' | 'daemon';
  kind: 'docker' | 'nginx' | 'relay';
  /** Node id of the daemon; for relays the relay daemon's node, null for the local relay. */
  nodeId: string | null;
  /**
   * Physical host (A20). Daemons: their host identity, else their node id. Relays: the host identity of the node that
   * runs them, else that node's id; a relay without a node (the local combined relay) uses its fault domain, so relays
   * sharing a fault domain count as one host. Voters are deduplicated by this key across docker, nginx and relay.
   */
  hostKey: string;
  /** Relay fault domain; null for daemons. */
  faultDomain: string | null;
  /** Advertises availability_lease_v1, reported an identity key and (docker) a fresh watchdog. */
  capable: boolean;
  publicKey: string | null;
}

export interface LeaseParticipants {
  relays: LeaseParticipant[];
  daemons: LeaseParticipant[];
  byId: Map<string, LeaseParticipant>;
  /** Fault domains of relays running on each host key, for the witness fallback (A19). */
  hostFaultDomains: Map<string, string[]>;
  /** Smoothed round trip (ms) a node last reported to a relay, from the relay topology data. */
  relayRtt(nodeId: string, relayId: string): number | undefined;
}

/**
 * A9: only relays in the operator's own enrolled pools take part. Every relay pool Gateway knows today is enrolled by
 * the operator; a managed or third-party pool type must return false here.
 */
export function isOperatorOwnedRelayPool(_poolId: string): boolean {
  return true;
}

function persistedCapabilities(value: unknown): string[] {
  const list = (value as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

function relayLatencies(report: unknown): Map<string, number> {
  const list = (report as { relayLatencies?: unknown } | null)?.relayLatencies;
  const result = new Map<string, number>();
  if (!Array.isArray(list)) return result;
  for (const entry of list as Array<{ relayInstanceId?: unknown; rttMs?: unknown }>) {
    if (typeof entry?.relayInstanceId === 'string' && typeof entry.rttMs === 'number' && Number.isFinite(entry.rttMs)) {
      result.set(entry.relayInstanceId, entry.rttMs);
    }
  }
  return result;
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
  const [relayRows, daemonRows] = await Promise.all([
    db
      .select({
        id: relayInstances.id,
        poolId: relayInstances.poolId,
        nodeId: relayInstances.nodeId,
        faultDomainId: relayInstances.faultDomainId,
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
        hostIdentityId: nodes.hostIdentityId,
        capabilities: nodes.capabilities,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(nodes)
      .where(inArray(nodes.type, ['docker', 'nginx'])),
  ]);
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
        hostKey: relay.hostIdentityId ?? relay.nodeId ?? `relay-fault-domain:${relay.faultDomainId}`,
        faultDomain: relay.faultDomainId,
        capable: leaseMemberCapable('relay', advertised, member),
        publicKey: member?.identityPublicKey ?? null,
      };
    });
  const latencies = new Map<string, Map<string, number>>();
  const daemons: LeaseParticipant[] = daemonRows.map((node) => {
    const member = members.get(node.id);
    const connected = registry.getNode(node.id);
    const advertised = connected
      ? connected.capabilities.has(AVAILABILITY_LEASE_CAPABILITY)
      : persistedCapabilities(node.capabilities).includes(AVAILABILITY_LEASE_CAPABILITY);
    const kind = node.type === 'nginx' ? ('nginx' as const) : ('docker' as const);
    latencies.set(node.id, relayLatencies(connected?.lastHealthReport ?? node.lastHealthReport));
    return {
      id: node.id,
      role: 'daemon' as const,
      kind,
      nodeId: node.id,
      hostKey: node.hostIdentityId ?? node.id,
      faultDomain: null,
      capable: leaseMemberCapable(kind, advertised, member),
      publicKey: member?.identityPublicKey ?? null,
    };
  });
  const byId = new Map<string, LeaseParticipant>();
  for (const participant of [...relays, ...daemons]) byId.set(participant.id, participant);
  const hostFaultDomains = new Map<string, string[]>();
  for (const relay of relays) {
    if (relay.faultDomain)
      hostFaultDomains.set(relay.hostKey, [...(hostFaultDomains.get(relay.hostKey) ?? []), relay.faultDomain]);
  }
  return {
    relays,
    daemons,
    byId,
    hostFaultDomains,
    relayRtt: (nodeId, relayId) => latencies.get(nodeId)?.get(relayId),
  };
}

/** Candidate nodes of a policy, in rank order, as voter candidates (A18). */
export function leaseVoterCandidates(
  participants: LeaseParticipants,
  rankedNodeIds: string[]
): LeaseVoterCandidateNode[] {
  return rankedNodeIds.flatMap((id) => {
    const participant = participants.byId.get(id);
    if (!participant) return [];
    return [
      {
        id,
        hostKey: participant.hostKey,
        faultDomains: participants.hostFaultDomains.get(participant.hostKey) ?? [],
        publicKey: participant.publicKey,
      },
    ];
  });
}

/**
 * Members that may be a witness (A19): relays and docker daemons. nginx daemons are observers only. Round trips are
 * known only from a candidate node to a relay (relay topology data); docker witnesses rank without one.
 */
export function leaseWitnessPool(participants: LeaseParticipants): LeaseWitnessCandidate[] {
  return [...participants.relays, ...participants.daemons.filter((daemon) => daemon.kind === 'docker')].map(
    (participant) => ({
      id: participant.id,
      kind: participant.kind === 'relay' ? ('relay' as const) : ('docker' as const),
      hostKey: participant.hostKey,
      faultDomain: participant.faultDomain,
      capable: participant.capable,
      publicKey: participant.publicKey,
      rttFrom: (candidateId: string) =>
        participant.kind === 'relay' ? participants.relayRtt(candidateId, participant.id) : undefined,
    })
  );
}
