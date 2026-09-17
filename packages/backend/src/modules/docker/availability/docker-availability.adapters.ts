import type { DrizzleClient } from '@/db/client.js';
import type { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type {
  DockerAvailabilityAdapter,
  DockerAvailabilityAdapterContext,
  DockerAvailabilityAdapterPreflight,
  DockerAvailabilityCandidateNode,
  DockerAvailabilityPlacementResult,
  DockerAvailabilityResolvedResource,
  DockerAvailabilityResource,
} from './docker-availability.types.js';

type AvailabilityDaemonState = {
  policyId?: string;
  placementId?: string;
  resourceKind?: string;
  resourceId?: string;
  generation?: number | string;
  highestGeneration?: number | string;
  state?: string;
  runtimeIdentity?: Record<string, unknown>;
  operationId?: string;
  lastIdempotencyKey?: string;
};
export interface DockerAvailabilityDependencyProjector {
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  prepare(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPreparedDependencies>;
  activate?(context: DockerAvailabilityAdapterContext, result: DockerAvailabilityPlacementResult): Promise<void>;
  deactivateUnavailable?(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivate?(context: DockerAvailabilityAdapterContext): Promise<void>;
  adopt?(context: DockerAvailabilityAdapterContext): Promise<void>;
  prepareFinalAdoption?(context: DockerAvailabilityAdapterContext): Promise<void>;
  finalizeAdoption?(context: DockerAvailabilityAdapterContext): Promise<void>;
  cleanup(context: DockerAvailabilityAdapterContext): Promise<void>;
}
export interface DockerAvailabilityPreparedDependencies {
  environment: Record<string, string>;
  networkNames: string[];
  extraHosts: Record<string, string>;
  composeYaml?: string;
  composeSecrets?: Record<string, string>;
}
export declare class CompositeDockerAvailabilityProjector implements DockerAvailabilityDependencyProjector {
  private readonly projectors;
  constructor(projectors: DockerAvailabilityDependencyProjector[]);
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<{
    blockers: import('./docker-availability.types.js').DockerAvailabilityIssue[];
    warnings: import('./docker-availability.types.js').DockerAvailabilityIssue[];
  }>;
  prepare(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPreparedDependencies>;
  activate(context: DockerAvailabilityAdapterContext, result: DockerAvailabilityPlacementResult): Promise<void>;
  deactivate(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivateUnavailable(context: DockerAvailabilityAdapterContext): Promise<void>;
  adopt(context: DockerAvailabilityAdapterContext): Promise<void>;
  prepareFinalAdoption(context: DockerAvailabilityAdapterContext): Promise<void>;
  finalizeAdoption(context: DockerAvailabilityAdapterContext): Promise<void>;
  cleanup(context: DockerAvailabilityAdapterContext): Promise<void>;
}
export declare class ManagedDatabaseAvailabilityProjector implements DockerAvailabilityDependencyProjector {
  private readonly bindings;
  private readonly nodeRegistry;
  constructor(bindings: ManagedDatabaseBindingService, nodeRegistry: NodeRegistryService);
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  prepare(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPreparedDependencies>;
  cleanup(context: DockerAvailabilityAdapterContext): Promise<void>;
  adopt(context: DockerAvailabilityAdapterContext): Promise<void>;
}
export declare function canonicalComposeSourceImage(
  images: Array<Record<string, unknown>>,
  ...candidates: Array<string | null | undefined>
): string | null;
export declare function rewriteComposeSourceImages(yaml: string, images: Record<string, string>): string;
export declare function composeSourceImages(yaml: string): Record<string, string>;
export declare function availabilityPlacementOwner(inspect: Record<string, any>): {
  policyId: string;
  placementId: string;
};
export declare function availabilityPlacementGeneration(inspect: Record<string, any>): number | null;
export declare function isReplaceableStalePlacementContainer(
  inspect: Record<string, any>,
  context: Pick<DockerAvailabilityAdapterContext, 'policyId' | 'placementId' | 'generation'>
): boolean;
export declare function availabilityContainerRuntimeSpec(spec: Record<string, any>): Record<string, any>;
export declare function availabilityPlacementSpecFingerprint(inspect: Record<string, any>): string;
export declare function placementContainerHasFailedRuntime(inspect: Record<string, any>): boolean;
export declare function availabilityPlacementLabels(
  context: Pick<DockerAvailabilityAdapterContext, 'policyId' | 'placementId' | 'generation' | 'nodeId' | 'resource'>,
  labels: unknown
): Record<string, string>;
export declare function deploymentPlacementSnapshot(
  spec: Record<string, any>,
  runtime: {
    deploymentId: string;
    routerName: string;
    networkName: string;
    slots: {
      blue: string;
      green: string;
    };
  },
  desiredConfig: Record<string, any>,
  observed: Record<string, any>,
  priorRuntimeIdentity?: Record<string, unknown>
): {
  id: string;
  routerName: string;
  routerImage: string;
  networkName: string;
  activeSlot: 'blue' | 'green';
  routes: any;
  healthConfig: any;
  desiredConfig: Record<string, any>;
  slots: {
    slot: 'blue' | 'green';
    containerName: string;
  }[];
};
declare abstract class BaseAvailabilityAdapter {
  protected readonly db: DrizzleClient;
  protected readonly dispatch: NodeDispatchService;
  protected readonly projector: DockerAvailabilityDependencyProjector;
  constructor(db: DrizzleClient, dispatch: NodeDispatchService, projector?: DockerAvailabilityDependencyProjector);
  refreshPlacementDependencies(
    context: DockerAvailabilityAdapterContext,
    result: DockerAvailabilityPlacementResult
  ): Promise<void>;
  protected daemon(
    context: DockerAvailabilityAdapterContext,
    action: 'prepare' | 'activate' | 'inspect' | 'stop' | 'drain' | 'remove' | 'adopt_single',
    config?: Record<string, unknown>
  ): Promise<AvailabilityDaemonState>;
  protected inspectOptional(context: DockerAvailabilityAdapterContext): Promise<AvailabilityDaemonState>;
  protected claimGeneration(context: DockerAvailabilityAdapterContext): Promise<void>;
  protected fence(context: DockerAvailabilityAdapterContext): Promise<void>;
  protected claimAndFence(context: DockerAvailabilityAdapterContext): Promise<void>;
  private assertAvailabilityMutationContext;
  private assertOperationLease;
  protected result(
    context: DockerAvailabilityAdapterContext,
    daemon: AvailabilityDaemonState,
    runtimeIdentity: Record<string, unknown>,
    imageReference?: string,
    composeRevisionId?: string
  ): DockerAvailabilityPlacementResult;
  protected stoppedResult(
    context: DockerAvailabilityAdapterContext,
    daemon: AvailabilityDaemonState,
    runtimeIdentity: Record<string, unknown>,
    imageReference?: string,
    composeRevisionId?: string
  ): DockerAvailabilityPlacementResult;
  protected activateResult(
    context: DockerAvailabilityAdapterContext,
    result: DockerAvailabilityPlacementResult
  ): Promise<DockerAvailabilityPlacementResult>;
  deactivatePlacement(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivatePlacementDependencies(context: DockerAvailabilityAdapterContext): Promise<void>;
  finalizePlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void>;
  protected combinedPreflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    blockers: DockerAvailabilityAdapterPreflight['blockers'],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  inspectPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult | null>;
}
export declare class DockerContainerAvailabilityAdapter
  extends BaseAvailabilityAdapter
  implements DockerAvailabilityAdapter
{
  private readonly docker;
  private readonly environment;
  private readonly secrets;
  readonly kind: 'container';
  constructor(
    db: DrizzleClient,
    dispatch: NodeDispatchService,
    docker: DockerManagementService,
    environment: DockerEnvironmentService,
    secrets: DockerSecretService,
    projector?: DockerAvailabilityDependencyProjector
  );
  resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource>;
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  private waitUntilReady;
  private inspectPlacementContainer;
  private waitUntilStopped;
  startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void>;
  removePlacement(context: DockerAvailabilityAdapterContext): Promise<void>;
  adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void>;
}
export declare class DockerDeploymentAvailabilityAdapter
  extends BaseAvailabilityAdapter
  implements DockerAvailabilityAdapter
{
  private readonly secrets;
  readonly kind: 'deployment';
  constructor(
    db: DrizzleClient,
    dispatch: NodeDispatchService,
    secrets: DockerSecretService,
    projector?: DockerAvailabilityDependencyProjector
  );
  resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource>;
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  private runtime;
  private removeRuntime;
  ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  private activeSlotMatchesDesired;
  private verifyRuntimeOwnership;
  private runtimeOwnershipIsValid;
  private runtimeHasForeignCollision;
  private runtimeRemovalOwnershipIsValid;
  private originRuntimeRowIsSafelyRemovable;
  private staleRuntimeRowIsSafelyRemovable;
  private legacyRuntimeRowIsSafelyRemovable;
  private runtimeRowIdentityIsValid;
  drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void>;
  stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  removePlacement(context: DockerAvailabilityAdapterContext): Promise<void>;
  adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void>;
}
export declare class DockerComposeAvailabilityAdapter
  extends BaseAvailabilityAdapter
  implements DockerAvailabilityAdapter
{
  private readonly secrets;
  readonly kind: 'compose';
  constructor(
    db: DrizzleClient,
    dispatch: NodeDispatchService,
    secrets: DockerSecretService,
    projector?: DockerAvailabilityDependencyProjector
  );
  resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource>;
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  private listRuntimeContainers;
  private runtimeIdentity;
  private composeRuntimeHasForeignCollision;
  private composeRuntimeOwnershipIsValid;
  private composeRuntimeIsSafelyRemovable;
  ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  private waitUntilReady;
  drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void>;
  stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  private setPlacementRunning;
  removePlacement(context: DockerAvailabilityAdapterContext): Promise<void>;
  adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void>;
}
//# sourceMappingURL=docker-availability.adapters.d.ts.map
