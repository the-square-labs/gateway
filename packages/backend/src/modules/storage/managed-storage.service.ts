import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type {
  ManagedStorageAccessKeyRow,
  ManagedStorageClusterRow,
  ManagedStorageErasureConfig,
  ManagedStoragePendingOperation,
} from '@/db/schema/managed-storage.js';
import { managedStorageAccessKeys, managedStorageClusters } from '@/db/schema/managed-storage.js';
import { nodes } from '@/db/schema/nodes.js';
import { objectStorageConnections } from '@/db/schema/object-storage.js';
import { proxyAdditionalSecureLinks } from '@/db/schema/proxy-additional-secure-links.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { ManagedWorkloadDispatch } from '@/modules/managed-workloads/managed-workload-dispatch.js';
import type { ManagedWorkloadLifecycle } from '@/modules/managed-workloads/managed-workload-lifecycle.js';
import type { ManagedWorkloadProvider } from '@/modules/managed-workloads/managed-workload-provider.js';
import type { ManagedWorkloadStore } from '@/modules/managed-workloads/managed-workload-store.js';
import type { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { assertStorageHasNoBackupReferences } from '@/modules/object-storage/storage-backup-references.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
import type {
  CreateManagedStorageAccessKeyInput,
  CreateManagedStorageInput,
  ManagedStorageListQuery,
  UpdateManagedStorageInput,
} from './managed-storage.schemas.js';
import { resolveStorageIamDispatchOpts } from './managed-storage-iam-dispatch.js';
import { buildManagedStoragePolicy } from './managed-storage-iam-policy.js';
import { ManagedStorageTunnelProxy } from './managed-storage-tunnel-proxy.js';
import { safeManagedStorageView } from './managed-storage-view.js';
import { StorageClusterMemberStore } from './storage-cluster-member-store.js';
import type { StorageRootCredentials } from './storage-workload-dispatch.js';
import { STORAGE_WORKLOAD_LABELS } from './storage-workload-labels.js';

const logger = createChildLogger('ManagedStorage');
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

function storageSizeBytesFromGb(storageSizeGb: number): number {
  return Math.round(storageSizeGb * GIBIBYTE);
}

/** Strong random default root access key (~20 alphanumeric chars) when the caller doesn't supply one. */
function generateAccessKey(): string {
  return `gw${crypto.randomBytes(9).toString('hex')}`;
}

/** Strong random default root secret key (~40 chars) when the caller doesn't supply one. */
function generateSecretKey(): string {
  return crypto.randomBytes(30).toString('base64url');
}

/** The set of host ports a single managed-storage cluster occupies on its node, as understood by `collectClusterHostPorts`. */
export interface ClusterHostPorts {
  ports: number[];
  /** The first port that repeats while building the list, naming both roles — undefined when this cluster's own ports don't collide. */
  intraConflict?: { port: number; reason: string };
}

/**
 * Fields (from either a create request or an existing cluster row) that
 * determine which host ports a managed-storage cluster occupies on its
 * node — the shared input shape for `collectClusterHostPorts`.
 */
export interface ClusterPortFields {
  publishS3?: boolean;
  publishedPort: number;
  sftpEnabled?: boolean | null;
  sftpPort?: number | null;
  ftpEnabled?: boolean | null;
  ftpPort?: number | null;
  ftpPassivePortStart?: number | null;
  ftpPassivePortCount?: number | null;
}

/**
 * Pure helper (Phase 2b-vi Task 1): builds the fixed-order list of host ports
 * a managed-storage cluster occupies — `publishedPort` (S3, always), then
 * `sftpPort` (only when `sftpEnabled`), then `ftpPort` (only when
 * `ftpEnabled`), then the FTP passive range (size `ftpPassivePortCount ?? 10`
 * — Phase 2b-viii Task 1: `null`/omitted reproduces the historical fixed
 * 10-port range) starting at `ftpPassivePortStart` (only when `ftpEnabled`).
 * Detects the FIRST port that repeats within that same list — an
 * intra-cluster conflict — and returns it rather than throwing, so callers
 * (`assertNoPortConflicts` below) own how that becomes an error. A clean
 * (non-colliding) set of fields yields no `intraConflict`.
 */
export function collectClusterHostPorts(fields: ClusterPortFields): ClusterHostPorts {
  const seen: Array<{ port: number; name: string; label: string }> = [];
  let intraConflict: { port: number; reason: string } | undefined;

  const add = (port: number | null | undefined, name: string, label: string) => {
    if (port === null || port === undefined) return;
    if (!intraConflict) {
      const priorEntry = seen.find((entry) => entry.port === port);
      if (priorEntry) {
        intraConflict = { port, reason: `${name} ${port} conflicts with ${priorEntry.label}` };
      }
    }
    seen.push({ port, name, label });
  };

  if (fields.publishS3 !== false) add(fields.publishedPort, 'publishedPort', 'the S3 port');
  if (fields.sftpEnabled) add(fields.sftpPort, 'sftpPort', 'the SFTP port');
  if (fields.ftpEnabled) add(fields.ftpPort, 'ftpPort', 'the FTP control port');
  if (fields.ftpEnabled && fields.ftpPassivePortStart !== null && fields.ftpPassivePortStart !== undefined) {
    const effectiveCount = fields.ftpPassivePortCount ?? 10;
    for (let offset = 0; offset < effectiveCount; offset += 1) {
      const passivePort = fields.ftpPassivePortStart + offset;
      add(passivePort, `FTP passive port ${passivePort}`, `an FTP passive port (${passivePort})`);
    }
  }

  return { ports: seen.map((entry) => entry.port), intraConflict };
}

/**
 * Verbatim mirror of `managedDatabaseServiceAddresses`
 * (`modules/databases/managed-databases.service.ts`): collects every valid
 * IP address available for a node — its `serviceAddress` plus the
 * `publicIpAddresses`/`localIpAddresses` reported in its last health check —
 * deduped, for use as the SAN list on a managed-storage TLS certificate.
 */
export function managedStorageServiceAddresses(
  node: {
    serviceAddress: string | null;
    hostname?: string | null;
    lastHealthReport: unknown;
  },
  relay = false
): string[] {
  const health = node.lastHealthReport as
    | { localIpAddresses?: unknown; publicIpAddresses?: unknown }
    | null
    | undefined;
  const ipValues = [
    node.serviceAddress,
    ...(Array.isArray(health?.publicIpAddresses) ? health.publicIpAddresses : []),
    ...(Array.isArray(health?.localIpAddresses) ? health.localIpAddresses : []),
  ]
    .filter((address): address is string => typeof address === 'string' && isIP(address.trim()) !== 0)
    .map((address) => address.trim());
  // The auto-registered endpoint uses `serviceAddress ?? hostname` — a DNS name
  // when no IP service address is configured — so the cert must carry the
  // hostname (and any DNS service address) as a DNS SAN in addition to the
  // health-reported IPs, or the S3 client's hostname verification fails.
  const dnsValues = [node.serviceAddress, node.hostname]
    .filter(
      (address): address is string =>
        typeof address === 'string' && address.trim().length > 0 && isIP(address.trim()) === 0
    )
    .map((address) => address.trim());
  // `relay` (only ever set for a relayEnabled cluster — see
  // `ManagedStorageService.create`) adds the loopback identity the S3 client
  // verifies against when it reaches the container over a
  // `ManagedStorageTunnelProxy` tunnel instead of its direct host:port. Every
  // non-relay caller keeps the exact SAN list it had before this flag existed.
  const loopbackIp = relay ? ['127.0.0.1'] : [];
  const loopbackDns = relay ? ['localhost'] : [];
  return [...new Set([...dnsValues, ...loopbackDns, ...ipValues, ...loopbackIp])];
}

/**
 * Public service that drives the managed object-storage (MinIO) lifecycle.
 * Trimmed mirror of `ManagedDatabaseService` (see
 * `modules/databases/managed-databases.service.ts`): no pause/unpause (no
 * `paused` status for managed storage this phase), no bindings, no direct
 * (separate-from-owner) credentials, and no log streaming. The kind-agnostic
 * provisioning orchestration (create/update/restart/delete dispatch, pending
 * operation reconciliation) is delegated to the injected
 * `ManagedWorkloadLifecycle`, driven through the injected
 * `StorageWorkloadStore`/`StorageWorkloadDispatch` seams — this class only
 * owns input validation, the canonical `object_storage_connections`
 * registration at create time, and building/claiming each pending operation
 * row before handing it to the lifecycle.
 */
export class ManagedStorageService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    // Used directly by `create`/`delete` for the relay register/remove
    // dispatch (`docker_storage_target`) — everything else still goes
    // through `storageWorkloadDispatch`.
    private readonly nodeDispatch: NodeDispatchService,
    private readonly storageProvider: ManagedWorkloadProvider,
    // Kept for constructor-shape parity with `ManagedDatabaseService` (and
    // for bootstrap.ts's construction order) even though no method here
    // calls it directly today: `disposeClient` on a deleted connection is
    // handled by `StorageWorkloadDispatch`, which already holds its own
    // `ObjectStorageService` reference.
    _objectStorageService: ObjectStorageService,
    private readonly storageWorkloadStore: ManagedWorkloadStore,
    private readonly storageWorkloadDispatch: ManagedWorkloadDispatch<ManagedStorageClusterRow, StorageRootCredentials>,
    private readonly storageLifecycle: ManagedWorkloadLifecycle<ManagedStorageClusterRow, StorageRootCredentials>,
    // Defaulted (rather than required), mirroring `StorageWorkloadDispatch`'s
    // own `memberStore` default just below it in the constructor chain — so
    // existing bootstrap wiring keeps compiling untouched; sharing one
    // explicit instance across both is a later task. Not yet consulted by
    // any read path here — `create` below is its first writer, inserting one
    // row per member (including the single-node case's sole member) so the
    // members table stays the source of truth for cluster membership from
    // the very first create.
    private readonly memberStore: StorageClusterMemberStore = new StorageClusterMemberStore(db),
    // Defaulted (rather than required), mirroring `memberStore` just above —
    // so existing bootstrap wiring/tests keep compiling untouched.
    // `bootstrap.ts` wires in the one shared instance also used by
    // `ObjectStorageService.getClient` to resolve a relay cluster's live
    // loopback endpoint.
    private readonly tunnelProxy: ManagedStorageTunnelProxy = new ManagedStorageTunnelProxy(),
    // Optional and defaulted (undefined ⇒ IAM key CRUD on a TLS-enabled
    // cluster fails loudly with `MANAGED_STORAGE_TLS_CA_UNAVAILABLE` rather
    // than silently dispatching over an unverifiable connection), mirroring
    // `StorageWorkloadDispatch`'s own optional `storageCA` — existing
    // call sites that don't touch IAM keys keep compiling untouched.
    // `bootstrap.ts` wires in the one shared `StorageCAService` instance.
    private readonly storageCA?: StorageCAService,
    // Optional so existing call sites keep compiling; relay-enabled clusters
    // need it to revoke their relay endpoint and route on delete.
    private readonly relayPolicy?: Pick<RelayPolicyService, 'revokeOwner'>
  ) {
    this.storageWorkloadDispatch.beforeDelete = async (row, userId) => {
      if (row.objectStorageConnectionId)
        await assertStorageHasNoBackupReferences(this.db, row.objectStorageConnectionId);
      await this.bindingsTeardown?.(row, userId ?? row.updatedById ?? row.createdById ?? 'system');
      await this.relayPolicy?.revokeOwner('managed_storage_gateway', row.id);
      await this.relayPolicy?.revokeOwner('managed_storage', row.id);
      await this.tunnelProxy.disposeCluster(row.id);
      await this.storageCA?.retireManagedStorageCertificates(row.id);
    };
  }

  /**
   * Injected by bootstrap rather than constructor-wired: the bindings service
   * already depends on this one's cluster rows, and taking it as a dependency
   * here would close that cycle.
   */
  private bindingsTeardown?: (cluster: ManagedStorageClusterRow, userId: string) => Promise<void>;

  setBindingsTeardown(teardown: (cluster: ManagedStorageClusterRow, userId: string) => Promise<void>) {
    this.bindingsTeardown = teardown;
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    this.storageWorkloadDispatch.setEventBus(bus);
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  listCatalog() {
    return this.storageProvider.listCatalog();
  }

  async list(query: ManagedStorageListQuery = {}) {
    const conditions = [];
    if (query.nodeId) conditions.push(eq(managedStorageClusters.nodeId, query.nodeId));
    const rows = await this.db
      .select()
      .from(managedStorageClusters)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(managedStorageClusters.name));
    return rows.map(safeManagedStorageView);
  }

  async get(id: string) {
    let row = await this.getRow(id);
    // Mirrors `ManagedDatabaseService.get`: the deploy wizard polls this
    // endpoint while its loader is visible, so use that poll to converge a
    // response lost during daemon reconnect instead of waiting for the
    // background reconciliation interval.
    if (row.pendingOperation) {
      await this.storageLifecycle.reconcilePendingRow(row);
      row = await this.getRow(id);
    }
    return safeManagedStorageView(row);
  }

  async getByObjectStorageConnectionId(objectStorageConnectionId: string) {
    const [row] = await this.db
      .select()
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.objectStorageConnectionId, objectStorageConnectionId))
      .limit(1);
    return row ? safeManagedStorageView(row) : null;
  }

  /** Used by the route layer's scope re-check fallback: no throw on a missing canonical connection. */
  async getCanonicalScopeResourceId(id: string): Promise<string | null> {
    const row = await this.getRow(id);
    return row.objectStorageConnectionId;
  }

  async create(input: CreateManagedStorageInput, userId: string) {
    // LICENSE ENFORCEMENT: Deploying a Gateway-managed storage cluster requires Personal under the project license/TOS.
    // Enrolling a storage node and connecting an existing external storage stay outside this boundary.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('managed-storage');
    const imageRef = this.storageProvider.resolveImage('minio', input.version);
    // `memberNodeIds` absent ⇒ the existing single-node shape: `nodeId` is
    // the cluster's sole member. Present ⇒ a distributed cluster where every
    // entry (unrelated to `input.nodeId`, which is ignored in that case) is
    // a member.
    const memberNodeIds = input.memberNodeIds ?? [input.nodeId];
    const drivesPerNode = input.drivesPerNode ?? 1;
    if (memberNodeIds.length !== 1) {
      const distinctMemberCount = new Set(memberNodeIds).size;
      const meetsErasureMinimum = memberNodeIds.length >= 4 && memberNodeIds.length * drivesPerNode >= 4;
      if (distinctMemberCount !== memberNodeIds.length || !meetsErasureMinimum) {
        throw new AppError(
          400,
          'MANAGED_STORAGE_INVALID_TOPOLOGY',
          'A distributed managed storage cluster requires at least 4 distinct member nodes with enough total drives for erasure coding'
        );
      }
    }
    const memberAddresses: string[] = [];
    if (memberNodeIds.length > 1) {
      for (const memberNodeId of memberNodeIds) {
        const memberNode = await this.requireNode(memberNodeId);
        if (!memberNode.serviceAddress || !isIP(memberNode.serviceAddress))
          throw new AppError(
            400,
            'MANAGED_STORAGE_PEER_ADDRESS_REQUIRED',
            'Each distributed Storage node requires a concrete service IP address'
          );
        memberAddresses.push(...managedStorageServiceAddresses(memberNode, true));
      }
    }
    const erasureConfig: ManagedStorageErasureConfig = { nodeCount: memberNodeIds.length, drivesPerNode };
    for (const memberNodeId of memberNodeIds) {
      await this.storageWorkloadDispatch.assertNodeReady(memberNodeId);
    }
    // Single-node limitation carries over unchanged for the distributed
    // case: the endpoint is resolved from the primary (first) member's
    // host, direct-to-primary — a routable virtual/relay endpoint across all
    // members is deferred to a later phase.
    const primaryNodeId = memberNodeIds[0]!;
    const node = await this.requireNode(primaryNodeId);
    const host = node.serviceAddress ?? node.hostname;
    const username = input.accessKey ?? generateAccessKey();
    const password = input.secretKey ?? generateSecretKey();
    const encryptedRootCredentials = JSON.stringify(
      this.cryptoService.encryptString(JSON.stringify({ username, password }))
    );
    // Opt-in SFTP exposure (see `StorageWorkloadDispatch.renderCommandPayload`):
    // `sftpEnabled` false/omitted (the default) leaves every one of these
    // columns at their byte-identical defaults (false/null/null) — never
    // logged, never returned by any view.
    const sftpEnabled = input.sftpEnabled ?? false;
    const sftpPort = sftpEnabled ? (input.sftpPort ?? null) : null;
    // Opt-in FTP exposure (see `StorageWorkloadDispatch.renderCommandPayload`'s
    // `--ftp=...` flags): threaded straight into the insert below exactly like
    // sftpEnabled/sftpPort above, minus a host key — FTP has none (auth is the
    // same IAM access keys; FTPS auto-reuses the TLS certs already staged when
    // `tlsEnabled`, no separate credential to generate/encrypt here).
    // `ftpEnabled` false/omitted (the default) leaves both columns at their
    // byte-identical defaults (false/null/null).
    const ftpEnabled = input.ftpEnabled ?? false;
    const ftpPort = ftpEnabled ? (input.ftpPort ?? null) : null;
    const ftpPassivePortStart = ftpEnabled ? (input.ftpPassivePortStart ?? null) : null;
    // Size of the passive-mode data range (Phase 2b-viii Task 1). Persisted
    // as an EXPLICIT `10` (not left `null`) when `ftpEnabled` and the caller
    // omits it — `null` is reserved for "created before this column
    // existed"/`!ftpEnabled`, so every effective-count reader's
    // `?? 10` fallback stays meaningful as a migration-compat default,
    // never a live create-time default.
    const ftpPassivePortCount = ftpEnabled ? (input.ftpPassivePortCount ?? 10) : null;
    // Phase 2b-vi Task 1: reject colliding host ports (intra-cluster or
    // against another managed cluster on this node) with a clear 409 here,
    // BEFORE any write (registerCanonicalConnection/insert) or the SSH host
    // key generation just below — a conflicting create needs no rollback and
    // shouldn't burn a fresh keypair it will never use.
    await this.assertNoPortConflicts(primaryNodeId, {
      publishS3: input.publishS3 ?? false,
      publishedPort: input.publishedPort,
      sftpEnabled,
      sftpPort,
      ftpEnabled,
      ftpPort,
      ftpPassivePortStart,
      ftpPassivePortCount,
    });
    // A fresh Gateway-issued SSH host key, encrypted the same way as the root
    // credentials above and threaded straight into the insert below — there's
    // nothing to roll back if `generateKeyPair`/`encryptString` throw (pure
    // in-memory crypto, no I/O), so no extra try/catch is needed beyond what
    // already wraps the insert.
    const encryptedSftpHostKey = sftpEnabled
      ? JSON.stringify(this.cryptoService.encryptString(this.cryptoService.generateKeyPair('ecdsa-p256').privateKeyPem))
      : null;
    const runtimeConfig = {
      nanoCPUs: Math.round(input.cpuCores * 1_000_000_000),
      memoryLimitBytes: input.memoryMb * MEBIBYTE,
      memorySwapBytes: (input.memoryMb + input.swapMb) * MEBIBYTE,
    };
    const storageSizeBytes = storageSizeBytesFromGb(input.storageSizeGb);
    const relayEnabled = input.relayEnabled ?? true;
    if (!relayEnabled && !input.publishS3)
      throw new AppError(400, 'MANAGED_STORAGE_UNREACHABLE', 'Enable private relay or publish the S3 endpoint');
    // Relay implies TLS: the S3 client verifies the container's cert over the
    // gateway-local loopback leg opened by `ManagedStorageTunnelProxy`, so a
    // relay create always ends up TLS-enabled regardless of whether the
    // caller separately passed `tlsEnabled`. Non-relay keeps today's opt-in
    // `input.tlsEnabled` behavior, byte-identical.
    const effectiveTlsEnabled = relayEnabled || (input.tlsEnabled ?? false);
    // Single-node limitation: the endpoint is built from the node's own
    // service/hostname address, which must be reachable from wherever the
    // canonical connection is consumed (Explorer, bindings, ...). This is
    // adequate for a single Docker node this phase; multi-node/HA storage
    // will need a routable virtual endpoint instead.
    //
    // Scheme: `ensureCertificate` below runs in this same `create` and rolls the
    // whole operation back on failure (see the catch below), so a `tlsEnabled`
    // (or relay, which implies it) create that reaches this point always ends up
    // with a cert — https is safe to claim upfront. A non-TLS create stays http,
    // byte-identical to before.
    const scheme = effectiveTlsEnabled ? 'https' : 'http';
    // Relay endpoint: a stable, cosmetic placeholder. The proxy allocates a
    // fresh loopback port every gateway boot, so persisting `127.0.0.1:<port>`
    // here would go stale on restart — the live host:port is resolved
    // dynamically instead, in `ObjectStorageService.getClient`, right before a
    // client is actually built. Non-relay keeps the direct
    // `host:publishedPort` endpoint, byte-identical to before.
    const endpoint = relayEnabled ? `${scheme}://127.0.0.1` : `${scheme}://${host}:${input.publishedPort}`;
    const pendingOperation: ManagedStoragePendingOperation = { id: crypto.randomUUID(), action: 'create' };
    const connectionId = await this.storageProvider.registerCanonicalConnection({
      name: input.name,
      type: 'minio',
      credentials: { username, password },
      storageSizeBytes,
      userId,
      tags: input.tags,
      storage: { endpoint, region: 'us-east-1', forcePathStyle: true, s3Provider: 'minio' },
    });
    let row: ManagedStorageClusterRow;
    try {
      row = await writeWithAllocatedSlug({
        source: input.name,
        fallback: 'storage',
        constraint: 'managed_storage_clusters_slug_unique',
        write: async (slug) => {
          const [created] = await this.db
            .insert(managedStorageClusters)
            .values({
              objectStorageConnectionId: connectionId,
              nodeId: primaryNodeId,
              name: input.name,
              slug,
              version: input.version,
              imageRef,
              encryptedRootCredentials,
              storageSizeBytes,
              runtimeConfig,
              erasureConfig,
              publishedPort: input.publishedPort,
              publishS3: input.publishS3 ?? false,
              status: 'creating',
              relayEnabled,
              sftpEnabled,
              sftpPort,
              encryptedSftpHostKey,
              ftpEnabled,
              ftpPort,
              ftpPassivePortStart,
              ftpPassivePortCount,
              pendingOperation,
              createdById: userId,
              updatedById: userId,
            })
            .returning();
          return created!;
        },
      });
    } catch (error) {
      await this.db.delete(objectStorageConnections).where(eq(objectStorageConnections.id, connectionId));
      throw error;
    }
    try {
      await this.memberStore.insertMembers(
        row.id,
        memberNodeIds.map((memberNodeId, memberIndex) => ({
          nodeId: memberNodeId,
          memberIndex,
          drives: drivesPerNode,
        }))
      );
      // TLS is opt-in at create time (default false ⇒ unchanged behavior: no
      // CA call, `certificateId` stays null, `tlsEnabled` stays false). The
      // endpoint stays `http://` regardless this phase — the cert is issued
      // and persisted here, but nothing serves it over HTTPS yet (that's
      // Phase 2b-ii-B: cert delivery into the MinIO container + the
      // http->https endpoint flip). `relayEnabled` forces this path too (see
      // `effectiveTlsEnabled` above) and additionally asks the CA for a cert
      // whose SANs cover the loopback identity the S3 client verifies against.
      if (effectiveTlsEnabled) {
        const cert = await this.storageProvider.ensureCertificate({
          workloadId: row.id,
          existingCertificateId: null,
          node: {
            serviceAddress: node.serviceAddress,
            hostname: node.hostname,
            lastHealthReport: node.lastHealthReport,
          },
          relay: relayEnabled,
          additionalAddresses: memberAddresses,
        });
        if (cert) {
          const [updated] = await this.db
            .update(managedStorageClusters)
            .set({ certificateId: cert.certificateId, tlsEnabled: true, updatedAt: new Date() })
            .where(eq(managedStorageClusters.id, row.id))
            .returning();
          row = updated!;
        }
      }
    } catch (error) {
      // Extends the rollback above: the cluster row (and, belt-and-suspenders,
      // any members that did make it in before the failure) must go too, or
      // the just-registered connection row would be left referenced by a
      // cluster with no membership. Also covers a TLS-issuance failure above
      // (e.g. MANAGED_STORAGE_TLS_IDENTITY_UNAVAILABLE): the cert-less row
      // must not be left behind either.
      await this.storageCA?.retireManagedStorageCertificates(row.id);
      await this.memberStore.deleteByCluster(row.id);
      await this.db.delete(managedStorageClusters).where(eq(managedStorageClusters.id, row.id));
      await this.db.delete(objectStorageConnections).where(eq(objectStorageConnections.id, connectionId));
      throw error;
    }
    this.emit(row, 'created');
    await this.auditService.log({
      userId,
      action: 'storage.managed.create',
      resourceType: 'managed_storage_cluster',
      resourceId: row.id,
      details: { name: row.name, version: row.version, nodeId: row.nodeId },
    });

    // The relay register-target dispatch (single-node, member 0) happens
    // inside `dispatchCreate` itself — `StorageWorkloadDispatch.onCreateSucceeded`
    // runs it AFTER the container is created/started, inside the lifecycle's
    // own try/catch. A registration failure therefore flows through the
    // normal create-failure path (`markError`: status:'error', lastError set,
    // pendingOperation cleared) instead of throwing over an already-committed
    // row — see that method for the full rationale. This also makes a failed
    // registration retryable via the existing `retryProvisioning` path, since
    // that replays `dispatchCreate` (and therefore `onCreateSucceeded`) too.
    return this.storageLifecycle.dispatchCreate(row, { username, password }, true, false, userId);
  }

  async update(id: string, input: UpdateManagedStorageInput, userId: string) {
    const existing = await this.getRow(id);
    this.assertClaimable(existing);
    await this.storageWorkloadDispatch.assertNodeReady(existing.nodeId);
    if (
      input.storageSizeGb !== undefined &&
      storageSizeBytesFromGb(input.storageSizeGb) < Number(existing.storageSizeBytes)
    ) {
      throw new AppError(400, 'MANAGED_STORAGE_STORAGE_REDUCTION_UNSUPPORTED', 'Managed storage can only be increased');
    }
    if (
      input.publishS3 !== undefined ||
      (input.publishedPort !== undefined && input.publishedPort !== existing.publishedPort)
    ) {
      // Phase 2b-vi Task 1: the S3 port is moving — recheck for a collision
      // (intra-cluster against this cluster's own SFTP/FTP ports, or
      // inter-cluster against another managed cluster on the node) BEFORE the
      // claim/dispatch below, so a conflict fails cleanly with no pending
      // operation left behind. `excludeClusterId` keeps this cluster's own
      // row out of its own sibling check.
      await this.assertNoPortConflicts(
        existing.nodeId,
        {
          publishedPort: input.publishedPort ?? existing.publishedPort,
          publishS3: input.publishS3 ?? existing.publishS3,
          sftpEnabled: existing.sftpEnabled,
          sftpPort: existing.sftpPort,
          ftpEnabled: existing.ftpEnabled,
          ftpPort: existing.ftpPort,
          ftpPassivePortStart: existing.ftpPassivePortStart,
          ftpPassivePortCount: existing.ftpPassivePortCount,
        },
        existing.id
      );
    }
    const nextRuntimeConfig = {
      ...existing.runtimeConfig,
      ...(input.cpuCores === undefined ? {} : { nanoCPUs: Math.round(input.cpuCores * 1_000_000_000) }),
      ...(input.memoryMb === undefined ? {} : { memoryLimitBytes: input.memoryMb * MEBIBYTE }),
      ...(input.memoryMb === undefined && input.swapMb === undefined
        ? {}
        : {
            memorySwapBytes:
              ((input.memoryMb ?? Math.round((existing.runtimeConfig.memoryLimitBytes ?? 0) / MEBIBYTE)) +
                (input.swapMb ??
                  Math.max(
                    0,
                    Math.round(
                      ((existing.runtimeConfig.memorySwapBytes ?? existing.runtimeConfig.memoryLimitBytes ?? 0) -
                        (existing.runtimeConfig.memoryLimitBytes ?? 0)) /
                        MEBIBYTE
                    )
                  ))) *
              MEBIBYTE,
          }),
    };
    const pendingOperation: ManagedStoragePendingOperation = { id: crypto.randomUUID(), action: 'update' };
    const claimed = this.storageLifecycle.requireOperationClaim(
      (await this.storageWorkloadStore.claimOperation(id, existing.status, pendingOperation, {
        name: input.name ?? existing.name,
        storageSizeBytes:
          input.storageSizeGb === undefined ? existing.storageSizeBytes : storageSizeBytesFromGb(input.storageSizeGb),
        runtimeConfig: nextRuntimeConfig,
        publishedPort: input.publishedPort ?? existing.publishedPort,
        publishS3: input.publishS3 ?? existing.publishS3,
        status: 'updating',
        updatedById: userId,
      })) as ManagedStorageClusterRow | undefined
    );
    if (input.name !== undefined && input.name !== existing.name) {
      await this.storageProvider.syncCanonicalConnection({
        connectionId: claimed.objectStorageConnectionId,
        updatedById: claimed.updatedById,
        name: claimed.name,
        previousName: existing.name,
      });
    }
    if (input.tags !== undefined) {
      // tags live only on the canonical connection row (no column on the
      // cluster); syncCanonicalConnection no-ops when tags is undefined, so
      // this call is only made when tags were actually supplied.
      await this.storageProvider.syncCanonicalConnection({
        connectionId: claimed.objectStorageConnectionId,
        updatedById: claimed.updatedById,
        name: claimed.name,
        tags: input.tags,
      });
    }
    if (
      input.publishS3 !== undefined ||
      (input.publishedPort !== undefined && input.publishedPort !== existing.publishedPort)
    ) {
      // The S3 API port moved, and the container is being republished on it — so
      // the canonical connection's endpoint must follow, or the object browser
      // would keep hitting the old host port and lose access to the MinIO it
      // provisioned.
      const node = await this.requireNode(existing.nodeId);
      const host = node.serviceAddress ?? node.hostname;
      // The cluster's own tlsEnabled — not derived from `input`, which carries no TLS
      // toggle — drives the scheme, so a port-only change never silently downgrades a
      // TLS-enabled cluster's canonical endpoint back to http.
      const scheme = existing.tlsEnabled ? 'https' : 'http';
      await this.storageProvider.syncCanonicalConnection({
        connectionId: claimed.objectStorageConnectionId,
        updatedById: claimed.updatedById,
        name: claimed.name,
        storage: {
          endpoint: claimed.relayEnabled ? `${scheme}://127.0.0.1` : `${scheme}://${host}:${claimed.publishedPort}`,
        },
      });
    }
    return this.storageLifecycle.dispatchUpdate(
      claimed,
      this.storageWorkloadDispatch.readOwnerCredentials(claimed),
      true,
      false,
      userId
    );
  }

  async restart(id: string, userId: string) {
    const existing = await this.getRow(id);
    this.assertClaimable(existing);
    await this.storageWorkloadDispatch.assertNodeReady(existing.nodeId);
    // Mirrors ManagedDatabaseService.restart: no ready-only gate — a settled
    // cluster (ready/stopped/error, all non-pending) may be restarted; the
    // atomic claim's status guard + `pendingOperation IS NULL` still serialize.
    const pendingOperation: ManagedStoragePendingOperation = { id: crypto.randomUUID(), action: 'restart' };
    const claimed = this.storageLifecycle.requireOperationClaim(
      (await this.storageWorkloadStore.claimOperation(id, existing.status, pendingOperation, {
        status: 'updating',
        updatedById: userId,
      })) as ManagedStorageClusterRow | undefined
    );
    return this.storageLifecycle.dispatchRestart(claimed, userId);
  }

  async delete(id: string, userId: string) {
    const existing = await this.getRow(id);
    const [secureLinkReference] = await this.db
      .select({ id: proxyAdditionalSecureLinks.id })
      .from(proxyAdditionalSecureLinks)
      .where(eq(proxyAdditionalSecureLinks.managedStorageId, id))
      .limit(1);
    if (secureLinkReference) {
      throw new AppError(
        409,
        'MANAGED_STORAGE_SECURE_LINK_IN_USE',
        'Remove Route Secure Link bindings before deleting managed storage'
      );
    }
    if (existing.objectStorageConnectionId)
      await assertStorageHasNoBackupReferences(this.db, existing.objectStorageConnectionId);
    this.assertClaimable(existing);
    await this.storageWorkloadDispatch.assertNodeReady(existing.nodeId);
    const pendingOperation: ManagedStoragePendingOperation = { id: crypto.randomUUID(), action: 'delete' };
    const claimed = await this.db.transaction(async (tx) => {
      if (existing.objectStorageConnectionId) {
        await tx
          .select({ id: objectStorageConnections.id })
          .from(objectStorageConnections)
          .where(eq(objectStorageConnections.id, existing.objectStorageConnectionId))
          .for('update');
        await assertStorageHasNoBackupReferences(tx, existing.objectStorageConnectionId);
      }
      await tx
        .select({ id: managedStorageClusters.id })
        .from(managedStorageClusters)
        .where(eq(managedStorageClusters.id, id))
        .for('update');
      const [reference] = await tx
        .select({ id: proxyAdditionalSecureLinks.id })
        .from(proxyAdditionalSecureLinks)
        .where(eq(proxyAdditionalSecureLinks.managedStorageId, id))
        .limit(1);
      if (reference)
        throw new AppError(
          409,
          'MANAGED_STORAGE_SECURE_LINK_IN_USE',
          'Remove Route Secure Link bindings before deleting managed storage'
        );
      const [row] = await tx
        .update(managedStorageClusters)
        .set({ status: 'deleting', pendingOperation, updatedById: userId, updatedAt: new Date() })
        .where(
          and(
            eq(managedStorageClusters.id, id),
            eq(managedStorageClusters.status, existing.status),
            isNull(managedStorageClusters.pendingOperation)
          )
        )
        .returning();
      return this.storageLifecycle.requireOperationClaim(row);
    });
    return this.storageLifecycle.dispatchDelete(claimed, userId);
  }

  async retryProvisioning(id: string, userId: string) {
    const existing = await this.getRow(id);
    await this.storageWorkloadDispatch.assertNodeReady(existing.nodeId);
    if (existing.status !== 'error' || !existing.lastError?.startsWith('Managed storage create failed')) {
      throw new AppError(
        409,
        'MANAGED_STORAGE_NOT_RETRYABLE',
        'Only a failed managed storage deployment can be retried'
      );
    }
    const pendingOperation: ManagedStoragePendingOperation = { id: crypto.randomUUID(), action: 'create' };
    const claimed = this.storageLifecycle.requireOperationClaim(
      (await this.storageWorkloadStore.claimOperation(id, 'error', pendingOperation, {
        status: 'creating',
        updatedById: userId,
      })) as ManagedStorageClusterRow | undefined
    );
    const credentials = this.storageWorkloadDispatch.readOwnerCredentials(claimed);
    await this.auditService.log({
      userId,
      action: 'storage.managed.retry_provisioning',
      resourceType: 'managed_storage_cluster',
      resourceId: id,
      details: { name: claimed.name, nodeId: claimed.nodeId },
    });
    this.emit(claimed, 'retrying');
    return this.storageLifecycle.dispatchCreate(claimed, credentials, true, false, userId);
  }

  async revealCredentials(id: string) {
    const row = await this.getRow(id);
    const credentials = this.storageWorkloadDispatch.readOwnerCredentials(row);
    return { accessKey: credentials.username, secretKey: credentials.password };
  }

  /**
   * Create a new MinIO IAM service-account access key for this cluster,
   * dispatched to the daemon's `docker_storage_iam` `create_key` action
   * (madmin-go against the cluster's own admin API — see
   * `NodeDispatchService.sendDockerStorageIamCommand`). The plaintext secret
   * is returned to the caller exactly once, here; only its encrypted form is
   * persisted, and no other read path decrypts it back out.
   */
  async createAccessKey(id: string, input: CreateManagedStorageAccessKeyInput, userId: string) {
    const row = await this.getRow(id);
    const credentials = this.storageWorkloadDispatch.readOwnerCredentials(row);
    const iamOpts = await this.resolveIamDispatchOpts(row, credentials);
    const access = input.access ?? 'read-write';
    const buckets = input.buckets ?? [];
    const policy = buildManagedStoragePolicy(access, buckets);

    let result: Awaited<ReturnType<typeof this.nodeDispatch.sendDockerStorageIamCommand>>;
    try {
      result = await this.nodeDispatch.sendDockerStorageIamCommand(row.nodeId, 'create_key', row.id, {
        ...iamOpts,
        name: input.name,
        policy,
        expiresAt: input.expiresAt,
      });
    } catch (error) {
      // sendCommand THROWS (rather than returning success:false) when the
      // storage node is offline / not connected — e.g. its daemon is down.
      // Surface it as a clean 502 instead of an unhandled 500.
      throw new AppError(
        502,
        'MANAGED_STORAGE_IAM_CREATE_FAILED',
        error instanceof Error ? error.message : 'Managed storage node is not reachable'
      );
    }
    if (!result.success) {
      throw new AppError(
        502,
        'MANAGED_STORAGE_IAM_CREATE_FAILED',
        result.error || 'Failed to create managed storage access key'
      );
    }

    let parsed: { accessKey?: string; secretKey?: string };
    try {
      parsed = JSON.parse(result.detail) as { accessKey?: string; secretKey?: string };
    } catch {
      throw new AppError(
        502,
        'MANAGED_STORAGE_IAM_CREATE_INVALID_RESPONSE',
        'Daemon returned an invalid access key response'
      );
    }
    if (
      typeof parsed.accessKey !== 'string' ||
      typeof parsed.secretKey !== 'string' ||
      !parsed.accessKey ||
      !parsed.secretKey
    ) {
      throw new AppError(
        502,
        'MANAGED_STORAGE_IAM_CREATE_INVALID_RESPONSE',
        'Daemon returned an invalid access key response'
      );
    }
    const { accessKey, secretKey } = parsed as { accessKey: string; secretKey: string };

    const encryptedSecretKey = JSON.stringify(this.cryptoService.encryptString(secretKey));
    let inserted: ManagedStorageAccessKeyRow;
    try {
      const [row0] = await this.db
        .insert(managedStorageAccessKeys)
        .values({
          clusterId: row.id,
          accessKeyId: accessKey,
          encryptedSecretKey,
          name: input.name,
          access,
          buckets,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdById: userId,
        })
        .returning();
      inserted = row0!;
    } catch (error) {
      // The daemon already created this key in MinIO — a live credential now
      // exists with no Gateway record unless we clean it up here. Best-effort
      // compensating remove: if it ALSO fails, log loudly (with the
      // accessKeyId) so an operator can revoke it manually via `mc admin`,
      // then still surface the original insert error to the caller.
      try {
        const compensatingOpts = await this.resolveIamDispatchOpts(row, credentials);
        const compensatingResult = await this.nodeDispatch.sendDockerStorageIamCommand(
          row.nodeId,
          'remove_key',
          row.id,
          { ...compensatingOpts, targetAccessKey: accessKey }
        );
        if (!compensatingResult.success) {
          logger.error('Managed storage IAM access key orphaned: compensating remove_key failed', {
            clusterId: row.id,
            accessKeyId: accessKey,
            insertError: error instanceof Error ? error.message : String(error),
            removeError: compensatingResult.error,
          });
        }
      } catch (compensatingError) {
        logger.error('Managed storage IAM access key orphaned: compensating remove_key dispatch threw', {
          clusterId: row.id,
          accessKeyId: accessKey,
          insertError: error instanceof Error ? error.message : String(error),
          removeError: compensatingError instanceof Error ? compensatingError.message : String(compensatingError),
        });
      }
      throw error;
    }

    await this.auditService.log({
      userId,
      action: 'storage.managed.iam.create',
      resourceType: 'managed_storage_access_key',
      resourceId: inserted!.id,
      details: { clusterId: row.id, accessKeyId: accessKey, name: input.name },
    });

    return { accessKeyId: accessKey, secretKey, name: inserted!.name, createdAt: inserted!.createdAt };
  }

  /**
   * List this cluster's IAM access keys from the local table — the source
   * of truth for display name/ownership. Never returns a secret (not even
   * the encrypted form): only the identifiers a caller needs to manage keys.
   */
  async listAccessKeys(id: string) {
    await this.getRow(id);
    return this.db
      .select({
        accessKeyId: managedStorageAccessKeys.accessKeyId,
        name: managedStorageAccessKeys.name,
        access: managedStorageAccessKeys.access,
        buckets: managedStorageAccessKeys.buckets,
        expiresAt: managedStorageAccessKeys.expiresAt,
        createdAt: managedStorageAccessKeys.createdAt,
      })
      .from(managedStorageAccessKeys)
      .where(eq(managedStorageAccessKeys.clusterId, id))
      .orderBy(asc(managedStorageAccessKeys.createdAt));
  }

  /**
   * Revoke a MinIO IAM service-account access key, dispatched to the
   * daemon's `docker_storage_iam` `remove_key` action, then drop the local
   * row. The local row is only deleted after a successful dispatch, so a
   * daemon-side failure leaves Gateway's record consistent with MinIO's.
   */
  async removeAccessKey(id: string, accessKeyId: string, userId: string) {
    const row = await this.getRow(id);
    const credentials = this.storageWorkloadDispatch.readOwnerCredentials(row);
    const iamOpts = await this.resolveIamDispatchOpts(row, credentials);

    let result: Awaited<ReturnType<typeof this.nodeDispatch.sendDockerStorageIamCommand>>;
    try {
      result = await this.nodeDispatch.sendDockerStorageIamCommand(row.nodeId, 'remove_key', row.id, {
        ...iamOpts,
        targetAccessKey: accessKeyId,
      });
    } catch (error) {
      // As in createAccessKey: a disconnected node throws here rather than
      // returning success:false — surface a clean 502, not an unhandled 500.
      throw new AppError(
        502,
        'MANAGED_STORAGE_IAM_REMOVE_FAILED',
        error instanceof Error ? error.message : 'Managed storage node is not reachable'
      );
    }
    if (!result.success) {
      throw new AppError(
        502,
        'MANAGED_STORAGE_IAM_REMOVE_FAILED',
        result.error || 'Failed to remove managed storage access key'
      );
    }

    await this.db
      .delete(managedStorageAccessKeys)
      .where(and(eq(managedStorageAccessKeys.clusterId, id), eq(managedStorageAccessKeys.accessKeyId, accessKeyId)));

    await this.auditService.log({
      userId,
      action: 'storage.managed.iam.remove',
      resourceType: 'managed_storage_access_key',
      resourceId: row.id,
      details: { clusterId: row.id, accessKeyId },
    });

    return { success: true };
  }

  /**
   * Shared coordinates for an IAM dispatch: the admin API's published port,
   * whether to speak TLS, and — only when TLS is on — the storage CA pem
   * and the node hostname as `serverName` (a SAN the cluster cert carries;
   * verifying against `127.0.0.1` instead fails TLS verification, per the
   * daemon-side `buildStorageAdminTLSTransport`).
   */
  private resolveIamDispatchOpts(row: ManagedStorageClusterRow, credentials: { username: string; password: string }) {
    return resolveStorageIamDispatchOpts(this.db, row, credentials, this.storageCA);
  }

  /** Reconcile unknown outcomes after reconnects or controller delivery failures. */
  async reconcilePendingOperations() {
    return this.storageLifecycle.reconcilePendingOperations();
  }

  private async getRow(id: string): Promise<ManagedStorageClusterRow> {
    const [row] = await this.db.select().from(managedStorageClusters).where(eq(managedStorageClusters.id, id)).limit(1);
    if (!row) throw new AppError(404, 'MANAGED_STORAGE_NOT_FOUND', 'Managed storage cluster not found');
    return row;
  }

  /**
   * Phase 2b-vi Task 1: reject a create/update whose requested host ports
   * would collide — either within the cluster's own ports (S3/SFTP/FTP
   * control/FTP passive overlapping each other) or against another managed
   * cluster already sitting on the same node — with a clear 409 instead of a
   * Docker bind failure at provision time.
   *
   * First checks the requested fields against themselves
   * (`collectClusterHostPorts`'s `intraConflict`); only once that's clean
   * does it look at sibling clusters on `nodeId` (`excludeClusterId` leaves
   * the cluster being updated out of its own sibling check).
   */
  private async assertNoPortConflicts(
    nodeId: string,
    fields: ClusterPortFields,
    excludeClusterId?: string
  ): Promise<void> {
    const { ports: requestedPorts, intraConflict } = collectClusterHostPorts(fields);
    if (intraConflict) {
      throw new AppError(409, 'MANAGED_STORAGE_PORT_CONFLICT', intraConflict.reason);
    }
    const requested = new Set(requestedPorts);
    const conditions = [eq(managedStorageClusters.nodeId, nodeId)];
    if (excludeClusterId) conditions.push(ne(managedStorageClusters.id, excludeClusterId));
    const siblings = await this.db
      .select({
        id: managedStorageClusters.id,
        name: managedStorageClusters.name,
        publishedPort: managedStorageClusters.publishedPort,
        publishS3: managedStorageClusters.publishS3,
        sftpEnabled: managedStorageClusters.sftpEnabled,
        sftpPort: managedStorageClusters.sftpPort,
        ftpEnabled: managedStorageClusters.ftpEnabled,
        ftpPort: managedStorageClusters.ftpPort,
        ftpPassivePortStart: managedStorageClusters.ftpPassivePortStart,
        ftpPassivePortCount: managedStorageClusters.ftpPassivePortCount,
      })
      .from(managedStorageClusters)
      .where(and(...conditions));
    for (const sibling of siblings) {
      const { ports: siblingPorts } = collectClusterHostPorts(sibling);
      const conflictingPort = siblingPorts.find((port) => requested.has(port));
      if (conflictingPort !== undefined) {
        throw new AppError(
          409,
          'MANAGED_STORAGE_PORT_CONFLICT',
          `Port ${conflictingPort} is already used by managed storage "${sibling.name}" on this node`
        );
      }
    }

    // The restricted daemon validates actual port bindings during provisioning.
  }

  /** Rejects a mutation when another operation is still in flight (label-backed). */
  private assertClaimable(row: ManagedStorageClusterRow): void {
    if (row.pendingOperation) {
      throw new AppError(
        409,
        STORAGE_WORKLOAD_LABELS.operationPending.code,
        STORAGE_WORKLOAD_LABELS.operationPending.message
      );
    }
  }

  private async requireNode(
    nodeId: string
  ): Promise<{ hostname: string; serviceAddress: string | null; lastHealthReport: unknown }> {
    const [node] = await this.db
      .select({
        hostname: nodes.hostname,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Managed storage node not found');
    return node;
  }

  private emit(
    row: Pick<ManagedStorageClusterRow, 'id' | 'objectStorageConnectionId' | 'name' | 'status'>,
    action: string
  ) {
    this.eventBus?.publish('managed-storage.changed', {
      id: row.objectStorageConnectionId ?? row.id,
      managedStorageClusterId: row.id,
      name: row.name,
      status: row.status,
      action,
    });
  }
}
