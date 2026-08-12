import { createPrivateKey, randomUUID, sign as signBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, relayEndpoints, relayGrantSigningKeys, relayPolicyState, relayRoutes } from '@/db/schema/index.js';
import type { SignedRelayGrant } from '@/grpc/relay-control.client.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import { effectiveRelayMaxConcurrentSessions } from './relay-session-limits.js';

const POLICY_ID = 'current';

type GrantKind = 'endpoint' | 'connect';

export interface RelayGrantClaims {
  schemaVersion: 1;
  audience: 'wiolett-relay';
  grantId: string;
  gatewayInstanceId: string;
  kind: GrantKind;
  subjectKind: string;
  subjectId: string;
  certificateSha256: string;
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
      this.db.select({ nodeId: relayEndpoints.subjectId }).from(relayEndpoints),
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
      this.db.select({ id: relayEndpoints.id, status: relayEndpoints.status }).from(relayEndpoints),
    ]);
    const activeEndpointIds = new Set(targetEndpoints.filter(({ status }) => status === 'active').map(({ id }) => id));
    const grants: RelayGrantAssignment[] = [];
    for (const endpoint of endpoints.filter(({ status }) => status === 'active')) {
      grants.push({
        role: 'endpoint',
        ownerKind: endpoint.ownerKind,
        ownerId: endpoint.ownerId,
        endpointId: endpoint.id,
        grant: await this.signGrant({
          kind: 'endpoint',
          subjectKind: endpoint.subjectKind,
          subjectId: nodeId,
          certificateSha256: node.certificateFingerprint,
          endpointId: endpoint.id,
          endpointGeneration: endpoint.generation,
          maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint),
        }),
      });
    }
    for (const route of routes.filter(({ targetEndpointId }) => activeEndpointIds.has(targetEndpointId))) {
      grants.push({
        role: 'connect',
        ownerKind: route.ownerKind,
        ownerId: route.ownerId,
        routeId: route.id,
        targetEndpointId: route.targetEndpointId,
        grant: await this.signGrant({
          kind: 'connect',
          subjectKind: route.sourceKind,
          subjectId: nodeId,
          certificateSha256: node.certificateFingerprint,
          routeId: route.id,
          routeGeneration: route.generation,
          maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route),
          maxFrameBytes: route.maxFrameBytes,
        }),
      });
    }
    this.lastBundleGeneratedAtMs = Math.max(Date.now(), this.lastBundleGeneratedAtMs + 1);
    return { revision: String(state.revision), generatedAtUnixMs: String(this.lastBundleGeneratedAtMs), grants };
  }

  async issueGatewayConnectGrant(routeId: string, appCertificateFingerprint: string): Promise<SignedRelayGrant> {
    const [route] = await this.db.select().from(relayRoutes).where(eq(relayRoutes.id, routeId)).limit(1);
    if (!route || route.sourceKind !== 'gateway' || route.sourceCertificateSha256 !== appCertificateFingerprint)
      throw new Error('Gateway relay route is unavailable');
    const [endpoint] = await this.db
      .select({ status: relayEndpoints.status })
      .from(relayEndpoints)
      .where(eq(relayEndpoints.id, route.targetEndpointId))
      .limit(1);
    if (endpoint?.status !== 'active') throw new Error('Gateway relay endpoint is unavailable');
    return this.signGrant({
      kind: 'connect',
      subjectKind: route.sourceKind,
      subjectId: route.sourceId,
      certificateSha256: appCertificateFingerprint,
      routeId: route.id,
      routeGeneration: route.generation,
      maxConcurrentSessions: route.maxConcurrentSessions,
      maxFrameBytes: route.maxFrameBytes,
    });
  }

  private async signGrant(
    input: Omit<
      RelayGrantClaims,
      'schemaVersion' | 'audience' | 'grantId' | 'gatewayInstanceId' | 'issuedAt' | 'notBefore' | 'expiresAt'
    >
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
      schemaVersion: 1,
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
