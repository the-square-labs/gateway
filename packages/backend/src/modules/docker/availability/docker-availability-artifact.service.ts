import type { DrizzleClient } from '@/db/client.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type {
  DockerAvailabilityCandidateNode,
  DockerAvailabilityResolvedResource,
} from './docker-availability.types.js';

interface DeletedArtifactReference {
  ownerKind: 'build' | 'availability';
  registryRepository: string;
  digest: string;
}
export declare function availabilityArtifactIsReferenced(
  repository: string,
  references: unknown,
  digest?: string
): boolean;
export declare function deletedDockerArtifactReferences(
  image: Record<string, any>,
  artifacts: DeletedArtifactReference[],
  runtimeReferences: unknown
): string[];
export declare class DockerAvailabilityArtifactService {
  private readonly db;
  private readonly registry;
  private readonly relayRegistry;
  private readonly dispatch;
  private collecting;
  constructor(
    db: DrizzleClient,
    registry: DockerInternalRegistryService,
    relayRegistry: RelayRegistryService,
    dispatch: NodeDispatchService
  );
  releaseObsoletePins(policyId: string): Promise<void>;
  collectUnusedArtifacts(): Promise<void>;
  preflight(resource: DockerAvailabilityResolvedResource): Promise<void>;
  prepare(input: {
    policyId: string;
    generation: number;
    resource: DockerAvailabilityResolvedResource;
    candidateNodes: DockerAvailabilityCandidateNode[];
    reuseExistingArtifacts?: boolean;
  }): Promise<DockerAvailabilityResolvedResource>;
  private findReusableArtifact;
  private mirrorImage;
  cleanup(policyId: string): Promise<void>;
  resolveCanonicalSourceImage(
    nodeId: string,
    candidate: string,
    internalReference?: string | null
  ): Promise<string | null>;
  private resourceImages;
  private rewriteResource;
  private withFingerprint;
  private parseMirrorDetail;
  private recordArtifact;
  private ensurePin;
  private rotatePins;
  private pinOwner;
}
//# sourceMappingURL=docker-availability-artifact.service.d.ts.map
