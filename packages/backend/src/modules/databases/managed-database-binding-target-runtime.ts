import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedDatabaseBindings, type managedDatabaseInstances } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { isGatewayInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import {
  managedDatabaseBindingListenerConfig,
  requireManagedDatabaseBindingListenerReady,
} from './managed-database-binding-host-listener.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;

export interface ManagedDatabaseBindingCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

interface TargetRuntimeReconciler {
  reconcileTargetNode(nodeId: string): Promise<void>;
  releaseTargetNetwork(nodeId: string, networkName: string): Promise<void>;
}

interface BindingNetworkState {
  exists: boolean;
  gateway?: string;
}

function enginePort(type: ManagedDatabaseRow['type']): number {
  switch (type) {
    case 'postgres':
      return 5432;
    case 'redis':
      return 6379;
    case 'clickhouse':
      return 8123;
  }
}

function assertUserBindingTarget(inspect: Record<string, any> | null | undefined): void {
  if (inspect && isGatewayInternalContainer(inspect)) {
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  }
}

function isMissingContainerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no such container|container not found)/i.test(message);
}

function requireSuccess(result: { success: boolean; detail?: string; error?: string }) {
  if (!result.success) throw new Error(`daemon operation failed${result.error ? `: ${result.error}` : ''}`);
  return result;
}

function requireSuccessOrMissing(result: { success: boolean; detail?: string; error?: string }) {
  if (result.success || /not found|no such/i.test(result.error ?? '')) return result;
  throw new Error(`daemon operation failed${result.error ? `: ${result.error}` : ''}`);
}

function requireNetworkConnectSuccess(result: { success: boolean; error?: string }) {
  if (result.success || /(?:already exists in network|already connected|endpoint.*exists)/i.test(result.error ?? '')) {
    return;
  }
  requireSuccess(result);
}

function requireNetworkDisconnectSuccess(result: { success: boolean; error?: string }) {
  if (result.success || /(?:not found|no such|not connected|is not connected)/i.test(result.error ?? '')) return;
  requireSuccess(result);
}

function environmentMap(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries)) return {};
  return Object.fromEntries(
    entries
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => {
        const separator = entry.indexOf('=');
        return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
      })
  );
}

export class ManagedDatabaseBindingTargetRuntime {
  private reconciler?: TargetRuntimeReconciler;
  private readonly reconciliations = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly dockerManagement: DockerManagementService,
    private readonly dockerDeployments: DockerDeploymentService,
    private readonly dockerSecrets: DockerSecretService,
    private readonly relayPolicy?: Pick<
      RelayPolicyService,
      'ensureBindingRoute' | 'syncNodeGrantBundle' | 'probeManagedDatabaseBindingRoute'
    >,
    private readonly dockerCompose?: DockerComposeService
  ) {}

  setReconciler(reconciler: TargetRuntimeReconciler): void {
    this.reconciler = reconciler;
  }

  async reconcile(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ): Promise<void> {
    if (!this.relayPolicy) return;
    const existing = this.reconciliations.get(binding.id);
    if (existing) return existing;
    const reconciliation = this.performReconciliation(database, binding, credentials);
    this.reconciliations.set(binding.id, reconciliation);
    try {
      await reconciliation;
    } finally {
      if (this.reconciliations.get(binding.id) === reconciliation) this.reconciliations.delete(binding.id);
    }
  }

  private async performReconciliation(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ) {
    let listenerAddress = await this.ensureHostListener(database, binding);
    try {
      await this.validate(binding, listenerAddress);
    } catch {
      await this.apply(database, binding, credentials, '00000000-0000-0000-0000-000000000000', {
        forceDeploymentRollout: true,
      });
      await this.reconciler?.reconcileTargetNode(binding.targetNodeId);
      listenerAddress = await this.ensureHostListener(database, binding);
      await this.validate(binding, listenerAddress);
    }
    requireSuccessOrMissing(
      await this.nodeDispatch.sendDockerContainerCommand(binding.targetNodeId, 'remove', {
        containerId: binding.connectorName,
        force: true,
      })
    );
  }

  private async ensureHostListener(database: ManagedDatabaseRow, binding: ManagedDatabaseBindingRow) {
    let network = await this.networkState(binding);
    if (!network.exists) {
      requireSuccess(
        await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'create', {
          networkId: binding.networkName,
          driver: 'bridge',
        })
      );
      network = await this.networkState(binding);
    }
    const listener = managedDatabaseBindingListenerConfig({
      networkName: binding.networkName,
      gatewayAddress: network.gateway,
      listenPort: enginePort(database.type),
      allowedSources: await this.bindingTargetSources(binding),
    });
    await this.relayPolicy!.ensureBindingRoute(
      binding.id,
      binding.managedDatabaseId,
      binding.targetNodeId,
      database.nodeId,
      listener
    );
    const targetPrepared = await this.relayPolicy!.syncNodeGrantBundle(binding.targetNodeId);
    requireManagedDatabaseBindingListenerReady(targetPrepared, binding.id, listener.listenAddress);
    if (database.nodeId !== binding.targetNodeId) {
      requireSuccess(await this.relayPolicy!.syncNodeGrantBundle(database.nodeId));
    }
    await this.relayPolicy!.probeManagedDatabaseBindingRoute(binding.targetNodeId, binding.id);
    if (binding.connectorAddress !== listener.listenAddress) {
      await this.persistEndpointAddress(binding.id, listener.listenAddress);
      binding.connectorAddress = listener.listenAddress;
    }
    return listener.listenAddress;
  }

  private async validate(binding: ManagedDatabaseBindingRow, listenerAddress: string) {
    const containerNames = await this.bindingTargetContainerNames(binding);
    const expectedHost = `${binding.connectorAlias}:${listenerAddress}`;
    for (const containerName of containerNames) {
      const inspect = await this.dockerManagement.inspectContainer(binding.targetNodeId, containerName);
      assertUserBindingTarget(inspect);
      if (!inspect?.NetworkSettings?.Networks?.[binding.networkName]) {
        throw new Error(`managed database binding target ${containerName} is disconnected from its binding network`);
      }
      const extraHosts = Array.isArray(inspect?.HostConfig?.ExtraHosts) ? inspect.HostConfig.ExtraHosts : [];
      if (!extraHosts.includes(expectedHost)) {
        throw new Error(`managed database binding target ${containerName} has a stale database endpoint`);
      }
    }
  }

  private async networkState(binding: ManagedDatabaseBindingRow): Promise<BindingNetworkState> {
    const listed = requireSuccess(await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'list', {}));
    let networks: Array<Record<string, any>>;
    try {
      const parsed = JSON.parse(listed.detail ?? '');
      if (!Array.isArray(parsed)) throw new Error('network list is not an array');
      networks = parsed;
    } catch {
      throw new Error('managed database network inventory is unavailable');
    }
    const existing = networks.find((network) => (network.Name ?? network.name) === binding.networkName);
    if (!existing) return { exists: false };
    const driver = existing.Driver ?? existing.driver;
    if (typeof driver === 'string' && driver !== 'bridge') {
      throw new Error(`network ${binding.networkName} exists with an unexpected driver`);
    }
    const configs = existing.IPAM?.Config ?? existing.ipam?.config ?? [];
    const ipv4 = Array.isArray(configs)
      ? configs.find((config) => typeof (config?.Gateway ?? config?.gateway) === 'string')
      : undefined;
    const gateway = ipv4?.Gateway ?? ipv4?.gateway;
    return { exists: true, gateway: typeof gateway === 'string' ? gateway : undefined };
  }

  private async bindingTargetSources(binding: ManagedDatabaseBindingRow): Promise<string[]> {
    if (binding.targetType === 'compose_service') {
      const target = await this.requireComposeService().resolveServiceTarget(
        binding.targetNodeId,
        binding.targetResourceId,
        true
      );
      return [`compose:${target.project.name}:${target.serviceName}`];
    }
    if (binding.targetType === 'deployment') return [`deployment:${binding.targetResourceId}`];
    return [`container:${binding.targetResourceId}`];
  }

  private async bindingTargetContainerNames(binding: ManagedDatabaseBindingRow) {
    if (binding.targetType === 'compose_service') {
      const target = await this.requireComposeService().resolveServiceTarget(
        binding.targetNodeId,
        binding.targetResourceId,
        true
      );
      const containers = await this.dockerManagement.listContainers(binding.targetNodeId);
      const names = containers
        .filter((container: any) => {
          const labels = container.Labels ?? container.labels ?? {};
          return (
            labels['com.docker.compose.project'] === target.project.name &&
            labels['com.docker.compose.service'] === target.serviceName
          );
        })
        .map((container: any) =>
          String(container.Names?.[0] ?? container.Name ?? container.name ?? '').replace(/^\/+/, '')
        )
        .filter(Boolean);
      if (names.length === 0)
        throw new Error(`managed database Compose target ${target.serviceName} has no containers`);
      return names;
    }
    if (binding.targetType === 'deployment') {
      const deployment = await this.dockerDeployments.get(binding.targetNodeId, binding.targetResourceId);
      const names = deployment.slots
        .map((slot) => slot.containerName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      if (names.length === 0) {
        throw new Error(`managed database binding target ${binding.targetResourceId} has no runtime containers`);
      }
      return names;
    }
    return [binding.targetResourceId];
  }

  async prepareNetworkRemoval(binding: ManagedDatabaseBindingRow): Promise<void> {
    await this.reconciler?.releaseTargetNetwork(binding.targetNodeId, binding.networkName);
  }

  async apply(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    userId: string,
    options: {
      replaceExistingEnvironment?: boolean;
      targetEnvironment?: Record<string, string>;
      forceDeploymentRollout?: boolean;
    } = {}
  ) {
    const values = this.environmentValues(database, binding, credentials);
    if (binding.targetType === 'compose_service') {
      await this.requireComposeService().applyManagedDatabaseBinding(
        binding.targetNodeId,
        binding.targetResourceId,
        binding.id,
        binding.networkName,
        binding.connectorAlias,
        binding.connectorAddress ?? undefined,
        values,
        userId
      );
      return;
    }
    if (binding.targetType === 'deployment') {
      const secretContainer = `deployment:${binding.targetResourceId}`;
      for (const [key, value] of Object.entries(values)) {
        await this.dockerSecrets.create(binding.targetNodeId, secretContainer, key, value, userId, { managed: true });
      }
      try {
        await this.dockerDeployments.setManagedDatabaseBindingNetwork(
          binding.targetNodeId,
          binding.targetResourceId,
          binding.networkName,
          true,
          userId,
          options.forceDeploymentRollout === true
        );
      } catch (error) {
        await this.removeDeploymentSecrets(binding, Object.keys(values), userId);
        throw error;
      }
      return;
    }

    const targetBefore = await this.dockerManagement.inspectContainer(binding.targetNodeId, binding.targetResourceId);
    assertUserBindingTarget(targetBefore);
    const targetName = String(targetBefore?.Name ?? '').replace(/^\/+/, '');
    const targetRuntimeId = String(targetBefore?.Id ?? '');
    const expectedState = targetBefore?.State?.Status === 'running' ? 'running' : 'created';
    requireNetworkConnectSuccess(
      await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'connect', {
        networkId: binding.networkName,
        containerId: binding.targetResourceId,
      })
    );
    const current = environmentMap(
      await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)
    );
    const ordinaryEnvironment = { ...(options.targetEnvironment ?? current) };
    const managedNames = Object.keys(values);
    for (const name of managedNames) {
      await this.dockerSecrets.create(binding.targetNodeId, binding.targetResourceId, name, values[name]!, userId, {
        managed: true,
      });
      delete ordinaryEnvironment[name];
    }
    const removeEnv = Object.keys(current).filter(
      (name) => !Object.hasOwn(ordinaryEnvironment, name) || managedNames.includes(name)
    );
    const updated = await this.dockerManagement.updateContainerEnv(
      binding.targetNodeId,
      binding.targetResourceId,
      ordinaryEnvironment,
      removeEnv,
      userId
    );
    const updatedName = typeof (updated as any)?.name === 'string' ? (updated as any).name : targetName;
    if (updatedName && targetRuntimeId)
      await this.waitForConvergence(binding.targetNodeId, updatedName, targetRuntimeId, expectedState);
  }

  async remove(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    userId: string,
    options: { targetEnvironment?: Record<string, string> } = {}
  ) {
    const expected = this.environmentValues(database, binding, credentials);
    const variableNames = Object.keys(expected);
    if (binding.targetType === 'compose_service') {
      await this.requireComposeService().removeManagedDatabaseBinding(
        binding.targetNodeId,
        binding.targetResourceId,
        binding.id,
        binding.networkName,
        binding.connectorAlias,
        binding.connectorAddress ?? undefined,
        expected,
        userId
      );
      return;
    }
    if (binding.targetType === 'deployment') {
      const secretContainer = `deployment:${binding.targetResourceId}`;
      const values = await this.matchingDeploymentSecretValues(binding, expected);
      await this.removeDeploymentSecrets(binding, Object.keys(values), userId);
      try {
        await this.dockerDeployments.setManagedDatabaseBindingNetwork(
          binding.targetNodeId,
          binding.targetResourceId,
          binding.networkName,
          false,
          userId
        );
      } catch (error) {
        for (const [key, value] of Object.entries(values)) {
          await this.dockerSecrets.create(binding.targetNodeId, secretContainer, key, value, userId);
        }
        throw error;
      }
      const deployment = await this.dockerDeployments.get(binding.targetNodeId, binding.targetResourceId);
      for (const slot of deployment.slots) {
        if (slot.containerName) {
          await this.nodeDispatch
            .sendDockerNetworkCommand(binding.targetNodeId, 'disconnect', {
              networkId: binding.networkName,
              containerId: slot.containerName,
            })
            .catch(() => undefined);
        }
      }
      return;
    }

    // Disconnect before recreating the container to remove managed env/secrets.
    // Otherwise Docker preserves the binding network as HostConfig.NetworkMode;
    // deleting that network afterwards leaves a stale primary network mode and
    // prevents a future binding network from being attached to the workload.
    requireNetworkDisconnectSuccess(
      await this.nodeDispatch.sendDockerNetworkCommand(binding.targetNodeId, 'disconnect', {
        networkId: binding.networkName,
        containerId: binding.targetResourceId,
      })
    );
    try {
      const secrets = await this.dockerSecrets.list(binding.targetNodeId, binding.targetResourceId, true, true);
      for (const secret of secrets) {
        if (variableNames.includes(secret.key) && secret.value === expected[secret.key]) {
          await this.dockerSecrets.delete(secret.id, binding.targetNodeId, userId, binding.targetResourceId);
        }
      }
      const current = environmentMap(
        await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)
      );
      const ordinaryEnvironment = { ...(options.targetEnvironment ?? current) };
      for (const name of variableNames) delete ordinaryEnvironment[name];
      const removeEnv = Array.from(
        new Set([...variableNames, ...Object.keys(current).filter((name) => !Object.hasOwn(ordinaryEnvironment, name))])
      );
      const targetBefore = await this.dockerManagement.inspectContainer(binding.targetNodeId, binding.targetResourceId);
      const targetName = String(targetBefore?.Name ?? '').replace(/^\/+/, '');
      const targetRuntimeId = String(targetBefore?.Id ?? '');
      const expectedState = targetBefore?.State?.Status === 'running' ? 'running' : 'created';
      const updated = await this.dockerManagement.updateContainerEnv(
        binding.targetNodeId,
        binding.targetResourceId,
        ordinaryEnvironment,
        removeEnv,
        userId
      );
      const updatedName = typeof (updated as any)?.name === 'string' ? (updated as any).name : targetName;
      if (updatedName && targetRuntimeId)
        await this.waitForConvergence(binding.targetNodeId, updatedName, targetRuntimeId, expectedState);
    } catch (error) {
      if (!isMissingContainerError(error)) throw error;
    }
  }

  async verifyValues(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ) {
    if (binding.targetType === 'compose_service') return;
    const expected = this.environmentValues(database, binding, credentials);
    if (binding.targetType === 'deployment') {
      const values = await this.matchingDeploymentSecretValues(binding, expected);
      if (Object.keys(values).length !== Object.keys(expected).length) {
        throw new Error(
          `managed database binding target ${binding.targetResourceId} did not persist pending credentials`
        );
      }
      return;
    }
    const current = environmentMap(
      await this.dockerManagement.getContainerEnv(binding.targetNodeId, binding.targetResourceId)
    );
    const secrets = await this.dockerSecrets.list(binding.targetNodeId, binding.targetResourceId, true, true);
    const secretValues = Object.fromEntries(secrets.map((secret) => [secret.key, secret.value]));
    for (const [key, value] of Object.entries(expected)) {
      if (current[key] !== value && secretValues[key] !== value) {
        throw new Error(`managed database binding target ${binding.targetResourceId} did not apply ${key}`);
      }
    }
  }

  private environmentValues(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ): Record<string, string> {
    const host = binding.connectorAlias;
    const port = enginePort(database.type);
    const databaseName = credentials.databaseName;
    const connectionUri =
      database.type === 'redis'
        ? `redis://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}`
        : database.type === 'clickhouse'
          ? `http://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}/?database=${encodeURIComponent(databaseName ?? 'default')}`
          : `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}:${port}/${encodeURIComponent(databaseName ?? 'app')}`;
    const values: Record<string, string> = {};
    if (binding.environment.connectionUri) values[binding.environment.connectionUri] = connectionUri;
    if (binding.environment.host) values[binding.environment.host] = host;
    if (binding.environment.port) values[binding.environment.port] = String(port);
    if (binding.environment.database && databaseName) values[binding.environment.database] = databaseName;
    if (binding.environment.username) values[binding.environment.username] = credentials.username;
    if (binding.environment.password) values[binding.environment.password] = credentials.password;
    return values;
  }

  private async persistEndpointAddress(bindingId: string, address: string) {
    if (isIP(address) !== 4) throw new Error(`managed database binding ${bindingId} returned an invalid IPv4 address`);
    await this.db
      .update(managedDatabaseBindings)
      .set({ connectorAddress: address, updatedAt: new Date() })
      .where(eq(managedDatabaseBindings.id, bindingId));
  }

  private async waitForConvergence(
    nodeId: string,
    containerName: string,
    previousId: string,
    expectedState: 'running' | 'created'
  ) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const inspect = await this.dockerManagement.inspectContainer(nodeId, containerName);
        const currentId = String(inspect?.Id ?? '');
        const state = String(inspect?.State?.Status ?? '').toLowerCase();
        const reachedExpectedState = state
          ? state === expectedState
          : expectedState === 'running'
            ? inspect?.State?.Running === true
            : inspect?.State?.Running === false;
        if (currentId && currentId !== previousId && reachedExpectedState && !inspect?._transition) return;
      } catch {
        // The stable name is briefly absent while the daemon swaps containers.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`managed database binding target ${containerName} did not finish recreating`);
  }

  private async matchingDeploymentSecretValues(binding: ManagedDatabaseBindingRow, expected: Record<string, string>) {
    const all = await this.dockerSecrets.getDecryptedMap(
      binding.targetNodeId,
      `deployment:${binding.targetResourceId}`
    );
    return Object.fromEntries(Object.entries(expected).filter(([key, value]) => all[key] === value));
  }

  private async removeDeploymentSecrets(binding: ManagedDatabaseBindingRow, keys: string[], userId: string) {
    const rows = await this.dockerSecrets.list(
      binding.targetNodeId,
      `deployment:${binding.targetResourceId}`,
      false,
      true
    );
    for (const row of rows) {
      if (keys.includes(row.key)) {
        await this.dockerSecrets.delete(row.id, binding.targetNodeId, userId, `deployment:${binding.targetResourceId}`);
      }
    }
  }

  private requireComposeService() {
    if (!this.dockerCompose) {
      throw new AppError(503, 'COMPOSE_SERVICE_UNAVAILABLE', 'Compose service integration is unavailable');
    }
    return this.dockerCompose;
  }
}
