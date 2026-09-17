import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import type { DockerMigrationPreflight, DockerMigrationPreflightInput } from './docker-migration.schemas.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
export class DockerMigrationPreflightService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _docker: DockerManagementService,
    _deployments: DockerDeploymentService,
    _dispatch: DockerMigrationDispatchAdapter
  ) {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async run(
    _input: DockerMigrationPreflightInput,
    _scopes: string[],
    _enforcePermissions?: boolean
  ): Promise<DockerMigrationPreflight> {
    return commercialModuleUnavailable();
  }
}
