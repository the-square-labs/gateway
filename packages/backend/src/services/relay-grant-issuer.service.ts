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
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import { effectiveRelayMaxConcurrentSessions } from './relay-session-limits.js';

const POLICY_ID = 'current';

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
  role: GrantKind;
  ownerKind: string;
  ownerId: string;
  endpointId?: string;
  routeId?: string;
  targetEndpointId?: string;
  grant: SignedRelayGrant;
  schemaVersion?: number;
  candidates?: RelayDataCandidate[];
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
}

export interface RelayGrantBundle {
  revision: string;
  generatedAtUnixMs: string;
  grants: RelayGrantAssignment[];
  dataLanes?: number;
  readChunkBytes?: number;
}

export class RelayGrantIssuerService {
  private acknowledgedRevision = 0;
  private lastBundleGeneratedAtMs = 0;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly settings: GeneralSettingsService
  ) {}

  acknowledgeRevision(revision: number): void {
    this.acknowledgedRevision = revision;
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
    const poolProjection = await this.getPoolProjection();
    for (const endpoint of endpoints.filter(({ status }) => status === 'active')) {
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
      const candidates = endpoint
        ? await this.issueCandidates(
            poolProjection.get(route.targetEndpointId) ?? [],
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
      });
    }
    this.lastBundleGeneratedAtMs = Math.max(Date.now(), this.lastBundleGeneratedAtMs + 1);
    return { revision: String(state.revision), generatedAtUnixMs: String(this.lastBundleGeneratedAtMs), grants };
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
    rows.sort((left, right) => {
      const stateOrder = { active: 0, staging: 1, draining: 2, retired: 3, failed: 4 } as const;
      return (
        stateOrder[left.state] - stateOrder[right.state] ||
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
    endpoint: Pick<typeof relayEndpoints.$inferSelect, 'id' | 'generation' | 'subjectKind' | 'maxConcurrentSessions'>,
    route:
      | Pick<
          typeof relayRoutes.$inferSelect,
          'id' | 'generation' | 'sourceKind' | 'maxConcurrentSessions' | 'maxFrameBytes'
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
        ...(kind === 'endpoint'
          ? {
              endpointId: endpoint.id,
              endpointGeneration: endpoint.generation,
              maxConcurrentSessions: endpoint.maxConcurrentSessions,
            }
          : {
              routeId: route!.id,
              routeGeneration: route!.generation,
              maxConcurrentSessions: route!.maxConcurrentSessions,
              maxFrameBytes: route!.maxFrameBytes,
            }),
      });
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
      maxConcurrentSessions: route.maxConcurrentSessions,
      maxFrameBytes: route.maxFrameBytes,
    });
    const projection = await this.getPoolProjection();
    const assignments = projection.get(endpoint.id) ?? [];
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
    > & { schemaVersion?: 1 | 2 }
  ): Promise<SignedRelayGrant> {
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
    if (state.revision > this.acknowledgedRevision) {
      throw new Error(`Relay policy revision ${state.revision} has not been durably acknowledged`);
    }
    const now = Math.floor(Date.now() / 1000);
    const claims: RelayGrantClaims = {
      schemaVersion: input.schemaVersion ?? 1,
      audience: 'wiolett-relay',
      grantId: randomUUID(),
      gatewayInstanceId: state.gatewayInstanceId,
      ...input,
      issuedAt: now,
      notBefore: now,
      expiresAt: now + settings.relayGrantTtlHours * 60 * 60,
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
