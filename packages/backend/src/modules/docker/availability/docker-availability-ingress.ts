import type { DrizzleClient } from '@/db/client.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type {
  DockerAvailabilityDependencyProjector,
  DockerAvailabilityPreparedDependencies,
} from './docker-availability.adapters.js';
import type {
  DockerAvailabilityAdapterContext,
  DockerAvailabilityAdapterPreflight,
  DockerAvailabilityCandidateNode,
  DockerAvailabilityPlacementResult,
  DockerAvailabilityResolvedResource,
} from './docker-availability.types.js';
export declare class DockerAvailabilityIngressProjector implements DockerAvailabilityDependencyProjector {
  private readonly db;
  private readonly nodes;
  private readonly docker;
  private readonly secureLinks;
  private readonly proxy;
  constructor(
    db: DrizzleClient,
    nodes: NodeRegistryService,
    docker: DockerManagementService,
    secureLinks: ProxySecureLinkService,
    proxy: ProxyService
  );
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  prepare(): Promise<DockerAvailabilityPreparedDependencies>;
  reconcileHost(hostId: string): Promise<boolean>;
  activate(context: DockerAvailabilityAdapterContext, result: DockerAvailabilityPlacementResult): Promise<void>;
  deactivate(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivateUnavailable(context: DockerAvailabilityAdapterContext): Promise<void>;
  cleanup(context: DockerAvailabilityAdapterContext): Promise<void>;
  prepareFinalAdoption(context: DockerAvailabilityAdapterContext): Promise<void>;
  finalizeAdoption(context: DockerAvailabilityAdapterContext): Promise<void>;
  private reconcileHostAndDrain;
  private hosts;
  private routes;
  private links;
  private target;
  private assertTarget;
}
//# sourceMappingURL=docker-availability-ingress.d.ts.map
