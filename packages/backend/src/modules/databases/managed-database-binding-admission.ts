import type { DrizzleClient } from '@/db/client.js';
import type { managedDatabaseBindings } from '@/db/schema/index.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { CreateManagedDatabaseBindingInput } from './databases.schemas.js';

type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;
export declare class ManagedDatabaseBindingAdmission {
  private readonly db;
  private readonly dockerManagement;
  private readonly dockerDeployments;
  private readonly dockerSecrets;
  private readonly dockerCompose?;
  constructor(
    db: DrizzleClient,
    dockerManagement: DockerManagementService,
    dockerDeployments: DockerDeploymentService,
    dockerSecrets: DockerSecretService,
    dockerCompose?: DockerComposeService | undefined
  );
  resolveTarget(input: CreateManagedDatabaseBindingInput): Promise<string>;
  assertEnvironmentNamesAvailable(
    targetNodeId: string,
    targetType: ManagedDatabaseBindingRow['targetType'],
    targetResourceId: string,
    environment: ManagedDatabaseBindingRow['environment'],
    replaceExistingEnvironment?: boolean,
    targetEnvironment?: Record<string, string>
  ): Promise<void>;
  private requireCompose;
}
