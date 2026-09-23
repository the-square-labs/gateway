import type { DrizzleClient } from '@/db/client.js';
import type { DockerMigrationPhase, DockerMigrationStatus } from '@/db/schema/docker-migrations.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerManagementService } from './docker.service.js';
import type {
  DockerMigrationCreateInput,
  DockerMigrationPreflightInput,
  DockerMigrationResolveInput,
} from './docker-migration.schemas.js';
import type { DockerMigrationCoordinator } from './docker-migration-coordinator.js';
import type { DockerMigrationExecutor } from './docker-migration-executor.js';
import type { DockerMigrationPreflightService } from './docker-migration-preflight.js';
export class DockerMigrationService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _preflight: DockerMigrationPreflightService,
    _executor: DockerMigrationExecutor,
    _coordinator: DockerMigrationCoordinator,
    _audit: AuditService,
    _events: EventBusService,
    _docker: DockerManagementService,
    _auth: Pick<AuthService, 'getUserById'>
  ) {}
  start(): void {}
  async stop(): Promise<void> {}
  async preflightMigration(
    _input: DockerMigrationPreflightInput,
    _scopes: string[]
  ): Promise<{
    resourceType: 'container' | 'deployment';
    targetNodeId: string;
    sourceNodeId: string;
    resourceName: string;
    keepSource: boolean;
    sourceState: string;
    fingerprint: string;
    proxyHosts: {
      id: string;
      enabled: boolean;
      maintenanceAlreadyEnabled: boolean;
    }[];
    sourceResourceId: string;
    scopeResourceId: string;
    targetFolderId: string | null;
    targetNodeSlug: string;
    blockers: {
      message: string;
      code: string;
      resource?: string | undefined;
    }[];
    warnings: {
      message: string;
      code: string;
      resource?: string | undefined;
    }[];
    plannedChanges: string[];
    capacity: {
      requiredBytes: number;
      availableBytes: number | null;
      marginBytes: number;
      sufficient: boolean;
    };
    artifacts: {
      kind: 'image' | 'volume';
      sizeBytes: number | null;
      sourceIdentity: string;
      targetIdentity: string;
    }[];
    deletionPlan: {
      name: string;
      type: 'container' | 'deployment' | 'volume';
      sizeBytes?: number | undefined;
    }[];
    verificationPlan: string[];
    environmentKeyCount: number;
    secretKeyCount: number;
    dependencyPermissions?:
      | {
          volumes: {
            folderId: string | null;
            resourceId: string;
          }[];
          networks: {
            folderId: string | null;
            resourceId: string;
            targetResourceId: string | null;
            resourceKey: string;
          }[];
          proxyHostIds: string[];
        }
      | undefined;
  }> {
    return commercialModuleUnavailable();
  }
  async create(
    _input: DockerMigrationCreateInput,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    id: string;
    resourceType: import('@/db/schema/docker-migrations.js').DockerMigrationResourceType;
    resourceName: string;
    deploymentId: string | null;
    sourceNodeId: string;
    targetNodeId: string;
    targetNodeSlug: string | null;
    targetResourceId: string | null;
    keepSource: boolean;
    sourceState: string;
    status: DockerMigrationStatus;
    phase: DockerMigrationPhase;
    progress: import('@/db/schema/docker-migrations.js').DockerMigrationProgress;
    verification: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    cancellationRequestedAt: Date | null;
    cutoverAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async list(
    _scopes: string[],
    _filters: {
      status?: string;
      nodeId?: string;
      limit: number;
    }
  ): Promise<
    {
      id: string;
      resourceType: import('@/db/schema/docker-migrations.js').DockerMigrationResourceType;
      resourceName: string;
      deploymentId: string | null;
      sourceNodeId: string;
      targetNodeId: string;
      targetNodeSlug: string | null;
      targetResourceId: string | null;
      keepSource: boolean;
      sourceState: string;
      status: DockerMigrationStatus;
      phase: DockerMigrationPhase;
      progress: import('@/db/schema/docker-migrations.js').DockerMigrationProgress;
      verification: Record<string, unknown>;
      errorCode: string | null;
      errorMessage: string | null;
      cancellationRequestedAt: Date | null;
      cutoverAt: Date | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    }[]
  > {
    return [];
  }
  async get(
    _id: string,
    _scopes: string[]
  ): Promise<{
    preflight: Record<string, unknown>;
    artifacts: {
      id: string;
      migrationId: string;
      kind: 'image' | 'volume';
      sourceIdentity: string;
      targetIdentity: string;
      sizeBytes: number;
      transferredBytes: number;
      compression: string | null;
      artifactDigest: string | null;
      sourceManifestRoot: string | null;
      targetManifestRoot: string | null;
      entryCount: number | null;
      logicalBytes: number | null;
      state: string;
      errorCode: string | null;
      errorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[];
    id: string;
    resourceType: import('@/db/schema/docker-migrations.js').DockerMigrationResourceType;
    resourceName: string;
    deploymentId: string | null;
    sourceNodeId: string;
    targetNodeId: string;
    targetNodeSlug: string | null;
    targetResourceId: string | null;
    keepSource: boolean;
    sourceState: string;
    status: DockerMigrationStatus;
    phase: DockerMigrationPhase;
    progress: import('@/db/schema/docker-migrations.js').DockerMigrationProgress;
    verification: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    cancellationRequestedAt: Date | null;
    cutoverAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async cancel(
    _id: string,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    id: string;
    resourceType: import('@/db/schema/docker-migrations.js').DockerMigrationResourceType;
    resourceName: string;
    deploymentId: string | null;
    sourceNodeId: string;
    targetNodeId: string;
    targetNodeSlug: string | null;
    targetResourceId: string | null;
    keepSource: boolean;
    sourceState: string;
    status: DockerMigrationStatus;
    phase: DockerMigrationPhase;
    progress: import('@/db/schema/docker-migrations.js').DockerMigrationProgress;
    verification: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    cancellationRequestedAt: Date | null;
    cutoverAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async retryCleanup(
    _id: string,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    id: string;
    resourceType: import('@/db/schema/docker-migrations.js').DockerMigrationResourceType;
    resourceName: string;
    deploymentId: string | null;
    sourceNodeId: string;
    targetNodeId: string;
    targetNodeSlug: string | null;
    targetResourceId: string | null;
    keepSource: boolean;
    sourceState: string;
    status: DockerMigrationStatus;
    phase: DockerMigrationPhase;
    progress: import('@/db/schema/docker-migrations.js').DockerMigrationProgress;
    verification: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    cancellationRequestedAt: Date | null;
    cutoverAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async resolve(
    _id: string,
    _input: DockerMigrationResolveInput,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    id: string;
    resourceType: import('@/db/schema/docker-migrations.js').DockerMigrationResourceType;
    resourceName: string;
    deploymentId: string | null;
    sourceNodeId: string;
    targetNodeId: string;
    targetNodeSlug: string | null;
    targetResourceId: string | null;
    keepSource: boolean;
    sourceState: string;
    status: DockerMigrationStatus;
    phase: DockerMigrationPhase;
    progress: import('@/db/schema/docker-migrations.js').DockerMigrationProgress;
    verification: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    cancellationRequestedAt: Date | null;
    cutoverAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async recoverOnStartup(_now?: Date): Promise<number> {
    return 0;
  }
}
