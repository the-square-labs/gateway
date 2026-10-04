import { createPrivateKey, randomUUID, sign as signBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayGrantSigningKeys,
  relayInstances,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import type { SignedRelayGrant } from '@/grpc/relay-control.client.js';
import { leaseLaneNodeIds, leaseLaneRelays } from '@/modules/docker/availability/lease/lease-relay-lanes.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  effectiveRelayGrantTtlHours,
  LEGACY_RELAY_GRANT_TTL_MAX_HOURS,
  LONG_POLICY_LEASE_CAPABILITY,
} from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import type { RelayRevokedRouteFence } from './relay-revocation-fence.js';
import { loadRevocationFenceState } from './relay-revocation-fence.service.js';
import { effectiveRelayMaxConcurrentSessions } from './relay-session-limits.js';
import { candidateTopology } from './relay-topology.js';
import { type RelayLatencyTarget, RelayTopologyService } from './relay-topology.service.js';

const POLICY_ID = 'current';

/** Placeholder grant of a lease lane candidate: daemons require one per candidate, relays never see it. */
const EMPTY_LEASE_LANE_GRANT: SignedRelayGrant = { keyId: '', payload: Buffer.alloc(0), signature: Buffer.alloc(0) };

type GrantKind = 'endpoint' | 'connect';

export interface RelayGrantClaims {
  schemaVersion: 1 | 2;
  audience: 'wiolett-relay';
  grantId: string;
  gatewayInstanceId: string;
  kind: GrantKind;
  subjectKind: string;
  subjectId: string;
  certificateSha256: string;
  poolId?: string;
  relayInstanceId?: string;
  assignmentGeneration?: number;
  endpointId?: string;
  endpointGeneration?: number;
  routeId?: string;
  routeGeneration?: number;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  maxConcurrentSessions?: number;
  maxFrameBytes?: number;
}

export interface RelayGrantAssignment {
  /** `lease` carries transport targets only (lease lanes, see leaseLaneAssignment); it grants nothing. */
  role: GrantKind | 'lease';
  ownerKind: string;
  ownerId: string;
  endpointId?: string;
  routeId?: string;
  targetEndpointId?: string;
  grant: SignedRelayGrant;
  schemaVersion?: number;
  candidates?: RelayDataCandidate[];
  managedDatabaseListener?: {
    networkName: string;
    listenAddress: string;
    listenPort: number;
    allowedSources: string[];
    routeGeneration: number;
  };
  /** The connector egress listener of a link on its source node (C2); only on connect assignments. */
  secureLinkEgress?: {
    networkName: string;
    alias: string;
    listenPort: number;
    maxSessions: number;
    tlsCaPem?: string;
    tlsServerName?: string;
    routeGeneration: number;
    /** The connector image, for a node that has egress but no proxy Secure Link binding to take it from. */
    connectorImage?: string;
  };
}

export interface RelayDataCandidate {
  poolId: string;
  relayInstanceId: string;
  assignmentGeneration: string;
  addresses: string[];
  port: number;
  certificateIdentity: string;
  certificateFingerprint: string;
  capabilities: string[];
  grant: SignedRelayGrant;
  assignmentState: 'active' | 'staging' | 'draining';
  /** Absent when Gateway placed the endpoint without latency data. */
  topology?: { role: 'primary' | 'standby'; endpointRttMicros: number };
}

export interface RelayGrantBundle {
  revision: string;
  generatedAtUnixMs: string;
  grants: RelayGrantAssignment[];
  dataLanes?: number;
  readChunkBytes?: number;
  relayLatencyTargets?: RelayLatencyTarget[];
  /** Stale relays this daemon's endpoints must refuse revoked routes through. */
  revocationFences?: RelayRevokedRouteFence[];
}

export class RelayPolicyNotAcknowledgedError extends Error {
  constructor(readonly revision: number) {
    super(`Relay policy revision ${revision} has not been durably acknowledged`);
    this.name = 'RelayPolicyNotAcknowledgedError';
  }
}

export class RelayGrantIssuerService {
  private acknowledgedRevision = 0;
  /** A revision grants may be signed for without the local relay's acknowledgement. */
  private fenceBypassRevision = 0;
  private lastBundleGeneratedAtMs = 0;
  private readonly topology: RelayTopologyService;
  /** The shared secure-link connector image egress assignments name (SECURE_LINK_CONNECTOR_IMAGE). */
  private connectorImage = '';

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly settings: GeneralSettingsService
  ) {
    this.topology = new RelayTopologyService(db);
  }

  setConnectorImage(image: string): void {
    this.connectorImage = image;
  }

  acknowledgeRevision(revision: number): void {
    this.acknowledgedRevision = Math.max(this.acknowledgedRevision, revision);
  }

  /**
   * Allows grants for this revision while the local relay cannot take it. The fence exists so
   * a relay never sees grants ahead of its policy; an unreachable local relay sees nothing,
   * and holding every grant back would stop remote relays too once their grants expire.
   */
  allowUnacknowledgedRevision(revision: number): void {
    this.fenceBypassRevision = Math.max(this.fenceBypassRevision, revision);
  }

  async requireState() {
    const [state] = await this.db.select().from(relayPolicyState).where(eq(relayPolicyState.id, POLICY_ID)).limit(1);
    if (!state) throw new Error('Relay policy state is not initialized');
    return state;
  }

  async requireNodeIdentity(nodeId: string): Promise<{ certificateFingerprint: string }> {
    const [node] = await this.db
      .select({ certificateFingerprint: nodes.certificateFingerprint })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node?.certificateFingerprint)
      throw new Error(`Node ${nodeId} does not have a current certificate fingerprint`);
    return { certificateFingerprint: node.certificateFingerprint };
  }

  async policyNodeIds(): Promise<string[]> {
    const [endpoints, routes] = await Promise.all([
      this.db
        .select({ nodeId: relayEndpoints.subjectId })
        .from(relayEndpoints)
        .where(eq(relayEndpoints.subjectKind, 'daemon')),
      this.db.select({ nodeId: relayRoutes.sourceId, sourceKind: relayRoutes.sourceKind }).from(relayRoutes),
    ]);
    return [
      ...new Set([
        ...endpoints.map(({ nodeId }) => nodeId),
        ...routes.filter(({ sourceKind }) => sourceKind === 'daemon').map(({ nodeId }) => nodeId),
        // A voter without any endpoint still needs its lease lanes refreshed.
        ...(await leaseLaneNodeIds(this.db).catch(() => [])),
      ]),
    ];
  }

  async getNodeGrantBundle(nodeId: string): Promise<RelayGrantBundle> {
    const node = await this.requireNodeIdentity(nodeId);
    const [state, endpoints, routes, targetEndpoints] = await Promise.all([
      this.requireState(),
      this.db.select().from(relayEndpoints).where(eq(relayEndpoints.subjectId, nodeId)),
      this.db.select().from(relayRoutes).where(eq(relayRoutes.sourceId, nodeId)),
      this.db.select().from(relayEndpoints),
    ]);
    const activeEndpointIds = new Set(targetEndpoints.filter(({ status }) => status === 'active').map(({ id }) => id));
    const grants: RelayGrantAssignment[] = [];
    const [poolProjection, revocations] = await Promise.all([
      this.getPoolProjection(),
      loadRevocationFenceState(this.db),
    ]);
    const activeOwnEndpoints = endpoints.filter(({ status }) => status === 'active');
    for (const endpoint of activeOwnEndpoints) {
      const grant = await this.signGrant({
        kind: 'endpoint',
        subjectKind: endpoint.subjectKind,
        subjectId: nodeId,
        certificateSha256: node.certificateFingerprint,
        endpointId: endpoint.id,
        endpointGeneration: endpoint.generation,
        maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint),
      });
      const candidates = await this.issueCandidates(
        poolProjection.get(endpoint.id) ?? [],
        'endpoint',
        nodeId,
        node.certificateFingerprint,
        endpoint,
        undefined,
        true
      );
      grants.push({
        role: 'endpoint',
        ownerKind: endpoint.ownerKind,
        ownerId: endpoint.ownerId,
        endpointId: endpoint.id,
        grant,
        schemaVersion: candidates.length ? 2 : 1,
        candidates,
      });
    }
    for (const route of routes.filter(({ targetEndpointId }) => activeEndpointIds.has(targetEndpointId))) {
      const grant = await this.signGrant({
        kind: 'connect',
        subjectKind: route.sourceKind,
        subjectId: nodeId,
        certificateSha256: node.certificateFingerprint,
        routeId: route.id,
        routeGeneration: route.generation,
        maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route),
        maxFrameBytes: route.maxFrameBytes,
      });
      const endpoint = targetEndpoints.find(({ id }) => id === route.targetEndpointId);
      // A relay stale for this route may still admit a revoked tuple of it; never send the
      // source there. The current tuple would not pass that relay's policy anyway.
      const staleRelays = revocations.staleRelaysByRoute.get(route.id);
      const candidates = endpoint
        ? await this.issueCandidates(
            (poolProjection.get(route.targetEndpointId) ?? []).filter(
              ({ instanceId }) => !staleRelays?.has(instanceId)
            ),
            'connect',
            nodeId,
            node.certificateFingerprint,
            endpoint,
            route,
            true
          )
        : [];
      grants.push({
        role: 'connect',
        ownerKind: route.ownerKind,
        ownerId: route.ownerId,
        routeId: route.id,
        targetEndpointId: route.targetEndpointId,
        grant,
        schemaVersion: candidates.length ? 2 : 1,
        candidates,
        managedDatabaseListener: route.managedDatabaseListener
          ? { ...route.managedDatabaseListener, routeGeneration: route.generation }
          : undefined,
        secureLinkEgress: route.secureLinkEgress
          ? {
              ...route.secureLinkEgress,
              routeGeneration: route.generation,
              ...(this.connectorImage ? { connectorImage: this.connectorImage } : {}),
            }
          : undefined,
      });
    }
    // Lease lanes only add transports; they must never hold grants back.
    const leaseLanes = await this.leaseLaneAssignment(nodeId).catch(() => null);
    if (leaseLanes) grants.push(leaseLanes);
    // Latency only orders relays; it must never hold grants back.
    const relayLatencyTargets = await this.topology.completeGrantBundle(grants, targetEndpoints).catch(() => []);
    const revocationFences = await revocations.fencesForEndpoints(activeOwnEndpoints.map(({ id }) => id));
    this.lastBundleGeneratedAtMs = Math.max(Date.now(), this.lastBundleGeneratedAtMs + 1);
    return {
      revision: String(state.revision),
      generatedAtUnixMs: String(this.lastBundleGeneratedAtMs),
      grants,
      relayLatencyTargets,
      ...(revocationFences.length ? { revocationFences } : {}),
    };
  }

  private async getPoolProjection() {
    const rows = await this.db
      .select({
        endpointId: relayEndpointAssignmentGenerations.endpointId,
        generation: relayEndpointAssignmentGenerations.generation,
        state: relayEndpointAssignmentGenerations.state,
        role: relayEndpointAssignments.role,
        instanceState: relayInstances.state,
        poolId: relayInstances.poolId,
        instanceId: relayInstances.id,
        kind: relayInstances.kind,
        addresses: relayInstances.advertisedAddresses,
        port: relayInstances.servicePort,
        certificateIdentity: relayInstances.certificateIdentity,
        certificateFingerprint: relayInstances.certificateFingerprint,
        capabilities: relayInstances.capabilities,
      })
      .from(relayEndpointAssignments)
      .innerJoin(
        relayEndpointAssignmentGenerations,
        eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
      )
      .innerJoin(relayInstances, eq(relayEndpointAssignments.relayInstanceId, relayInstances.id))
      .where(inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining']));
    // Within an assignment state, relays that serve come first: callers try candidates in order,
    // and each unreachable relay costs a connect timeout.
    const serving = (row: (typeof rows)[number]) => (row.instanceState === 'ready' ? 0 : 1);
    rows.sort((left, right) => {
      const stateOrder = { active: 0, staging: 1, draining: 2, retired: 3, failed: 4 } as const;
      return (
        stateOrder[left.state] - stateOrder[right.state] ||
        serving(left) - serving(right) ||
        left.generation - right.generation ||
        left.instanceId.localeCompare(right.instanceId)
      );
    });
    const byEndpoint = new Map<string, typeof rows>();
    for (const row of rows) {
      const current = byEndpoint.get(row.endpointId) ?? [];
      current.push(row);
      byEndpoint.set(row.endpointId, current);
    }
    return byEndpoint;
  }

  private async issueCandidates(
    assignments: Awaited<ReturnType<RelayGrantIssuerService['getPoolProjection']>> extends Map<string, infer Rows>
      ? Rows
      : never,
    kind: GrantKind,
    subjectId: string,
    certificateSha256: string,
    endpoint: Pick<
      typeof relayEndpoints.$inferSelect,
      'id' | 'generation' | 'subjectKind' | 'ownerKind' | 'maxConcurrentSessions'
    >,
    route:
      | Pick<
          typeof relayRoutes.$inferSelect,
          'id' | 'generation' | 'sourceKind' | 'ownerKind' | 'maxConcurrentSessions' | 'maxFrameBytes'
        >
      | undefined,
    includeStaging: boolean,
    requireSubjectNodeCapability = true
  ): Promise<RelayDataCandidate[]> {
    if (
      !assignments.length ||
      (requireSubjectNodeCapability && !(await this.nodeSupportsPool(subjectId))) ||
      !(await this.endpointPathSupportsPool(endpoint.id))
    )
      return [];
    const selected = assignments.filter(({ state }) => includeStaging || state === 'active');
    if (!selected.length || selected.some((assignment) => !this.instanceSupportsPool(assignment))) return [];
    const result: RelayDataCandidate[] = [];
    for (const assignment of selected) {
      const grant = await this.signGrant({
        schemaVersion: 2,
        kind,
        subjectKind: kind === 'endpoint' ? endpoint.subjectKind : route!.sourceKind,
        subjectId,
        certificateSha256,
        poolId: assignment.poolId,
        relayInstanceId: assignment.instanceId,
        assignmentGeneration: assignment.generation,
        longLeaseCapable: this.instanceCapabilities(assignment).includes(LONG_POLICY_LEASE_CAPABILITY),
        // The relay enforces the lower of the policy and grant limits, so a candidate grant
        // must carry the same effective limit as the policy or it caps the route below it.
        ...(kind === 'endpoint'
          ? {
              endpointId: endpoint.id,
              endpointGeneration: endpoint.generation,
              maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint),
            }
          : {
              routeId: route!.id,
              routeGeneration: route!.generation,
              maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route!),
              maxFrameBytes: route!.maxFrameBytes,
            }),
      });
      const topology = candidateTopology(assignment.role);
      result.push({
        poolId: assignment.poolId,
        relayInstanceId: assignment.instanceId,
        assignmentGeneration: String(assignment.generation),
        addresses: assignment.addresses,
        port: assignment.port,
        certificateIdentity: assignment.certificateIdentity ?? '',
        certificateFingerprint: assignment.certificateFingerprint ?? '',
        capabilities: this.instanceCapabilities(assignment),
        grant,
        assignmentState:
          assignment.instanceState === 'draining'
            ? 'draining'
            : (assignment.state as 'active' | 'staging' | 'draining'),
        ...(topology ? { topology } : {}),
      });
    }
    return result;
  }

  private async nodeSupportsPool(nodeId: string): Promise<boolean> {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return Array.isArray(node?.capabilities?.capabilities) && node.capabilities.capabilities.includes('relay_pool_v1');
  }

  private async endpointPathSupportsPool(endpointId: string): Promise<boolean> {
    const [[endpoint], routes] = await Promise.all([
      this.db
        .select({ nodeId: relayEndpoints.subjectId, subjectKind: relayEndpoints.subjectKind })
        .from(relayEndpoints)
        .where(eq(relayEndpoints.id, endpointId))
        .limit(1),
      this.db
        .select({ sourceKind: relayRoutes.sourceKind, sourceId: relayRoutes.sourceId })
        .from(relayRoutes)
        .where(eq(relayRoutes.targetEndpointId, endpointId)),
    ]);
    if (!endpoint) return false;
    if (endpoint.subjectKind !== 'daemon' && endpoint.subjectKind !== 'local_service') return false;
    const nodeIds = [
      ...(endpoint.subjectKind === 'daemon' ? [endpoint.nodeId] : []),
      ...routes.filter(({ sourceKind }) => sourceKind === 'daemon').map(({ sourceId }) => sourceId),
    ];
    const unique = [...new Set(nodeIds)];
    const rows = await this.db
      .select({ id: nodes.id, capabilities: nodes.capabilities })
      .from(nodes)
      .where(inArray(nodes.id, unique));
    return (
      rows.length === unique.length &&
      rows.every(
        ({ capabilities }) =>
          Array.isArray(capabilities?.capabilities) && capabilities.capabilities.includes('relay_pool_v1')
      )
    );
  }

  /**
   * Endpoints whose path (target daemon and every daemon source) is not fully Relay Pool
   * capable, in bulk: the same rule endpointPathSupportsPool applies to candidate issuance.
   * Such endpoints get only legacy grants, which only the local relay serves.
   */
  async poolIncapableEndpointIds(endpointIds: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    if (!endpointIds.length) return result;
    const [endpoints, routes] = await Promise.all([
      this.db
        .select({ id: relayEndpoints.id, nodeId: relayEndpoints.subjectId, subjectKind: relayEndpoints.subjectKind })
        .from(relayEndpoints)
        .where(inArray(relayEndpoints.id, endpointIds)),
      this.db
        .select({
          endpointId: relayRoutes.targetEndpointId,
          sourceKind: relayRoutes.sourceKind,
          sourceId: relayRoutes.sourceId,
        })
        .from(relayRoutes)
        .where(inArray(relayRoutes.targetEndpointId, endpointIds)),
    ]);
    const participants = new Map<string, string[]>();
    for (const endpoint of endpoints) {
      if (endpoint.subjectKind !== 'daemon' && endpoint.subjectKind !== 'local_service') {
        result.add(endpoint.id);
        continue;
      }
      participants.set(endpoint.id, endpoint.subjectKind === 'daemon' ? [endpoint.nodeId] : []);
    }
    for (const route of routes) {
      if (route.sourceKind === 'daemon') participants.get(route.endpointId)?.push(route.sourceId);
    }
    const nodeIds = [...new Set([...participants.values()].flat())];
    const capable = new Set(
      nodeIds.length
        ? (
            await this.db
              .select({ id: nodes.id, capabilities: nodes.capabilities })
              .from(nodes)
              .where(inArray(nodes.id, nodeIds))
          )
            .filter(
              ({ capabilities }) =>
                Array.isArray(capabilities?.capabilities) && capabilities.capabilities.includes('relay_pool_v1')
            )
            .map(({ id }) => id)
        : []
    );
    for (const [endpointId, nodeIdsOnPath] of participants) {
      if (nodeIdsOnPath.some((nodeId) => !capable.has(nodeId))) result.add(endpointId);
    }
    return result;
  }

  /**
   * Lease lanes (stand run c1): a node that takes part in a lease-mode Availability policy keeps a transport to every
   * member relay, whether or not one of its endpoints is assigned there, so its lease frames never depend on Gateway's
   * local relay. The assignment only names transport targets: daemons derive their relay transports from every
   * assignment's candidates and ignore roles they do not handle. Its grants are empty and authorize nothing; relays
   * admit the lease stream by manifest membership.
   */
  private async leaseLaneAssignment(nodeId: string): Promise<RelayGrantAssignment | null> {
    const relays = await leaseLaneRelays(this.db, nodeId);
    if (relays.length === 0) return null;
    return {
      role: 'lease',
      ownerKind: 'availability_lease',
      ownerId: nodeId,
      grant: EMPTY_LEASE_LANE_GRANT,
      schemaVersion: 2,
      candidates: relays.map((relay) => ({
        poolId: relay.poolId,
        relayInstanceId: relay.id,
        assignmentGeneration: '1',
        addresses: relay.addresses,
        port: relay.port,
        certificateIdentity: relay.certificateIdentity,
        certificateFingerprint: relay.certificateFingerprint,
        capabilities: relay.capabilities,
        grant: EMPTY_LEASE_LANE_GRANT,
        assignmentState: 'active',
      })),
    };
  }

  private instanceCapabilities(instance: { kind: 'local' | 'remote'; capabilities: unknown }): string[] {
    if (!instance.capabilities || typeof instance.capabilities !== 'object') return [];
    const features = (instance.capabilities as { features?: unknown }).features;
    return Array.isArray(features) ? features.filter((value): value is string => typeof value === 'string') : [];
  }

  private instanceSupportsPool(instance: { kind: 'local' | 'remote'; capabilities: unknown }): boolean {
    return this.instanceCapabilities(instance).includes('relay_pool_v1');
  }

  async issueGatewayConnectGrant(routeId: string, appCertificateFingerprint: string): Promise<SignedRelayGrant> {
    return (await this.issueGatewayConnectAssignment(routeId, appCertificateFingerprint)).grant;
  }

  async issueGatewayConnectAssignment(routeId: string, appCertificateFingerprint: string) {
    const [route] = await this.db.select().from(relayRoutes).where(eq(relayRoutes.id, routeId)).limit(1);
    if (!route || route.sourceKind !== 'gateway' || route.sourceCertificateSha256 !== appCertificateFingerprint)
      throw new Error('Gateway relay route is unavailable');
    const [endpoint] = await this.db
      .select()
      .from(relayEndpoints)
      .where(eq(relayEndpoints.id, route.targetEndpointId))
      .limit(1);
    if (endpoint?.status !== 'active') throw new Error('Gateway relay endpoint is unavailable');
    const grant = await this.signGrant({
      kind: 'connect',
      subjectKind: route.sourceKind,
      subjectId: route.sourceId,
      certificateSha256: appCertificateFingerprint,
      routeId: route.id,
      routeGeneration: route.generation,
      maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route),
      maxFrameBytes: route.maxFrameBytes,
    });
    const [projection, revocations] = await Promise.all([this.getPoolProjection(), loadRevocationFenceState(this.db)]);
    const staleRelays = revocations.staleRelaysByRoute.get(route.id);
    const assignments = (projection.get(endpoint.id) ?? []).filter(({ instanceId }) => !staleRelays?.has(instanceId));
    const candidates = await this.issueCandidates(
      assignments,
      'connect',
      route.sourceId,
      appCertificateFingerprint,
      endpoint,
      route,
      true,
      false
    );
    const kindByInstance = new Map(assignments.map(({ instanceId, kind }) => [instanceId, kind]));
    return {
      grant,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        local: kindByInstance.get(candidate.relayInstanceId) === 'local',
      })),
    };
  }

  private async signGrant(
    input: Omit<
      RelayGrantClaims,
      'schemaVersion' | 'audience' | 'grantId' | 'gatewayInstanceId' | 'issuedAt' | 'notBefore' | 'expiresAt'
    > & {
      schemaVersion?: 1 | 2;
      /**
       * Set only for a grant scoped to one relay instance that reported
       * LONG_POLICY_LEASE_CAPABILITY. Every other grant (legacy schemaVersion 1, or one whose
       * target has not upgraded) keeps the 48-hour cap an older relay still enforces.
       */
      longLeaseCapable?: boolean;
    }
  ): Promise<SignedRelayGrant> {
    const { longLeaseCapable, ...claimsInput } = input;
    const [state, settings, active] = await Promise.all([
      this.requireState(),
      this.settings.getConfig(),
      this.db
        .select()
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'active'))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!active?.encryptedPrivateKey || !active.encryptedDek)
      throw new Error('Active relay signing key is unavailable');
    if (state.revision > this.acknowledgedRevision && state.revision > this.fenceBypassRevision) {
      throw new RelayPolicyNotAcknowledgedError(state.revision);
    }
    const now = Math.floor(Date.now() / 1000);
    // A grant not scoped to a specific upgraded relay instance keeps the legacy cap: an older
    // relay build rejects any grant lifetime past LEGACY_RELAY_GRANT_TTL_MAX_HOURS outright.
    const ttlHours = longLeaseCapable
      ? effectiveRelayGrantTtlHours(settings.relayGrantTtlHours, settings.relayPolicyLeaseHours)
      : Math.min(settings.relayGrantTtlHours, LEGACY_RELAY_GRANT_TTL_MAX_HOURS);
    const claims: RelayGrantClaims = {
      schemaVersion: claimsInput.schemaVersion ?? 1,
      audience: 'wiolett-relay',
      grantId: randomUUID(),
      gatewayInstanceId: state.gatewayInstanceId,
      ...claimsInput,
      issuedAt: now,
      notBefore: now,
      expiresAt: now + ttlHours * 60 * 60,
    };
    const payload = Buffer.from(JSON.stringify(claims));
    const privateKeyPem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: active.encryptedPrivateKey,
      encryptedDek: active.encryptedDek,
      dekIv: '',
    });
    return { keyId: active.keyId, payload, signature: signBytes(null, payload, createPrivateKey(privateKeyPem)) };
  }
}
