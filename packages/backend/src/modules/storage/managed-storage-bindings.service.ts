import crypto from 'node:crypto';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type ManagedStorageBindingRow,
  type ManagedStorageClusterRow,
  managedDatabaseBindings,
  managedStorageBindings,
  managedStorageClusters,
  nodes,
  type StorageBindingEnvironment,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { isGatewayInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { CreateManagedStorageBindingInput } from './managed-storage.schemas.js';
import { resolveStorageIamDispatchOpts } from './managed-storage-iam-dispatch.js';
import { buildManagedStoragePolicy } from './managed-storage-iam-policy.js';

const logger = createChildLogger('ManagedStorageBindings');

/** MinIO's S3 port inside the binding network. */
const STORAGE_BINDING_PORT = 9000;
const immutableImageReference = /^[^\s]+@sha256:[a-f0-9]{64}$/i;

interface BindingCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

interface TargetBindingSnapshot {
  environment: Record<string, string>;
  ownedSecrets: Record<string, string>;
  networkAttached: boolean;
  wasRunning: boolean;
}

/**
 * Private routes from application workloads to a managed storage cluster.
 *
 * The managed-database binding's twin, and deliberately so: a connector
 * sidecar fronts the cluster inside a per-binding network, the application
 * reaches it by alias, and no S3 port is published on the node. The one real
 * difference is the credential — S3 has no per-binding database user, so each
 * binding owns a scoped IAM access key restricted to the buckets it declared.
 */
export class ManagedStorageBindingsService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly dockerManagement: DockerManagementService,
    private readonly dockerDeployments: DockerDeploymentService,
    private readonly dockerSecrets: DockerSecretService,
    private readonly connectorImage: string,
    private readonly relayPolicy?: Pick<
      RelayPolicyService,
      'ensureStorageBindingRoute' | 'getNodeGrantBundle' | 'revokeOwner'
    >,
    private readonly storageCA?: import('@/services/storage-ca.service.js').StorageCAService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async list(clusterId: string) {
    const rows = await this.db
      .select()
      .from(managedStorageBindings)
      .where(eq(managedStorageBindings.clusterId, clusterId))
      .orderBy(asc(managedStorageBindings.createdAt));
    return rows.map((row) => this.toView(row));
  }

  async create(clusterId: string, input: CreateManagedStorageBindingInput, userId: string) {
    // LICENSE ENFORCEMENT: Storage bindings only exist for Gateway-managed clusters, so they stay behind the same Personal entitlement.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('managed-storage');
    const cluster = await this.getReadyCluster(clusterId);
    this.assertConnectorImage();
    input = { ...input, targetResourceId: await this.resolveTarget(input) };
    await this.assertTargetEnvironmentAvailable(input);
    const id = crypto.randomUUID();
    const shortId = id.replaceAll('-', '').slice(0, 16);

    // Lock the cluster while inserting so a concurrent cluster delete cannot
    // race past an empty binding list and tear down the cluster underneath an
    // in-flight binding.
    const row = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(managedStorageClusters)
        .where(eq(managedStorageClusters.id, clusterId))
        .for('update');
      if (!locked) throw new AppError(404, 'MANAGED_STORAGE_NOT_FOUND', 'Managed storage cluster not found');
      if (locked.status !== 'ready' || locked.pendingOperation) {
        throw new AppError(409, 'MANAGED_STORAGE_NOT_READY', 'Managed storage cluster is not ready for bindings');
      }
      // Serialize claims across clusters targeting the same node, including
      // bindings whose secrets have not been provisioned yet.
      await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, input.targetNodeId)).for('update');
      const requested = new Set(Object.values(input.environment).filter(Boolean));
      for (const table of [managedStorageBindings, managedDatabaseBindings]) {
        const claims = await tx
          .select({ environment: table.environment })
          .from(table)
          .where(
            and(
              eq(table.targetNodeId, input.targetNodeId),
              eq(table.targetType, input.targetType),
              eq(table.targetResourceId, input.targetResourceId)
            )
          );
        if (claims.some((claim) => Object.values(claim.environment).some((name) => name && requested.has(name)))) {
          throw new AppError(
            409,
            'MANAGED_STORAGE_BINDING_ENV_CONFLICT',
            'A managed link already uses an environment variable'
          );
        }
      }
      const [created] = await tx
        .insert(managedStorageBindings)
        .values({
          id,
          clusterId,
          targetNodeId: input.targetNodeId,
          targetType: input.targetType,
          targetResourceId: input.targetResourceId,
          networkName: `gateway-storage-${shortId}`,
          connectorName: `gateway-storage-connector-${id}`,
          connectorAlias: `storage-${shortId}`,
          environment: input.environment,
          buckets: input.buckets ?? [],
          status: 'creating',
          createdById: userId,
          updatedById: userId,
        })
        .returning();
      return created!;
    });

    await this.auditService.log({
      userId,
      action: 'storage.managed.binding.create',
      resourceType: 'managed_storage_binding',
      resourceId: row.id,
      details: {
        clusterId,
        targetNodeId: row.targetNodeId,
        targetType: row.targetType,
        targetResourceId: row.targetResourceId,
        buckets: row.buckets,
      },
    });
    this.emit(row, 'binding.created');
    return this.provisionBinding(cluster, row, userId, input.targetEnvironment);
  }

  async getTarget(clusterId: string, bindingId: string) {
    const row = await this.getBinding(clusterId, bindingId);
    return { targetNodeId: row.targetNodeId, targetType: row.targetType, targetResourceId: row.targetResourceId };
  }

  async delete(clusterId: string, bindingId: string, userId: string, targetEnvironment?: Record<string, string>) {
    const row = await this.getBinding(clusterId, bindingId);
    const [cluster] = await this.db
      .select()
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, clusterId))
      .limit(1);
    await this.setStatus(row.id, 'deleting', null, userId);
    await this.deprovisionBinding(cluster, row, userId, targetEnvironment);
    await this.db.delete(managedStorageBindings).where(eq(managedStorageBindings.id, row.id));
    await this.auditService.log({
      userId,
      action: 'storage.managed.binding.delete',
      resourceType: 'managed_storage_binding',
      resourceId: row.id,
      details: { clusterId, targetResourceId: row.targetResourceId },
    });
    this.emit(row, 'binding.deleted');
    return { success: true };
  }

  /**
   * Tears down every binding of a cluster that is about to be deleted. The FK
   * cascade would drop the rows, but the connector containers, networks and
   * relay routes live outside the database and would be left behind.
   */
  async deleteAllForCluster(cluster: ManagedStorageClusterRow, userId: string) {
    const rows = await this.db
      .select()
      .from(managedStorageBindings)
      .where(eq(managedStorageBindings.clusterId, cluster.id));
    for (const row of rows) {
      await this.deprovisionBinding(cluster, row, userId);
      await this.db.delete(managedStorageBindings).where(eq(managedStorageBindings.id, row.id));
    }
  }

  private async provisionBinding(
    cluster: ManagedStorageClusterRow,
    binding: ManagedStorageBindingRow,
    userId: string,
    targetEnvironment?: Record<string, string>
  ) {
    let keyCreated = false;
    let routePrepared = false;
    let networkCreated = false;
    let connectorCreated = false;
    let credentials: BindingCredentials | null = null;
    let targetStarted = false;
    let targetEnvironmentBefore: Record<string, string> | undefined;
    try {
      credentials = await this.createScopedKey(cluster, binding);
      keyCreated = true;
      await this.setStatus(binding.id, 'creating', null, userId, credentials.accessKeyId);

      if (!this.relayPolicy) throw new Error('Gateway relay policy is unavailable');
      await this.relayPolicy.ensureStorageBindingRoute(binding.id, cluster.id, binding.targetNodeId, cluster.nodeId);
      routePrepared = true;

      // The ACK proves the source daemon persisted its connect grant; its
      // detail carries the daemon-owned socket the connector mounts.
      const prepared = this.requireSuccess(
        await this.nodeDispatch.sendRelayGrantBundle(
          binding.targetNodeId,
          await this.relayPolicy.getNodeGrantBundle(binding.targetNodeId)
        )
      );
      const socketMount = this.tunnelSocketMount(prepared.detail);

      this.requireSuccess(
        await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'create_storage_binding', {
          networkId: binding.networkName,
          driver: 'bridge',
        })
      );
      networkCreated = true;

      this.requireSuccess(
        await this.nodeDispatch.sendDockerImageCommand(binding.targetNodeId, this.connectorImageAction(), {
          imageRef: this.connectorImage,
        })
      );
      const caPem = cluster.tlsEnabled ? (await this.iamOpts(cluster)).caPem : undefined;
      const connector = this.requireSuccess(
        await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'create', {
          configJson: JSON.stringify({
            name: binding.connectorName,
            image: this.connectorImage,
            user: '65532:65532',
            env: [
              `GATEWAY_CONNECTOR_BINDING_ID=${binding.id}`,
              `GATEWAY_CONNECTOR_SOCKET=${socketMount.connectorPath}`,
              `GATEWAY_CONNECTOR_LISTEN=:${STORAGE_BINDING_PORT}`,
              ...(caPem ? [`GATEWAY_CONNECTOR_CA_PEM=${caPem}`, 'GATEWAY_CONNECTOR_SERVER_NAME=localhost'] : []),
            ],
            binds: [`${path.posix.dirname(socketMount.hostPath)}:/run/gateway:ro`],
            network_mode: binding.networkName,
            network_aliases: [binding.connectorAlias],
            restartPolicy: 'unless-stopped',
            // The daemon only lets an internal connector bind the relay tunnel
            // socket directory when workload kind, name prefix and marker label
            // all line up (see isManagedWorkloadConnector in the Docker daemon).
            internal_workload: 'managed-storage-connector',
            labels: {
              'gateway.managed-storage.binding-id': binding.id,
              'wiolett.gateway.managed-storage.connector': 'true',
              'wiolett.gateway.internal-workload': 'managed-storage-connector',
            },
          }),
        })
      );
      connectorCreated = true;
      this.requireSuccess(
        await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'start', {
          containerId: this.containerID(connector.detail),
        })
      );

      targetEnvironmentBefore = await this.targetEnvironmentSnapshot(binding);
      targetStarted = true;
      await this.applyTargetBinding(binding, credentials, userId, targetEnvironment);
      const ready = await this.setStatus(binding.id, 'ready', null, userId, credentials.accessKeyId);
      this.emit(ready, 'binding.ready');
      return this.toView(ready);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to provision the managed storage binding';
      await this.compensate(
        cluster,
        binding,
        credentials,
        {
          keyCreated,
          routePrepared,
          networkCreated,
          connectorCreated,
          targetStarted,
        },
        targetEnvironmentBefore,
        userId
      );
      const failed = await this.setStatus(binding.id, 'error', message, userId);
      this.emit(failed, 'binding.error');
      throw new AppError(502, 'MANAGED_STORAGE_BINDING_FAILED', message);
    }
  }

  /** Undoes exactly the provisioning steps that had completed when one failed. */
  private async compensate(
    cluster: ManagedStorageClusterRow,
    binding: ManagedStorageBindingRow,
    credentials: BindingCredentials | null,
    done: {
      keyCreated: boolean;
      routePrepared: boolean;
      networkCreated: boolean;
      connectorCreated: boolean;
      targetStarted: boolean;
    },
    targetEnvironmentBefore: Record<string, string> | undefined,
    userId: string
  ) {
    const swallow = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        logger.warn(`Managed storage binding compensation step failed: ${label}`, {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    let targetRemoved = !done.targetStarted;
    if (done.targetStarted) {
      try {
        await this.removeTargetBinding(binding, userId, targetEnvironmentBefore);
        targetRemoved = true;
      } catch (error) {
        logger.warn('Managed storage binding compensation step failed: remove target binding', {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // The target may still be using the binding-owned one-time credentials.
    // Do not revoke its route or IAM key until target removal has completed.
    if (!targetRemoved) return;
    if (done.connectorCreated) {
      await swallow('remove connector', () =>
        this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'remove', {
          containerId: binding.connectorName,
          force: true,
        })
      );
    }
    if (done.networkCreated) {
      await swallow('remove network', () =>
        this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'remove', { networkId: binding.networkName })
      );
    }
    if (done.routePrepared) {
      await swallow('revoke route', () => this.relayPolicy!.revokeOwner('managed_storage_binding', binding.id));
    }
    if (done.keyCreated && credentials) {
      await swallow('revoke access key', () => this.removeScopedKey(cluster, credentials.accessKeyId));
    }
  }

  private async deprovisionBinding(
    cluster: ManagedStorageClusterRow | undefined,
    binding: ManagedStorageBindingRow,
    userId: string,
    targetEnvironment?: Record<string, string>
  ) {
    // A binding retains cleanup ownership until every external resource is removed.
    await this.removeTargetBinding(binding, userId, targetEnvironment);
    if (this.relayPolicy) await this.relayPolicy.revokeOwner('managed_storage_binding', binding.id);
    if (cluster && binding.accessKeyId) await this.removeScopedKey(cluster, binding.accessKeyId);
    const removed = await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'remove', {
      containerId: binding.connectorName,
      force: true,
    });
    if (!removed.success && !/not found|no such container/i.test(removed.error ?? '')) this.requireSuccess(removed);
    const network = await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'remove', {
      networkId: binding.networkName,
    });
    if (!network.success && !/not found|no such network/i.test(network.error ?? '')) this.requireSuccess(network);
  }

  // ── Target workload wiring ────────────────────────────────────────

  private async resolveTarget(input: CreateManagedStorageBindingInput): Promise<string> {
    if (input.targetType === 'deployment') {
      await this.dockerDeployments.get(input.targetNodeId, input.targetResourceId);
      return input.targetResourceId;
    }
    const inspect = await this.dockerManagement.inspectUserContainer(input.targetNodeId, input.targetResourceId);
    if (!inspect || isGatewayInternalContainer(inspect))
      throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
    if (inspect.Config?.Labels?.['wiolett.gateway.deployment.managed'] === 'true') {
      throw new AppError(409, 'MANAGED_DEPLOYMENT_CONTAINER', 'Use a deployment target for a blue/green container');
    }
    const name = typeof inspect.Name === 'string' ? inspect.Name.replace(/^\/+/, '') : '';
    if (!name) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
    return name;
  }

  private async assertTargetEnvironmentAvailable(input: CreateManagedStorageBindingInput) {
    const names = Object.values(input.environment).filter((name): name is string => Boolean(name));
    if (!names.length || new Set(names).size !== names.length) {
      throw new AppError(400, 'MANAGED_STORAGE_BINDING_ENV_INVALID', 'Use distinct environment variable names');
    }
    const target = input.targetType === 'deployment' ? `deployment:${input.targetResourceId}` : input.targetResourceId;
    const existing = await this.dockerSecrets.getSecretKeys(input.targetNodeId, target);
    if (input.targetType === 'deployment') {
      const deployment = await this.dockerDeployments.get(input.targetNodeId, input.targetResourceId);
      for (const name of Object.keys(input.targetEnvironment ?? deployment.desiredConfig.env ?? {})) existing.add(name);
    } else {
      const environment = input.targetEnvironment
        ? Object.keys(input.targetEnvironment)
        : (await this.dockerManagement.getContainerEnv(input.targetNodeId, input.targetResourceId)).map(
            (entry) => entry.split('=', 1)[0]!
          );
      for (const name of environment) existing.add(name);
    }
    if (names.some((name) => existing.has(name))) {
      throw new AppError(
        409,
        'MANAGED_STORAGE_BINDING_ENV_CONFLICT',
        'The workload already uses an environment variable'
      );
    }
  }

  private environmentValues(binding: ManagedStorageBindingRow, credentials: BindingCredentials) {
    const env = binding.environment;
    const values: Record<string, string> = {};
    const endpoint = `http://${binding.connectorAlias}:${STORAGE_BINDING_PORT}`;
    if (env.endpoint) values[env.endpoint] = endpoint;
    if (env.accessKeyId) values[env.accessKeyId] = credentials.accessKeyId;
    if (env.secretAccessKey) values[env.secretAccessKey] = credentials.secretAccessKey;
    if (env.bucket && binding.buckets[0]) values[env.bucket] = binding.buckets[0];
    // MinIO ignores the region but every S3 SDK insists on one being present.
    if (env.region) values[env.region] = 'us-east-1';
    return values;
  }

  private async applyTargetBinding(
    binding: ManagedStorageBindingRow,
    credentials: BindingCredentials,
    userId: string,
    targetEnvironment?: Record<string, string>
  ) {
    const values = this.environmentValues(binding, credentials);
    if (binding.targetType === 'deployment') {
      const secretContainer = `deployment:${binding.targetResourceId}`;
      for (const [key, value] of Object.entries(values)) {
        await this.dockerSecrets.create(binding.targetNodeId, secretContainer, key, value, userId, {
          managed: true,
          managedOwner: `storage-binding:${binding.id}`,
        });
      }
      await this.dockerDeployments.setManagedStorageBindingNetwork(
        binding.targetNodeId,
        binding.targetResourceId,
        binding.networkName,
        true,
        userId,
        targetEnvironment
      );
      return;
    }

    this.requireSuccess(
      await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'connect', {
        networkId: binding.networkName,
        containerId: binding.targetResourceId,
      })
    );
    // Credentials live in Docker secrets so they stay out of the ordinary
    // Environment editor while still being merged into the recreated container.
    for (const [key, value] of Object.entries(values)) {
      await this.dockerSecrets.create(binding.targetNodeId, binding.targetResourceId, key, value, userId, {
        managed: true,
        managedOwner: `storage-binding:${binding.id}`,
      });
    }
    await this.updateTargetEnvironment(binding, Object.keys(values), userId, targetEnvironment);
  }

  private async removeTargetBinding(
    binding: ManagedStorageBindingRow,
    userId: string,
    targetEnvironment?: Record<string, string>
  ) {
    const names = new Set(Object.values(binding.environment).filter((name): name is string => Boolean(name)));
    const secretContainer =
      binding.targetType === 'deployment' ? `deployment:${binding.targetResourceId}` : binding.targetResourceId;
    const snapshot = await this.snapshotTargetBinding(binding, secretContainer, names);
    try {
      await this.dockerSecrets.deleteOwned(
        binding.targetNodeId,
        secretContainer,
        `storage-binding:${binding.id}`,
        userId
      );
      if (binding.targetType === 'deployment') {
        await this.dockerDeployments.setManagedStorageBindingNetwork(
          binding.targetNodeId,
          binding.targetResourceId,
          binding.networkName,
          false,
          userId,
          targetEnvironment
        );
        // The drained blue/green slot can outlive the rollout; detach both
        // known slots before removing the binding-owned network.
        const deployment = await this.dockerDeployments.get(binding.targetNodeId, binding.targetResourceId);
        for (const slot of deployment.slots) {
          if (!slot.containerName) continue;
          const result = await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'disconnect', {
            networkId: binding.networkName,
            containerId: slot.containerName,
          });
          if (!result.success && !/not found|not connected|no such/i.test(result.error ?? ''))
            this.requireSuccess(result);
        }
        return;
      }
      const disconnected = await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'disconnect', {
        networkId: binding.networkName,
        containerId: binding.targetResourceId,
      });
      if (!disconnected.success && !/not found|not connected|no such/i.test(disconnected.error ?? ''))
        this.requireSuccess(disconnected);
      await this.updateTargetEnvironment(binding, [...names], userId, targetEnvironment);
    } catch (error) {
      await this.restoreTargetBinding(binding, secretContainer, names, snapshot, userId);
      throw error;
    }
  }

  private async snapshotTargetBinding(
    binding: ManagedStorageBindingRow,
    secretContainer: string,
    names: ReadonlySet<string>
  ): Promise<TargetBindingSnapshot> {
    const secrets = await this.dockerSecrets.getDecryptedMap(binding.targetNodeId, secretContainer);
    // The internal map deliberately excludes ownership metadata. Restrict the
    // snapshot to this binding's reserved names; restore uses the same owner
    // and DockerSecretService rejects another owner's row rather than replacing it.
    const ownedSecrets = Object.fromEntries(
      [...names].flatMap((name) => (secrets[name] === undefined ? [] : [[name, secrets[name]]]))
    );
    const environment = await this.targetEnvironmentSnapshot(binding);
    if (binding.targetType === 'deployment') {
      // A persisted binding is the deployment-level declaration that this
      // network is attached; the deployment service owns its slot topology.
      return { environment, ownedSecrets, networkAttached: true, wasRunning: false };
    }
    const target = await this.dockerManagement.inspectUserContainer(binding.targetNodeId, binding.targetResourceId);
    return {
      environment,
      ownedSecrets,
      networkAttached: Boolean(target?.NetworkSettings?.Networks?.[binding.networkName]),
      wasRunning: target?.State?.Status === 'running',
    };
  }

  private async restoreTargetBinding(
    binding: ManagedStorageBindingRow,
    secretContainer: string,
    names: ReadonlySet<string>,
    snapshot: TargetBindingSnapshot,
    userId: string
  ): Promise<void> {
    const attempt = async (label: string, operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        logger.warn(`Managed storage binding target restore failed: ${label}`, {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    if (binding.targetType === 'container' && snapshot.networkAttached) {
      await attempt('reconnect network', async () => {
        this.requireSuccess(
          await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'connect', {
            networkId: binding.networkName,
            containerId: binding.targetResourceId,
          })
        );
      });
    }
    for (const [key, value] of Object.entries(snapshot.ownedSecrets)) {
      await attempt(`restore secret ${key}`, () =>
        this.dockerSecrets.create(binding.targetNodeId, secretContainer, key, value, userId, {
          managed: true,
          managedOwner: `storage-binding:${binding.id}`,
        })
      );
    }
    if (binding.targetType === 'deployment') {
      if (snapshot.networkAttached) {
        await attempt('restore deployment network', () =>
          this.dockerDeployments.setManagedStorageBindingNetwork(
            binding.targetNodeId,
            binding.targetResourceId,
            binding.networkName,
            true,
            userId,
            snapshot.environment
          )
        );
      }
      return;
    }
    await attempt('restore environment', () =>
      this.updateTargetEnvironment(
        binding,
        [...names],
        userId,
        snapshot.environment,
        snapshot.wasRunning ? 'running' : 'created'
      )
    );
  }

  private async updateTargetEnvironment(
    binding: ManagedStorageBindingRow,
    managedNames: string[],
    userId: string,
    targetEnvironment?: Record<string, string>,
    expectedState?: 'running' | 'created'
  ) {
    const before = await this.dockerManagement.inspectUserContainer(binding.targetNodeId, binding.targetResourceId);
    const current = Object.fromEntries(
      (await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)).map(
        (entry: string) => {
          const index = entry.indexOf('=');
          return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
        }
      )
    );
    const ordinary = { ...(targetEnvironment ?? current) };
    for (const name of managedNames) delete ordinary[name];
    const remove = [
      ...new Set([...managedNames, ...Object.keys(current).filter((name) => !Object.hasOwn(ordinary, name))]),
    ];
    await this.dockerManagement.updateContainerEnv(
      binding.targetNodeId,
      binding.targetResourceId,
      ordinary,
      remove,
      userId
    );
    const expected = expectedState ?? (before.State?.Status === 'running' ? 'running' : 'created');
    const deadline = Date.now() + 120_000;
    let startRequestedForId: string | null = null;
    while (Date.now() < deadline) {
      try {
        const inspect = await this.dockerManagement.inspectUserContainer(
          binding.targetNodeId,
          binding.targetResourceId
        );
        if (
          expected === 'running' &&
          inspect?.Id &&
          inspect.State?.Status === 'created' &&
          startRequestedForId !== inspect.Id
        ) {
          this.requireSuccess(
            await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'start', {
              containerId: inspect.Id,
            })
          );
          startRequestedForId = inspect.Id;
          continue;
        }
        if (inspect?.Id && inspect.Id !== before.Id && inspect.State?.Status === expected && !inspect._transition)
          return;
      } catch {
        /* The stable name is briefly absent during the container swap. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Storage link target did not finish recreating');
  }

  private async targetEnvironmentSnapshot(binding: ManagedStorageBindingRow): Promise<Record<string, string>> {
    if (binding.targetType === 'deployment') {
      const deployment = await this.dockerDeployments.get(binding.targetNodeId, binding.targetResourceId);
      return { ...(deployment.desiredConfig.env ?? {}) };
    }
    return Object.fromEntries(
      (await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)).map(
        (entry: string) => {
          const index = entry.indexOf('=');
          return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
        }
      )
    );
  }

  // ── Scoped IAM key ────────────────────────────────────────────────

  private async createScopedKey(
    cluster: ManagedStorageClusterRow,
    binding: ManagedStorageBindingRow
  ): Promise<BindingCredentials> {
    const opts = await this.iamOpts(cluster);
    const result = this.requireSuccess(
      await this.nodeDispatch.sendDockerStorageIamCommand(cluster.nodeId, 'create_key', cluster.id, {
        ...opts,
        name: `binding:${binding.id.replaceAll('-', '').slice(0, 24)}`,
        // A binding's key is confined to the buckets the operator declared, so
        // a compromised workload cannot read the rest of the cluster.
        policy: buildManagedStoragePolicy('read-write', binding.buckets),
      })
    );
    const parsed = JSON.parse(result.detail ?? '{}') as { accessKey?: unknown; secretKey?: unknown };
    if (typeof parsed.accessKey !== 'string' || typeof parsed.secretKey !== 'string') {
      throw new Error('daemon returned an invalid access key response');
    }
    return { accessKeyId: parsed.accessKey, secretAccessKey: parsed.secretKey };
  }

  private async removeScopedKey(cluster: ManagedStorageClusterRow, accessKeyId: string) {
    const opts = await this.iamOpts(cluster);
    const result = await this.nodeDispatch.sendDockerStorageIamCommand(cluster.nodeId, 'remove_key', cluster.id, {
      ...opts,
      targetAccessKey: accessKeyId,
    });
    if (!result.success && !/specified service account is not found|no such service account/i.test(result.error ?? ''))
      this.requireSuccess(result);
  }

  private async iamOpts(cluster: ManagedStorageClusterRow) {
    const credentials = JSON.parse(
      this.cryptoService.decryptString(
        JSON.parse(cluster.encryptedRootCredentials) as { encryptedKey: string; encryptedDek: string }
      )
    ) as { username: string; password: string };
    return resolveStorageIamDispatchOpts(this.db, cluster, credentials, this.storageCA);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async getReadyCluster(clusterId: string): Promise<ManagedStorageClusterRow> {
    const [row] = await this.db
      .select()
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, clusterId))
      .limit(1);
    if (!row) throw new AppError(404, 'MANAGED_STORAGE_NOT_FOUND', 'Managed storage cluster not found');
    if (row.status !== 'ready' || row.pendingOperation) {
      throw new AppError(409, 'MANAGED_STORAGE_NOT_READY', 'Managed storage cluster is not ready for bindings');
    }
    return row;
  }

  private async getBinding(clusterId: string, bindingId: string): Promise<ManagedStorageBindingRow> {
    const [row] = await this.db
      .select()
      .from(managedStorageBindings)
      .where(and(eq(managedStorageBindings.clusterId, clusterId), eq(managedStorageBindings.id, bindingId)))
      .limit(1);
    if (!row) throw new AppError(404, 'MANAGED_STORAGE_BINDING_NOT_FOUND', 'Managed storage binding not found');
    return row;
  }

  private async setStatus(
    id: string,
    status: ManagedStorageBindingRow['status'],
    lastError: string | null,
    userId: string,
    accessKeyId?: string
  ) {
    const [updated] = await this.db
      .update(managedStorageBindings)
      .set({
        status,
        lastError,
        ...(accessKeyId ? { accessKeyId } : {}),
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(managedStorageBindings.id, id))
      .returning();
    return updated!;
  }

  private toView(row: ManagedStorageBindingRow) {
    return {
      id: row.id,
      clusterId: row.clusterId,
      targetNodeId: row.targetNodeId,
      targetType: row.targetType,
      targetResourceId: row.targetResourceId,
      connectorAlias: row.connectorAlias,
      environment: row.environment as StorageBindingEnvironment,
      buckets: row.buckets,
      accessKeyId: row.accessKeyId,
      status: row.status,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private emit(row: ManagedStorageBindingRow, action: string) {
    this.eventBus?.publish('storage.changed', { id: row.clusterId, action, bindingId: row.id });
  }

  private assertConnectorImage() {
    if (immutableImageReference.test(this.connectorImage) || this.usesDevelopmentConnectorImage()) return;
    throw new AppError(
      503,
      'MANAGED_STORAGE_CONNECTOR_UNAVAILABLE',
      'Workload connector image is not configured with an immutable digest'
    );
  }

  private usesDevelopmentConnectorImage() {
    return this.connectorImage === DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE;
  }

  private connectorImageAction(): 'ensure' | 'ensure-local' {
    return this.usesDevelopmentConnectorImage() ? 'ensure-local' : 'ensure';
  }

  private requireSuccess<T extends { success: boolean; detail?: string; error?: string }>(result: T): T {
    if (!result.success) throw new Error(`daemon operation failed${result.error ? `: ${result.error}` : ''}`);
    return result;
  }

  private tunnelSocketMount(detail: string | undefined) {
    const parsed = JSON.parse(detail ?? '{}') as { storageSocketPath?: unknown };
    const hostPath = parsed.storageSocketPath;
    if (
      typeof hostPath !== 'string' ||
      !path.posix.isAbsolute(hostPath) ||
      path.posix.basename(hostPath) !== 'storage-relay.sock' ||
      path.posix.basename(path.posix.dirname(hostPath)) !== 'storage-connector'
    ) {
      throw new Error('Storage connector socket is unavailable; update the target daemon');
    }
    return { hostPath, connectorPath: '/run/gateway/storage-relay.sock' };
  }

  private containerID(detail: string | undefined) {
    try {
      const parsed = JSON.parse(detail ?? '') as { id?: unknown; Id?: unknown };
      const id = typeof parsed.id === 'string' ? parsed.id : parsed.Id;
      if (typeof id === 'string' && /^[a-f0-9]{12,128}$/i.test(id)) return id;
    } catch {
      // Convert malformed daemon details to a generic provisioning error.
    }
    throw new Error('connector container was not created');
  }
}
