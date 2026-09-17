import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { DockerRegistryTokenService } from '@/modules/docker/docker-registry-token.service.js';
import type { PagePublicationService } from '../tags/page-publication.service.js';
import type { PageDeploymentService } from './page-deployment.service.js';
export class PageBuildRolloutService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _tokens: DockerRegistryTokenService,
    _deployments: PageDeploymentService,
    _publication: PagePublicationService,
    _registryUrl?: string
  ) {}
  async rollout(_buildId: string): Promise<'deployed' | 'superseded'> {
    return commercialModuleUnavailable();
  }
}
