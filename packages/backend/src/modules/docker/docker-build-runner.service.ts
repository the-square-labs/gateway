import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerBuildService } from './docker-build.service.js';
import type { DockerSourceService } from './docker-source.service.js';
export class DockerBuildRunnerService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _builds: DockerBuildService,
    _dispatch: NodeDispatchService,
    _integrations: IntegrationsService,
    _registry: RelayRegistryService
  ) {}
  setSourceService(_sources: DockerSourceService): void {}
  async assertBuildAdmission(): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcile(): Promise<void> {}
}
