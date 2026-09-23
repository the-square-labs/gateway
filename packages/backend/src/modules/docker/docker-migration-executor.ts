import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import type { DockerEnvironmentService } from './docker-environment.service.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import type { MigrationRow } from './docker-migration-runtime.js';
import type { DockerSecretService } from './docker-secret.service.js';
export class DockerMigrationExecutor {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _dispatch: DockerMigrationDispatchAdapter,
    _docker: DockerManagementService,
    _deployments: DockerDeploymentService,
    _environment: DockerEnvironmentService,
    _secrets: DockerSecretService,
    _crypto: CryptoService
  ) {}
  async execute(_row: MigrationRow): Promise<{
    progress?: Record<string, unknown>;
    verification?: Record<string, unknown>;
  }> {
    return commercialModuleUnavailable();
  }
  async rollback(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async restoreSourceRestartPolicy(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
}
