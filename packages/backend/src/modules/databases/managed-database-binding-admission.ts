import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedDatabaseBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { isGatewayInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { CreateManagedDatabaseBindingInput } from './databases.schemas.js';

type ManagedDatabaseBindingRow = typeof managedDatabaseBindings.$inferSelect;

function assertUserTarget(inspect: Record<string, any> | null | undefined): void {
  if (inspect && isGatewayInternalContainer(inspect)) {
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  }
}

export class ManagedDatabaseBindingAdmission {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerManagement: DockerManagementService,
    private readonly dockerDeployments: DockerDeploymentService,
    private readonly dockerSecrets: DockerSecretService,
    private readonly dockerCompose?: DockerComposeService
  ) {}

  async resolveTarget(input: CreateManagedDatabaseBindingInput): Promise<string> {
    if (input.targetType === 'compose_service') {
      const target = await this.requireCompose().resolveServiceTarget(input.targetNodeId, input.targetResourceId, true);
      return target.targetResourceId;
    }
    if (input.targetType === 'deployment') {
      await this.dockerDeployments.get(input.targetNodeId, input.targetResourceId);
      return input.targetResourceId;
    }
    const inspect = await this.dockerManagement.inspectContainer(input.targetNodeId, input.targetResourceId);
    assertUserTarget(inspect);
    const labels = (inspect?.Config?.Labels ?? {}) as Record<string, string>;
    if (labels['wiolett.gateway.deployment.managed'] === 'true') {
      throw new AppError(409, 'MANAGED_DEPLOYMENT_CONTAINER', 'Use a deployment target for a blue/green container');
    }
    if (labels['wiolett.gateway.managed-database.connector'] === 'true') {
      throw new AppError(
        409,
        'MANAGED_DATABASE_CONNECTOR_TARGET',
        'A managed database connector cannot be a binding target'
      );
    }
    const name = typeof inspect?.Name === 'string' ? inspect.Name.replace(/^\/+/, '') : '';
    if (!name) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
    return name;
  }

  async assertEnvironmentNamesAvailable(
    targetNodeId: string,
    targetType: ManagedDatabaseBindingRow['targetType'],
    targetResourceId: string,
    environment: ManagedDatabaseBindingRow['environment'],
    replaceExistingEnvironment = false
  ) {
    const requested = new Set(Object.values(environment).filter((value): value is string => Boolean(value)));
    if (requested.size === 0) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_BINDING_ENV_REQUIRED',
        'At least one application environment variable is required'
      );
    }
    const rows = await this.db
      .select({ environment: managedDatabaseBindings.environment })
      .from(managedDatabaseBindings)
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, targetNodeId),
          eq(managedDatabaseBindings.targetType, targetType),
          eq(managedDatabaseBindings.targetResourceId, targetResourceId)
        )
      );
    for (const row of rows) {
      if (Object.values(row.environment).some((name) => name && requested.has(name))) {
        throw new AppError(
          409,
          'MANAGED_DATABASE_BINDING_ENV_CONFLICT',
          'A managed database binding already uses an environment variable'
        );
      }
    }

    if (targetType === 'deployment') {
      const deployment = await this.dockerDeployments.get(targetNodeId, targetResourceId);
      const secretKeys = await this.dockerSecrets.getSecretKeys(targetNodeId, `deployment:${targetResourceId}`);
      const existing = new Set([...Object.keys(deployment.desiredConfig.env ?? {}), ...secretKeys]);
      if ([...requested].some((name) => existing.has(name))) {
        throw new AppError(409, 'MANAGED_DATABASE_BINDING_ENV_CONFLICT', 'The deployment already uses an environment variable');
      }
      return;
    }

    if (targetType === 'compose_service') {
      const existing = await this.requireCompose().getServiceEnvironmentNames(targetNodeId, targetResourceId);
      if ([...requested].some((name) => existing.has(name))) {
        throw new AppError(409, 'MANAGED_DATABASE_BINDING_ENV_CONFLICT', 'The Compose service already uses an environment variable');
      }
      return;
    }

    const inspect = await this.dockerManagement.inspectContainer(targetNodeId, targetResourceId);
    assertUserTarget(inspect);
    const name = typeof inspect?.Name === 'string' ? inspect.Name.replace(/^\/+/, '') : '';
    const envKeys = new Set(
      (Array.isArray(inspect?.Config?.Env) ? (inspect.Config.Env as unknown[]) : [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.split('=', 1)[0]!)
    );
    if (name) {
      for (const key of await this.dockerSecrets.getSecretKeys(targetNodeId, name)) envKeys.add(key);
    }
    if ([...requested].some((key) => envKeys.has(key)) && !(targetType === 'container' && replaceExistingEnvironment)) {
      throw new AppError(409, 'MANAGED_DATABASE_BINDING_ENV_CONFLICT', 'The container already uses an environment variable');
    }
  }

  private requireCompose() {
    if (!this.dockerCompose) {
      throw new AppError(503, 'COMPOSE_SERVICE_UNAVAILABLE', 'Compose service integration is unavailable');
    }
    return this.dockerCompose;
  }
}
