import type { DrizzleClient } from '@/db/client.js';
import type { managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type {
  DockerAvailabilityAdapterContext,
  DockerAvailabilityResolvedResource,
} from '@/modules/docker/availability/docker-availability.types.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { CreateManagedDatabaseBindingInput } from './databases.schemas.js';

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;
interface ManagedDatabaseIdentityManager {
  ensureBindingIdentity(managedDatabaseId: string, userId: string | null): Promise<ManagedDatabaseRow>;
  finalizeBindingIdentity(managedDatabaseId: string, userId: string | null): Promise<ManagedDatabaseRow>;
  runBindingLifecycleOperation<T>(managedDatabaseId: string, operation: () => Promise<T>): Promise<T>;
}
interface ManagedDatabaseAvailabilityCoordinator {
  resolvePolicyId(target: {
    targetNodeId: string;
    targetType: ManagedDatabaseBindingRow['targetType'];
    targetResourceId: string;
  }): Promise<string | null>;
  queueDependencyRollout(policyId: string, userId: string | null): Promise<void>;
  removeBinding(policyId: string, userId: string | null): Promise<void>;
}
export class ManagedDatabaseBindingService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _nodeDispatch: NodeDispatchService,
    _dockerManagement: DockerManagementService,
    _dockerDeployments: DockerDeploymentService,
    _dockerSecrets: DockerSecretService,
    _relayPolicy?:
      | (Pick<
          RelayPolicyService,
          | 'ensureBindingRoute'
          | 'adoptBindingRoute'
          | 'syncNodeGrantBundle'
          | 'probeManagedDatabaseBindingRoute'
          | 'revokeOwner'
        > &
          Partial<Pick<RelayPolicyService, 'getManagedDatabaseBindingRouteRuntime'>>)
      | undefined,
    _dockerCompose?: DockerComposeService,
    _identityManager?: ManagedDatabaseIdentityManager | undefined
  ) {}
  setEventBus(_bus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  setTargetRuntimeReconciler(_reconciler: {
    reconcileTargetNode(nodeId: string): Promise<void>;
    releaseTargetNetwork(nodeId: string, networkName: string): Promise<void>;
  }): void {}
  setAvailabilityCoordinator(_coordinator: ManagedDatabaseAvailabilityCoordinator): void {}
  async list(_managedDatabaseId: string): Promise<
    {
      id: string;
      managedDatabaseId: string;
      targetNodeId: string;
      targetType: 'container' | 'deployment' | 'compose_service';
      targetResourceId: string;
      environment: import('@/db/schema/index.js').DatabaseBindingEnvironment;
      status: 'error' | 'creating' | 'ready' | 'deleting';
      observedState: import('@/db/schema/index.js').ManagedDatabaseBindingObservedState;
      lastError: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async getTarget(
    _managedDatabaseId: string,
    _bindingId: string
  ): Promise<{
    targetNodeId: string;
    targetType: 'container' | 'deployment' | 'compose_service';
    targetResourceId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async getRuntime(
    _managedDatabaseId: string,
    _bindingId: string
  ): Promise<{
    binding: {
      id: string;
      managedDatabaseId: string;
      targetNodeId: string;
      targetType: 'container' | 'deployment' | 'compose_service';
      targetResourceId: string;
      environment: import('@/db/schema/index.js').DatabaseBindingEnvironment;
      status: 'error' | 'creating' | 'ready' | 'deleting';
      observedState: import('@/db/schema/index.js').ManagedDatabaseBindingObservedState;
      lastError: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    runtime: import('@/services/relay-policy.service.js').RelayRouteRuntime | null;
  }> {
    return commercialModuleUnavailable();
  }
  async availabilityPreflight(
    _resource: DockerAvailabilityResolvedResource,
    _scopes: string[]
  ): Promise<
    {
      code: string;
      message: string;
      resource: string;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async prepareAvailabilityPlacement(_context: DockerAvailabilityAdapterContext): Promise<
    Array<{
      bindingId: string;
      projectionId: string;
      networkName: string;
      connectorAlias: string;
      connectorAddress: string;
      logicalNetworkName: string;
      logicalConnectorAddress?: string;
      environment: Record<string, string>;
      composeServiceName?: string;
    }>
  > {
    return commercialModuleUnavailable();
  }
  async cleanupAvailabilityPlacement(_availabilityPlacementId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async adoptAvailabilityPlacementAsSingle(_context: DockerAvailabilityAdapterContext): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcileBindingPrincipals(_nodeId?: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async create(
    _managedDatabaseId: string,
    _input: CreateManagedDatabaseBindingInput,
    _userId: string
  ): Promise<{
    id: string;
    managedDatabaseId: string;
    targetNodeId: string;
    targetType: 'container' | 'deployment' | 'compose_service';
    targetResourceId: string;
    environment: import('@/db/schema/index.js').DatabaseBindingEnvironment;
    status: 'error' | 'creating' | 'ready' | 'deleting';
    observedState: import('@/db/schema/index.js').ManagedDatabaseBindingObservedState;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(
    _managedDatabaseId: string,
    _bindingId: string,
    _userId: string,
    _options?: {
      targetEnvironment?: Record<string, string>;
    }
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async revealCredentials(
    _managedDatabaseId: string,
    _bindingId: string
  ): Promise<{
    databaseName?: string | undefined;
    connectionUri: string;
    host: string;
    port: number;
    username: string;
    password: string;
  }> {
    return commercialModuleUnavailable();
  }
}
