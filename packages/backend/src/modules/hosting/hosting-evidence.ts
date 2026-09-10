import { createHash } from 'node:crypto';
import { isAlwaysBlockedOutboundIp, normalizeIp } from '@/lib/ip-cidr.js';
import { isPubliclyRoutableIp } from '@/modules/nodes/node-service-address.js';
import type { HostingResourceSnapshot } from './hosting-provider.types.js';

export const HOSTING_EVIDENCE_TTL_MS = 5 * 60 * 1000;
export interface HostingNodeEvidence {
  nodeId: string;
  hostIdentityId: string | null;
  registeredHostIdentityId?: string | null;
  observedAt: string | null;
  /** Read from the authenticated daemon interface, NOT serviceAddresses or external egress. */
  interfaces: Array<{ ip: string; mac?: string }>;
  /** CAS source for the authenticated interface report used to collect these addresses. */
  interfaceSnapshot?: string;
}
export interface HostingResourceEvidence {
  id: string;
  snapshot: HostingResourceSnapshot;
  managedHostIdentity: string | null;
  /** Fixed-path read from this exact provider resource through an independent trusted channel. */
  guestHostIdentity?: string | null;
}
export interface HostingAdoptionDecision {
  resourceId: string;
  hostIdentityId: string | null;
  nodeIds: string[];
  reason:
    | 'guest_identity'
    | 'interface_match'
    | 'direct_ip'
    | 'incomplete_inventory'
    | 'no_evidence'
    | 'ambiguous'
    | 'already_bound_elsewhere';
  evidenceDigest: string | null;
}

function fresh(observedAt: string | null, now: number): boolean {
  const time = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(time) && time <= now + 30_000 && now - time <= HOSTING_EVIDENCE_TTL_MS;
}
function mac(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase().replaceAll('-', ':');
  return normalized && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized) && normalized !== '00:00:00:00:00:00'
    ? normalized
    : undefined;
}
function address(value: string): string | undefined {
  const ip = normalizeIp(value);
  return ip && !isAlwaysBlockedOutboundIp(ip) ? ip : undefined;
}
function directPublicIp(value: string): boolean {
  return isPubliclyRoutableIp(value);
}

/** Pure, deterministic matching. Ambiguity never becomes a manual-choice workflow. */
export function evaluateHostingAdoption(input: {
  resources: HostingResourceEvidence[];
  nodes: HostingNodeEvidence[];
  inventoryComplete: boolean;
  existingBindings?: Array<{ nodeId: string; resourceId: string }>;
  now?: number;
}): HostingAdoptionDecision[] {
  const now = input.now ?? Date.now();
  const decisions = new Map<string, HostingAdoptionDecision>();
  const groups = new Map<string, HostingNodeEvidence[]>();
  for (const node of input.nodes) {
    if (!node.hostIdentityId) continue;
    const group = groups.get(node.hostIdentityId) ?? [];
    group.push(node);
    groups.set(node.hostIdentityId, group);
  }
  const edges: Array<{
    resource: HostingResourceEvidence;
    host: string;
    nodes: HostingNodeEvidence[];
    reason: HostingAdoptionDecision['reason'];
    bindingConflict: boolean;
  }> = [];
  for (const resource of input.resources) {
    const skip = (reason: HostingAdoptionDecision['reason']) =>
      decisions.set(resource.id, {
        resourceId: resource.id,
        hostIdentityId: null,
        nodeIds: [],
        reason,
        evidenceDigest: null,
      });
    if (!input.inventoryComplete) {
      skip('incomplete_inventory');
      continue;
    }
    if (!fresh(resource.snapshot.observedAt, now)) {
      skip('no_evidence');
      continue;
    }
    for (const [host, nodes] of groups) {
      if (resource.managedHostIdentity && resource.managedHostIdentity !== host) continue;
      let reason: HostingAdoptionDecision['reason'] | undefined;
      if (resource.guestHostIdentity === host) reason = 'guest_identity';
      else if (resource.guestHostIdentity)
        continue; // Contradictory immutable evidence wins over IP.
      else
        for (const node of nodes) {
          if (!fresh(node.observedAt, now)) continue;
          for (const iface of node.interfaces) {
            const ip = address(iface.ip);
            if (!ip) continue;
            for (const remote of resource.snapshot.addresses) {
              if (!remote.direct || address(remote.ip) !== ip) continue;
              const localMac = mac(iface.mac);
              const remoteMac = mac(remote.mac);
              if (localMac && remoteMac && localMac !== remoteMac) continue;
              if (localMac && remoteMac) reason = 'interface_match';
              else if (directPublicIp(ip)) reason = 'direct_ip';
            }
          }
        }
      if (!reason) continue;
      const existingConflict = nodes.some((node) =>
        input.existingBindings?.some((binding) => binding.nodeId === node.nodeId && binding.resourceId !== resource.id)
      );
      edges.push({ resource, host, nodes, reason, bindingConflict: existingConflict });
    }
    if (!edges.some((edge) => edge.resource.id === resource.id) && !decisions.has(resource.id)) skip('no_evidence');
  }
  for (const edge of edges) {
    const resourceEdges = edges.filter((candidate) => candidate.resource.id === edge.resource.id);
    const hostEdges = edges.filter((candidate) => candidate.host === edge.host);
    if (resourceEdges.length !== 1 || hostEdges.length !== 1) {
      decisions.set(edge.resource.id, {
        resourceId: edge.resource.id,
        hostIdentityId: null,
        nodeIds: [],
        reason: 'ambiguous',
        evidenceDigest: null,
      });
      continue;
    }
    if (edge.bindingConflict) {
      decisions.set(edge.resource.id, {
        resourceId: edge.resource.id,
        hostIdentityId: null,
        nodeIds: [],
        reason: 'already_bound_elsewhere',
        evidenceDigest: null,
      });
      continue;
    }
    const nodeIds = edge.nodes.map((node) => node.nodeId).sort();
    const proof = JSON.stringify({
      resourceId: edge.resource.id,
      incarnation: edge.resource.snapshot.incarnation,
      host: edge.host,
      nodeIds,
      reason: edge.reason,
      addresses: edge.resource.snapshot.addresses,
    });
    decisions.set(edge.resource.id, {
      resourceId: edge.resource.id,
      hostIdentityId: edge.host,
      nodeIds,
      reason: edge.reason,
      evidenceDigest: createHash('sha256').update(proof).digest('hex'),
    });
  }
  return input.resources.map((resource) => decisions.get(resource.id)!);
}
