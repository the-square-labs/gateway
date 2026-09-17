import type { DrizzleClient } from '@/db/client.js';
import type { managedDatabaseBindings, managedDatabaseInstances } from '@/db/schema/index.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';

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
export declare class ManagedDatabaseBindingTargetRuntime {
  private readonly db;
  private readonly nodeDispatch;
  private readonly dockerManagement;
  private readonly dockerDeployments;
  private readonly dockerSecrets;
  private readonly relayPolicy?;
  private readonly dockerCompose?;
  private reconciler?;
  private readonly reconciliations;
  constructor(
    db: DrizzleClient,
    nodeDispatch: NodeDispatchService,
    dockerManagement: DockerManagementService,
    dockerDeployments: DockerDeploymentService,
    dockerSecrets: DockerSecretService,
    relayPolicy?:
      | Pick<
          RelayPolicyService,
          'ensureBindingRoute' | 'adoptBindingRoute' | 'syncNodeGrantBundle' | 'probeManagedDatabaseBindingRoute'
        >
      | undefined,
    dockerCompose?: DockerComposeService | undefined
  );
  setReconciler(reconciler: TargetRuntimeReconciler): void;
  reconcile(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    options?: {
      targetEnvironment?: Record<string, string>;
    }
  ): Promise<void>;
  prepareAvailabilityPlacement(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    allowedSources: string[]
  ): Promise<{
    networkName: string;
    connectorAlias: string;
    connectorAddress: string;
    environment: Record<string, string>;
  }>;
  bindingNetworkExists(binding: ManagedDatabaseBindingRow): Promise<boolean>;
  adoptAvailabilityPlacement(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    placementBindingId: string,
    credentials: ManagedDatabaseBindingCredentials,
    allowedSources: string[]
  ): Promise<{
    networkName: string;
    connectorAlias: string;
    connectorAddress: string;
    environment: Record<string, string>;
  }>;
  projectParentBindingToAvailabilityPlacement(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    placementBindingId: string,
    credentials: ManagedDatabaseBindingCredentials,
    allowedSources: string[]
  ): Promise<{
    networkName: string;
    connectorAlias: string;
    connectorAddress: string;
    environment: Record<string, string>;
  }>;
  cleanupSupersededRuntime(binding: ManagedDatabaseBindingRow): Promise<void>;
  private performReconciliation;
  private ensureHostListener;
  private validate;
  private networkState;
  private bindingTargetSources;
  private bindingTargetContainerNames;
  prepareNetworkRemoval(binding: ManagedDatabaseBindingRow): Promise<void>;
  apply(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    userId: string,
    options?: {
      replaceExistingEnvironment?: boolean;
      targetEnvironment?: Record<string, string>;
      forceDeploymentRollout?: boolean;
    }
  ): Promise<void>;
  remove(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials,
    userId: string,
    options?: {
      targetEnvironment?: Record<string, string>;
    }
  ): Promise<void>;
  private containerTargetSnapshot;
  private updateContainerEnvironment;
  private restoreAfterApplyFailure;
  private restoreAfterRemoveFailure;
  private runRollbackSteps;
  private withRollbackFailure;
  verifyValues(
    database: ManagedDatabaseRow,
    binding: ManagedDatabaseBindingRow,
    credentials: ManagedDatabaseBindingCredentials
  ): Promise<void>;
  private environmentValues;
  private persistEndpointAddress;
  private waitForConvergence;
  private waitForRuntimeState;
  private matchingDeploymentSecretValues;
  private removeDeploymentSecrets;
  private requireComposeService;
}
