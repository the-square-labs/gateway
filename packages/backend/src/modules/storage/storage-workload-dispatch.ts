import type { DrizzleClient } from '@/db/client.js';
import type { ManagedStorageClusterRow } from '@/db/schema/managed-storage.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
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
import type { StorageClusterMemberStore } from './storage-cluster-member-store.js';
import type { StorageWorkloadProvider } from './storage-workload-provider.js';
export interface StorageRootCredentials {
  username: string;
  password: string;
}
export declare const MANAGED_STORAGE_CONTAINER_NETWORK = 'bridge';
export declare function renderPoolArg(
  members: {
    host: string;
    memberIndex: number;
  }[],
  port: number,
  scheme: 'http' | 'https'
): string[];
export class StorageWorkloadDispatch
  implements ManagedWorkloadDispatch<ManagedStorageClusterRow, StorageRootCredentials>
{
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _nodeDispatch: NodeDispatchService,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _provider: StorageWorkloadProvider,
    _objectStorageService: ObjectStorageService,
    _db: DrizzleClient,
    _memberStore?: StorageClusterMemberStore,
    _storageCA?: StorageCAService | undefined,
    _relayPolicy?: Pick<RelayPolicyService, 'ensureManagedStorageEndpoint'> | undefined
  ) {}
  setEventBus(_bus: EventBusService): void {}
  async renderCommandPayload(_row: ManagedStorageClusterRow, _action: string): Promise<string> {
    return commercialModuleUnavailable();
  }
  async sendCommand(
    _nodeId: string,
    _action: string,
    _id: string,
    _payload: string,
    _timeoutMs?: number
  ): Promise<DispatchResult> {
    return commercialModuleUnavailable();
  }
  parseDaemonState(_result: DispatchResult): DaemonWorkloadState | null {
    return commercialModuleUnavailable();
  }
  async resolvePublishedPort(
    _row: ManagedStorageClusterRow,
    _publishTcp: boolean,
    _result: {
      detail?: string;
    }
  ): Promise<number | null> {
    return commercialModuleUnavailable();
  }
  async resolvePublishedNativePort(
    _row: ManagedStorageClusterRow,
    _publishNativeTcp: boolean,
    _result: {
      detail?: string;
    }
  ): Promise<number | null> {
    return commercialModuleUnavailable();
  }
  async finalizeReady(
    _row: ManagedStorageClusterRow,
    _ctx: {
      operation: 'create' | 'update' | 'restart';
      publishTcp: boolean;
      publishNativeTcp: boolean;
      result: {
        detail?: string;
      };
    }
  ): Promise<WorkloadRowPatch> {
    return commercialModuleUnavailable();
  }
  publishFlags(_row: ManagedStorageClusterRow): {
    publishTcp: boolean;
    publishNativeTcp: boolean;
  } {
    return commercialModuleUnavailable();
  }
  readOwnerCredentials(_row: ManagedStorageClusterRow): StorageRootCredentials {
    return commercialModuleUnavailable();
  }
  async ensureDirectAccess(
    _row: ManagedStorageClusterRow,
    _userId: string | null,
    _provision: boolean
  ): Promise<{
    row: ManagedStorageClusterRow;
    credentials: StorageRootCredentials;
  }> {
    return commercialModuleUnavailable();
  }
  async provisionDirectAccess(
    _row: ManagedStorageClusterRow,
    _owner: StorageRootCredentials,
    _credentials: StorageRootCredentials
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async onCreateSucceeded(
    _row: ManagedStorageClusterRow,
    _ctx: CreateSucceededContext<StorageRootCredentials>
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async onReady(_row: ManagedStorageClusterRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async auditLifecycle(_action: string, _row: ManagedStorageClusterRow, _userId: string | null): Promise<void> {
    return commercialModuleUnavailable();
  }
  emit(_row: ManagedStorageClusterRow, _event: string): void {
    commercialModuleUnavailable();
  }
  toView(_row: ManagedStorageClusterRow): unknown {
    return commercialModuleUnavailable();
  }
  async assertNodeReady(_nodeId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async prepareReplay(_row: ManagedStorageClusterRow): Promise<ManagedStorageClusterRow> {
    return commercialModuleUnavailable();
  }
  async syncStorage(_row: ManagedStorageClusterRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async onReconcileReady(
    _row: ManagedStorageClusterRow,
    _result: {
      detail?: string;
    }
  ): Promise<{
    row: ManagedStorageClusterRow;
    readyPatch: WorkloadRowPatch;
  }> {
    return commercialModuleUnavailable();
  }
  async disposeCanonicalClient(_row: ManagedStorageClusterRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async commitDelete(_row: ManagedStorageClusterRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteCanonicalConnection(_row: ManagedStorageClusterRow): Promise<void> {
    return commercialModuleUnavailable();
  }
}
