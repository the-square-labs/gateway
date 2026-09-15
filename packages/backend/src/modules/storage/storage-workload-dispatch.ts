import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type ManagedStorageClusterRow, managedStorageClusters } from '@/db/schema/managed-storage.js';
import { nodes } from '@/db/schema/nodes.js';
import { objectStorageConnections } from '@/db/schema/object-storage.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type {
  CreateSucceededContext,
  DaemonWorkloadState,
  DispatchResult,
  ManagedWorkloadDispatch,
} from '@/modules/managed-workloads/managed-workload-dispatch.js';
import type { WorkloadRowPatch } from '@/modules/managed-workloads/managed-workload-store.js';
import type { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
import { safeManagedStorageView } from './managed-storage-view.js';
import { StorageClusterMemberStore } from './storage-cluster-member-store.js';
import type { StorageWorkloadProvider } from './storage-workload-provider.js';

/** Decrypted MinIO root (owner) credentials for a managed storage cluster. */
export interface StorageRootCredentials {
  username: string;
  password: string;
}

/**
 * Deterministic container name for one MEMBER of a managed storage cluster:
 * addressable from `clusterId` + `memberIndex` alone (no DB read needed).
 * Single-node clusters are member 0 — `gateway-storage-<id>-0` — which is the
 * one behavioral change from the pre-fan-out single-container name
 * (`gateway-storage-<id>`, no suffix). That rename is safe: no live
 * single-node cluster predates this change, so there is nothing to migrate.
 */
export const memberContainerName = (clusterId: string, memberIndex: number) =>
  `gateway-storage-${clusterId}-${memberIndex}`;

/**
 * The Docker network a managed storage member container is reachable on.
 * `renderCommandPayload` below sets no `network_mode` on the container
 * config, so every member lands on Docker's default bridge network — whose
 * name, as reported under `NetworkSettings.Networks` on a container inspect,
 * is literally `bridge`. The daemon's storage-target dial (`dialStorageTarget`
 * in `storage_tunnel.go`) looks up the container's private IP by this exact
 * key, so the register-target dispatch (`ManagedStorageService.create`) must
 * send this same value.
 */
export const MANAGED_STORAGE_CONTAINER_NETWORK = 'bridge';

/** A cluster member's node identity, independent of its resolved host. */
interface StorageMemberRef {
  nodeId: string;
  memberIndex: number;
}

/** A cluster member with its dispatch-resolved host, for pool-arg rendering. */
interface StorageMemberWithHost extends StorageMemberRef {
  host: string;
}

/** One member's rendered create/update config, keyed by the node it targets. */
interface StorageCreatePayloadEntry {
  memberNodeId: string;
  memberIndex: number;
  config: Record<string, unknown>;
}

/** One member's reduced inspect fact, as folded into an `inspect` quorum summary. */
interface StorageQuorumMemberSummary {
  memberIndex: number;
  found: boolean;
  running: boolean;
  starting?: boolean;
  operationId?: string;
}

interface StorageQuorumSummary {
  memberCount: number;
  members: StorageQuorumMemberSummary[];
}

/**
 * Renders the MinIO `server` command's pool argument for a cluster's member
 * set. `N=1` renders the pre-fan-out single-node local-mode command
 * byte-for-byte (`['server', '/data', ...]` — no host list, since there's
 * only one node to talk about). `N>=4` (MinIO's erasure-coding minimum)
 * renders the distributed pool topology: every member gets the SAME command,
 * listing every member's `<scheme>://<host>:<port>/data`, ordered by
 * `memberIndex` for stable, reproducible pool args across members and
 * redeploys.
 *
 * `N` of 2 or 3 is below the EC minimum and above the single-node case; the
 * service layer rejects that topology before a cluster row (and therefore
 * any dispatch call) can exist, so this is a defensive invariant check, not
 * a reachable runtime path — fail loudly instead of silently rendering a
 * broken pool arg.
 */
export function renderPoolArg(
  members: { host: string; memberIndex: number }[],
  port: number,
  scheme: 'http' | 'https'
): string[] {
  if (members.length === 1) return ['server', '/data', '--console-address', ':9001'];
  if (members.length >= 4) {
    const ordered = [...members].sort((a, b) => a.memberIndex - b.memberIndex);
    return ['server', ...ordered.map((m) => `${scheme}://${m.host}:${port}/data`), '--console-address', ':9001'];
  }
  throw new AppError(
    500,
    'MANAGED_STORAGE_INVALID_MEMBER_COUNT',
    `Managed storage pool arg requires 1 or >=4 members, got ${members.length}`
  );
}

/**
 * A row's `encryptedRootCredentials` (or `encryptedSftpHostKey`) column
 * stores `JSON.stringify({encryptedKey, encryptedDek})` (the shape
 * `CryptoService.encryptString` returns) — mirrors
 * `parseEncryptedCredentials` in `modules/databases/managed-databases.service.ts`.
 * `label` only flavors the corrupt-value error message for whichever
 * envelope is being parsed.
 */
function parseEncryptedCredentials(
  value: string,
  label = 'root credentials'
): { encryptedKey: string; encryptedDek: string } {
  try {
    const parsed = JSON.parse(value) as { encryptedKey?: string; encryptedDek?: string };
    if (typeof parsed.encryptedKey === 'string' && typeof parsed.encryptedDek === 'string') {
      return parsed as { encryptedKey: string; encryptedDek: string };
    }
  } catch {
    // fall through to the error below
  }
  throw new AppError(500, 'MANAGED_STORAGE_CREDENTIALS_CORRUPT', `Managed storage ${label} are corrupt`);
}

/**
 * `ManagedWorkloadDispatch` for managed object storage (MinIO), provisioned
 * through the restricted `sendDockerStorageCommand` RPC, alongside the
 * DB-typed `sendDockerDatabaseCommand` path `DatabaseWorkloadDispatch` uses.
 * Structurally mirrors `DatabaseWorkloadDispatch`
 * (`modules/databases/database-workload-dispatch.ts`); the storage-specific
 * differences are: no direct-access principal, no native port, a fixed
 * published port set at create time, and MinIO reconfiguration is a
 * remove+recreate against the container's named data volume rather than an
 * in-place daemon update.
 */
export class StorageWorkloadDispatch
  implements ManagedWorkloadDispatch<ManagedStorageClusterRow, StorageRootCredentials>
{
  private eventBus?: EventBusService;

  constructor(
    private readonly nodeDispatch: NodeDispatchService,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    // Kept for shape parity with `DatabaseWorkloadDispatch` and for the
    // container-spec work that still lives in the provider seam; this dispatch
    // renders storage payloads itself, so it never reads it.
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: see above
    private readonly provider: StorageWorkloadProvider,
    private readonly objectStorageService: ObjectStorageService,
    private readonly db: DrizzleClient,
    // Defaulted (rather than required) so existing 6-arg call sites keep
    // compiling untouched; bootstrap now wires one shared instance in
    // explicitly (see bootstrap.ts), passed identically to
    // ManagedStorageService. Fan-out is entirely dispatch-owned — the shared
    // lifecycle core and DB stay oblivious to member count; it still calls
    // `sendCommand(nodeId, ...)` with the cluster's primary nodeId, which
    // this dispatch ignores in favor of the resolved member set. N=1 renders
    // single-node local mode (byte-identical modulo a `-0` container-name
    // suffix); N≥4 renders a distributed pool over plain http (TLS-from-CA
    // and relay land in later phases).
    private readonly memberStore: StorageClusterMemberStore = new StorageClusterMemberStore(db),
    // Optional and defaulted (undefined = TLS-less) so existing call sites
    // keep compiling untouched. `bootstrap.ts` wires the shared
    // `StorageCAService` instance in explicitly. TLS delivery is STRICTLY
    // gated on `row.tlsEnabled` in `renderCommandPayload` — leaving this
    // unset (or the row TLS-disabled) reproduces today's plain-http payload
    // byte-for-byte, since that path is live-validated.
    private readonly storageCA?: StorageCAService,
    // Optional so existing call sites keep compiling; required in practice for
    // relay-enabled clusters, whose reachability is a relay endpoint.
    private readonly relayPolicy?: Pick<RelayPolicyService, 'ensureManagedStorageEndpoint'>
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  /**
   * Resolves a cluster's members plus each member's dispatch host
   * (`nodes.serviceAddress ?? nodes.hostname`), ordered by `memberIndex`.
   * Legacy rows created before members were wired everywhere have no
   * `managed_storage_cluster_members` rows yet — synthesize the single
   * implicit member `{nodeId: row.nodeId, memberIndex: 0}` so `N=1` keeps
   * working unconditionally.
   */
  private async resolveMembersWithHost(row: ManagedStorageClusterRow): Promise<StorageMemberWithHost[]> {
    const stored = await this.memberStore.listByCluster(row.id);
    const members: StorageMemberRef[] =
      stored.length > 0
        ? stored.map((m) => ({ nodeId: m.nodeId, memberIndex: m.memberIndex }))
        : [{ nodeId: row.nodeId, memberIndex: 0 }];

    const nodeRows = await this.db
      .select({ id: nodes.id, hostname: nodes.hostname, serviceAddress: nodes.serviceAddress })
      .from(nodes)
      .where(
        inArray(
          nodes.id,
          members.map((m) => m.nodeId)
        )
      );
    const hostByNodeId = new Map(nodeRows.map((n) => [n.id, n.serviceAddress ?? n.hostname]));

    return members
      .map((m) => {
        const host = hostByNodeId.get(m.nodeId);
        if (!host) {
          throw new AppError(
            404,
            'MANAGED_STORAGE_MEMBER_NODE_NOT_FOUND',
            `Managed storage member node not found: ${m.nodeId}`
          );
        }
        return { ...m, host };
      })
      .sort((a, b) => a.memberIndex - b.memberIndex);
  }

  /**
   * As {@link resolveMembersWithHost}, but for actions that don't need a
   * resolved host (restart/remove/inspect address containers by name).
   * `fallbackNodeId` is the core's primary nodeId argument to `sendCommand`
   * — reused as the synthesized legacy single member's node when no
   * `managed_storage_cluster_members` rows exist for `clusterId`.
   */
  private async resolveMemberRefs(clusterId: string, fallbackNodeId: string): Promise<StorageMemberRef[]> {
    const stored = await this.memberStore.listByCluster(clusterId);
    if (stored.length > 0) return stored.map((m) => ({ nodeId: m.nodeId, memberIndex: m.memberIndex }));
    return [{ nodeId: fallbackNodeId, memberIndex: 0 }];
  }

  /**
   * Per-member create/update payload for `row`. Every member gets the SAME
   * pool-arg `cmd` (the full MinIO server-pool topology, per
   * {@link renderPoolArg}) but its own container name/binds keyed by
   * `memberIndex`. Returned as a JSON array of `{memberNodeId, memberIndex,
   * config}` entries — `sendCommand` fans out over these, opaquely to the
   * shared lifecycle core (it only ever passes the payload string through).
   * For `N=1` the single entry's `config` is byte-identical to the
   * pre-fan-out single-node config, except `name`/`binds` carry the `-0`
   * member suffix (see {@link memberContainerName}).
   */
  // TLS-serving flow across the lifecycle: `create` and `update` (remove+create)
  // stage the cert files into `/root/.minio/certs` here so MinIO serves HTTPS
  // from first start; `restart` returns '' below and simply restarts the
  // existing container, which keeps its already-mounted cert bind; a failed
  // create's `retryProvisioning` re-runs `dispatchCreate` → this path, so certs
  // are re-staged. Every lifecycle op therefore delivers/preserves the certs
  // for a `tlsEnabled` cluster with no per-op special-casing.
  async renderCommandPayload(row: ManagedStorageClusterRow, action: string): Promise<string> {
    if (action !== 'create' && action !== 'update') return '';

    const credentials = this.readOwnerCredentials(row);
    const members = await this.resolveMembersWithHost(row);
    const tlsMaterial =
      row.tlsEnabled && row.certificateId && this.storageCA
        ? await this.storageCA.getManagedStorageCertificateMaterial(row.certificateId)
        : null;
    if (row.tlsEnabled && !tlsMaterial)
      throw new AppError(409, 'MANAGED_STORAGE_TLS_UNAVAILABLE', 'Managed storage TLS material is unavailable');
    const hostKey = row.sftpEnabled
      ? this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedSftpHostKey ?? '', 'SFTP host key'))
      : undefined;
    const entries: StorageCreatePayloadEntry[] = members.map((member) => ({
      memberNodeId: member.nodeId,
      memberIndex: member.memberIndex,
      config: {
        version: 1,
        operationId: row.pendingOperation?.id,
        image: row.imageRef,
        imageCatalogId: `minio-release-${row.version}`,
        rootCredentials: { accessKey: credentials.username, secretKey: credentials.password },
        resources: {
          nanoCPUs: row.runtimeConfig.nanoCPUs,
          memoryBytes: row.runtimeConfig.memoryLimitBytes,
          memorySwapBytes: row.runtimeConfig.memorySwapBytes,
          storageBytes: Number(row.storageSizeBytes),
        },
        publishS3: row.publishS3 ?? false,
        publishedPort: row.publishS3 || members.length > 1 ? row.publishedPort : 0,
        relayEnabled: row.relayEnabled,
        memberIndex: member.memberIndex,
        members:
          members.length === 1
            ? []
            : members.map((peer) => ({
                memberIndex: peer.memberIndex,
                endpoint: `${tlsMaterial ? 'https' : 'http'}://${peer.host}:${row.publishedPort}/data`,
              })),
        ...(members.length > 1 ? { peerBindAddress: member.host } : {}),
        ...(tlsMaterial
          ? {
              tls: {
                certPem: tlsMaterial.certificatePem,
                keyPem: tlsMaterial.privateKeyPem,
                caPem: tlsMaterial.caCertificatePem,
                serverName: member.host,
              },
            }
          : {}),
        ...(row.sftpEnabled ? { sftp: { port: row.sftpPort, hostKeyPem: hostKey } } : {}),
        ...(row.ftpEnabled
          ? {
              ftp: {
                port: row.ftpPort,
                passivePortStart: row.ftpPassivePortStart,
                passivePortCount: row.ftpPassivePortCount ?? 10,
              },
            }
          : {}),
      },
    }));
    return JSON.stringify(entries);
  }

  /**
   * Runs `op` over `items` in order; returns the FIRST failure, else the LAST
   * result (all-or-nothing success semantics). `items` is never empty in
   * practice — every cluster row resolves to at least the synthesized legacy
   * member 0 — but guard defensively rather than fabricate a placeholder
   * `DispatchResult`.
   */
  private async fanOut<T>(items: T[], op: (item: T) => Promise<DispatchResult>): Promise<DispatchResult> {
    if (items.length === 0) {
      throw new AppError(500, 'MANAGED_STORAGE_NO_MEMBERS', 'Managed storage dispatch has no members to fan out to');
    }
    let last = await op(items[0] as T);
    for (let i = 1; i < items.length && last.success; i++) {
      last = await op(items[i] as T);
    }
    return last;
  }

  /**
   * Provisions one member's MinIO container. The GENERIC docker container RPC
   * (unlike the DB-typed managed path) neither pulls the image nor starts the
   * container on `create`, so this does all three: pull-if-needed, create, then
   * start. `'pull'` (not `'ensure'`) is used because the managed-storage catalog
   * pins images by tag, not digest — `'ensure'` rejects non-digest refs. Returns
   * the first failing step, or the create result (its `{id,name}` detail) on
   * full success.
   */
  private async provisionMember(
    entry: StorageCreatePayloadEntry,
    id: string,
    action: 'create' | 'update',
    timeoutMs?: number
  ): Promise<DispatchResult> {
    return this.nodeDispatch.sendDockerStorageCommand(
      entry.memberNodeId,
      action,
      id,
      JSON.stringify(entry.config),
      timeoutMs
    );
  }

  /**
   * Inspects every member, normalizing each not-found container into a
   * recoverable fact (mirrors the single-node not-found normalization: a
   * missing member is not a transient failure the core should stall on). A
   * genuine transient failure (node offline, timeout) on ANY member is
   * surfaced as-is immediately, so the shared lifecycle core retries the
   * whole inspect next pass rather than acting on a partial quorum. On full
   * reachability, reduces to a single `DispatchResult` whose `detail` is a
   * {@link StorageQuorumSummary} JSON — `parseDaemonState` reads this shape
   * to compute the cluster-wide ready/stopped/missing verdict.
   */
  private async inspectQuorum(
    clusterId: string,
    members: StorageMemberRef[],
    timeoutMs?: number
  ): Promise<DispatchResult> {
    const perMember: StorageQuorumMemberSummary[] = [];
    for (const member of members) {
      const result = await this.nodeDispatch.sendDockerStorageCommand(
        member.nodeId,
        'inspect',
        clusterId,
        '',
        timeoutMs
      );
      if (!result.success) {
        if (/no such container|not found/i.test(result.error ?? '')) {
          perMember.push({ memberIndex: member.memberIndex, found: false, running: false });
          continue;
        }
        return result;
      }
      const parsed = this.parseRawContainerDetail(result.detail);
      perMember.push({
        memberIndex: member.memberIndex,
        found: parsed !== null,
        running: parsed?.running ?? false,
        starting: parsed?.starting ?? false,
        ...(parsed?.operationId ? { operationId: parsed.operationId } : {}),
      });
    }

    const summary: StorageQuorumSummary = { memberCount: members.length, members: perMember };
    return { success: true, error: '', detail: JSON.stringify(summary), data: Buffer.alloc(0), commandId: '' };
  }

  private parseRawContainerDetail(
    detail?: string
  ): { running: boolean; starting: boolean; operationId?: string } | null {
    let parsed: { status?: string; operationId?: string };
    try {
      parsed = JSON.parse(detail ?? '{}');
    } catch {
      return null;
    }
    if (!parsed.status || parsed.status === 'missing') return null;
    return {
      running: parsed.status === 'ready',
      starting: ['starting', 'creating'].includes(parsed.status),
      operationId: parsed.operationId,
    };
  }

  /**
   * Maps the lifecycle's kind-agnostic action vocabulary onto the generic
   * docker container RPC, fanned out per-member (see {@link fanOut}) and
   * addressed by {@link memberContainerName} rather than by a DB-typed
   * command. The `nodeId` argument is the core's cluster-primary nodeId —
   * IGNORED for member targeting (each member dispatches against its own
   * node) but reused as the fallback single member's node for legacy rows
   * with no `managed_storage_cluster_members` yet (see
   * {@link resolveMemberRefs}). `'update'` recreates each member's container
   * against its existing named volume (MinIO has no in-place reconfigure) —
   * the `remove` is best-effort (the container may not exist yet on a
   * first-ever apply).
   */
  async sendCommand(
    nodeId: string,
    action: string,
    id: string,
    payload: string,
    timeoutMs?: number
  ): Promise<DispatchResult> {
    if (action === 'create' || action === 'update') {
      const entries = JSON.parse(payload) as StorageCreatePayloadEntry[];
      return this.fanOut(entries, (entry) => this.provisionMember(entry, id, action, timeoutMs));
    }
    const members = await this.resolveMemberRefs(id, nodeId);
    if (action === 'inspect') return this.inspectQuorum(id, members, timeoutMs);
    if (action !== 'restart' && action !== 'remove')
      throw new AppError(400, 'INVALID_STORAGE_ACTION', 'Unknown managed storage operation');
    return this.fanOut(members, (member) =>
      this.nodeDispatch.sendDockerStorageCommand(
        member.nodeId,
        action === 'remove' ? 'delete_data' : action,
        id,
        payload,
        timeoutMs
      )
    );
  }

  // The operationId comes from a container label baked in by
  // `renderCommandPayload` — but ONLY for create/update (Docker's restart/remove
  // APIs can't relabel a live container, so those actions carry no fresh id).
  // The lifecycle core's reconcile guard replays when `state.operationId !==
  // operation.id`; a reconcile pass observed mid-restart therefore always sees a
  // stale (last create/update) label and replays. That is self-healing, not a
  // loop: the replayed restart is idempotent — worst case one redundant real
  // container restart in the narrow window where the original restart's daemon
  // response was lost.
  //
  // Quorum: `sendCommand`'s `inspect` reduces every member's inspect into a
  // single `StorageQuorumSummary` detail (see `inspectQuorum`) — that is the
  // PRIMARY shape parsed here. A cluster is `ready` iff strictly more than
  // half its members are running (for `N=1` that's simply the lone member
  // running); `missing` iff no member's container was found at all; else
  // `stopped`. The reported `operationId` is the lowest-memberIndex running
  // member's label. For callers that bypass the quorum reduction (e.g. a
  // direct single-container inspect result), a raw per-container detail
  // (`{State, Config}`, no `members` array) is still parsed the pre-fan-out
  // way, so this method keeps working for both shapes.
  parseDaemonState(result: DispatchResult): DaemonWorkloadState | null {
    if (!result.success || !result.detail) return { status: 'missing' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.detail);
    } catch {
      return null;
    }

    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { members?: unknown }).members)) {
      return this.parseQuorumSummary(parsed as StorageQuorumSummary);
    }

    if (parsed && typeof parsed === 'object' && 'status' in parsed) {
      const state = parsed as { status: string; operationId?: string };
      if (['ready', 'stopped', 'missing'].includes(state.status))
        return { status: state.status as 'ready' | 'stopped' | 'missing', operationId: state.operationId };
    }
    const raw = parsed as {
      State?: { Running?: boolean; Status?: string };
      Config?: { Labels?: Record<string, string> };
    };
    const running = raw?.State?.Running === true;
    const daemonStatus = raw?.State?.Status;
    const status = running ? 'ready' : daemonStatus === 'exited' ? 'stopped' : 'missing';
    const operationId = raw?.Config?.Labels?.['gateway.managed-storage.operationId'];
    return { status, ...(typeof operationId === 'string' ? { operationId } : {}) };
  }

  private parseQuorumSummary(summary: StorageQuorumSummary): DaemonWorkloadState | null {
    if (summary.members.some((member) => member.starting)) return null;
    const memberCount = typeof summary.memberCount === 'number' ? summary.memberCount : summary.members.length;
    const foundCount = summary.members.filter((m) => m.found).length;
    if (foundCount === 0) return { status: 'missing' };

    const runningMembers = summary.members.filter((m) => m.running).sort((a, b) => a.memberIndex - b.memberIndex);
    const status = runningMembers.length > Math.floor(memberCount / 2) ? 'ready' : 'stopped';
    const operationIds = new Set(summary.members.map((m) => m.operationId));
    const operationId = operationIds.size === 1 ? runningMembers[0]?.operationId : undefined;
    return { status, ...(typeof operationId === 'string' ? { operationId } : {}) };
  }

  async resolvePublishedPort(
    row: ManagedStorageClusterRow,
    _publishTcp: boolean,
    _result: { detail?: string }
  ): Promise<number | null> {
    return row.publishedPort;
  }

  async resolvePublishedNativePort(
    _row: ManagedStorageClusterRow,
    _publishNativeTcp: boolean,
    _result: { detail?: string }
  ): Promise<number | null> {
    return null;
  }

  async finalizeReady(
    row: ManagedStorageClusterRow,
    _ctx: {
      operation: 'create' | 'update' | 'restart';
      publishTcp: boolean;
      publishNativeTcp: boolean;
      result: { detail?: string };
    }
  ): Promise<WorkloadRowPatch> {
    const members = await this.resolveMemberRefs(row.id, row.nodeId);
    const deadline = Date.now() + 60_000;
    do {
      const result = await this.inspectQuorum(row.id, members, 10_000);
      if (result.success && this.parseDaemonState(result)?.status === 'ready') {
        return { publishedPort: row.publishedPort };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    throw new AppError(502, 'MANAGED_STORAGE_NOT_READY', 'Managed storage has not reached read/write quorum');
  }

  publishFlags(_row: ManagedStorageClusterRow): { publishTcp: boolean; publishNativeTcp: boolean } {
    return { publishTcp: _row.publishS3 ?? false, publishNativeTcp: false };
  }

  readOwnerCredentials(row: ManagedStorageClusterRow): StorageRootCredentials {
    return JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedRootCredentials))
    ) as StorageRootCredentials;
  }

  /** Managed storage has no direct-access principal distinct from the root credentials. */
  async ensureDirectAccess(
    row: ManagedStorageClusterRow,
    _userId: string | null,
    _provision: boolean
  ): Promise<{ row: ManagedStorageClusterRow; credentials: StorageRootCredentials }> {
    return { row, credentials: this.readOwnerCredentials(row) };
  }

  async provisionDirectAccess(
    _row: ManagedStorageClusterRow,
    _owner: StorageRootCredentials,
    _credentials: StorageRootCredentials
  ): Promise<void> {
    // No-op: no direct-access principal for managed storage.
  }

  /**
   * The canonical connection itself was already registered by the service at
   * create time (this is a no-op for that). For a `relayEnabled` cluster,
   * this ALSO (re-)registers the primary member's container coordinates with
   * the daemon's storage-target registry, so `ManagedStorageTunnelProxy` can
   * dial it — single-node only this task (member 0); a routable multi-member
   * relay is a later phase.
   *
   * Called from inside `ManagedWorkloadLifecycle.dispatchCreate`/
   * `dispatchUpdate`'s try block (after the container itself is already
   * created/recreated and running), which is the deliberate reason this lives
   * here rather than as a follow-up call in `ManagedStorageService.create`: a
   * thrown error is caught by that same try block and converted into the
   * lifecycle's normal `markError('create'/'update', ...)` — status:'error',
   * `pendingOperation` cleared, `lastError` set to `"Managed storage create
   * failed: ..."` (matching the prefix `ManagedStorageService.retryProvisioning`
   * gates on) — so a failed registration leaves a visible, retryable cluster
   * instead of a fully-committed row silently unreachable behind the relay.
   * Re-running via `retryProvisioning`/an update replays this same hook,
   * which is idempotent (the daemon registry overwrites by id).
   */
  async onCreateSucceeded(
    row: ManagedStorageClusterRow,
    _ctx: CreateSucceededContext<StorageRootCredentials>
  ): Promise<void> {
    if (!row.relayEnabled) return;
    if (!this.relayPolicy) {
      throw new AppError(502, 'MANAGED_STORAGE_RELAY_REGISTER_FAILED', 'Gateway relay is unavailable');
    }
    // Under the generic relay, reachability is a signed endpoint rather than a
    // container address dialed by the daemon: provisioning it here keeps the
    // same failure semantics as the old target registration, so a cluster that
    // cannot be reached stays visibly retryable instead of silently unreachable.
    try {
      await this.relayPolicy.ensureManagedStorageEndpoint(row.id, row.nodeId);
    } catch (error) {
      throw new AppError(
        502,
        'MANAGED_STORAGE_RELAY_REGISTER_FAILED',
        error instanceof Error ? error.message : 'Failed to provision the managed storage relay endpoint'
      );
    }
  }

  async onReady(_row: ManagedStorageClusterRow): Promise<void> {
    // No kind-specific cache to warm for MinIO.
  }

  async auditLifecycle(action: string, row: ManagedStorageClusterRow, userId: string | null): Promise<void> {
    await this.auditService.log({
      userId,
      action: `storage.managed.${action}`,
      resourceType: 'managed_storage_cluster',
      resourceId: row.id,
      details: { name: row.name },
    });
  }

  emit(row: ManagedStorageClusterRow, event: string): void {
    this.eventBus?.publish('managed-storage.changed', {
      id: row.objectStorageConnectionId ?? row.id,
      managedStorageClusterId: row.id,
      name: row.name,
      status: row.status,
      action: event,
    });
  }

  toView(row: ManagedStorageClusterRow): unknown {
    return safeManagedStorageView(row);
  }

  async assertNodeReady(nodeId: string): Promise<void> {
    const [node] = await this.db
      .select({ id: nodes.id, type: nodes.type, status: nodes.status })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Managed storage node not found');
    if (node.type !== 'storage' && node.type !== 'databases')
      throw new AppError(409, 'MANAGED_STORAGE_NODE_UNAVAILABLE', 'Managed storage requires a Storage node');
    if (node.status !== 'online')
      throw new AppError(409, 'MANAGED_STORAGE_NODE_UNAVAILABLE', 'Managed storage node is offline');
  }

  /** No certificate/replay-time refresh for managed storage (TLS deferred). */
  async prepareReplay(row: ManagedStorageClusterRow): Promise<ManagedStorageClusterRow> {
    return row;
  }

  /** No size-sync side effect for MinIO this phase. */
  async syncStorage(_row: ManagedStorageClusterRow): Promise<void> {}

  async onReconcileReady(
    row: ManagedStorageClusterRow,
    _result: { detail?: string }
  ): Promise<{ row: ManagedStorageClusterRow; readyPatch: WorkloadRowPatch }> {
    await this.onCreateSucceeded(row, { credentials: this.readOwnerCredentials(row), userId: null });
    return { row, readyPatch: { publishedPort: row.publishedPort } };
  }

  async disposeCanonicalClient(row: ManagedStorageClusterRow): Promise<void> {
    if (row.objectStorageConnectionId) {
      this.objectStorageService.disposeClient(row.objectStorageConnectionId);
    }
  }

  async commitDelete(row: ManagedStorageClusterRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(managedStorageClusters).where(eq(managedStorageClusters.id, row.id));
      if (row.objectStorageConnectionId)
        await tx.delete(objectStorageConnections).where(eq(objectStorageConnections.id, row.objectStorageConnectionId));
    });
    if (row.objectStorageConnectionId)
      this.eventBus?.publish('storage.changed', { id: row.objectStorageConnectionId, action: 'deleted' });
  }

  async deleteCanonicalConnection(row: ManagedStorageClusterRow): Promise<void> {
    await this.storageCA?.retireManagedStorageCertificates(row.id);
    if (row.objectStorageConnectionId) {
      await this.db
        .delete(objectStorageConnections)
        .where(eq(objectStorageConnections.id, row.objectStorageConnectionId));
      // Match ObjectStorageService.emitChange so the object-browser sidebar
      // drops the connection live instead of only after a manual refresh.
      this.eventBus?.publish('storage.changed', { id: row.objectStorageConnectionId, action: 'deleted' });
    }
  }
}
