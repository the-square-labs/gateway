import type { DrizzleClient } from '@/db/client.js';
import type { ManagedStorageClusterRow, StorageBindingEnvironment } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { CreateManagedStorageBindingInput } from './managed-storage.schemas.js';
export class ManagedStorageBindingsService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _nodeDispatch: NodeDispatchService,
    _dockerManagement: DockerManagementService,
    _dockerDeployments: DockerDeploymentService,
    _dockerSecrets: DockerSecretService,
    _connectorImage: string,
    _relayPolicy?:
      | Pick<RelayPolicyService, 'ensureStorageBindingRoute' | 'getNodeGrantBundle' | 'revokeOwner'>
      | undefined,
    _storageCA?: import('@/services/storage-ca.service.js').StorageCAService | undefined
  ) {}
  setEventBus(_bus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async list(_clusterId: string): Promise<
    {
      id: string;
      clusterId: string;
      targetNodeId: string;
      targetType: 'container' | 'deployment';
      targetResourceId: string;
      connectorAlias: string;
      environment: StorageBindingEnvironment;
      buckets: string[];
      accessKeyId: string | null;
      status: 'error' | 'ready' | 'creating' | 'deleting';
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async create(
    _clusterId: string,
    _input: CreateManagedStorageBindingInput,
    _userId: string
  ): Promise<{
    id: string;
    clusterId: string;
    targetNodeId: string;
    targetType: 'container' | 'deployment';
    targetResourceId: string;
    connectorAlias: string;
    environment: StorageBindingEnvironment;
    buckets: string[];
    accessKeyId: string | null;
    status: 'error' | 'ready' | 'creating' | 'deleting';
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    return commercialModuleUnavailable();
  }
  async getTarget(
    _clusterId: string,
    _bindingId: string
  ): Promise<{
    targetNodeId: string;
    targetType: 'container' | 'deployment';
    targetResourceId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(
    _clusterId: string,
    _bindingId: string,
    _userId: string,
    _targetEnvironment?: Record<string, string>
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteAllForCluster(_cluster: ManagedStorageClusterRow, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
