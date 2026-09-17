import { DockerMigrationService } from './docker-migration.service.js';
import { DockerMigrationCoordinator } from './docker-migration-coordinator.js';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import { DockerMigrationExecutor } from './docker-migration-executor.js';
import { DockerMigrationPreflightService } from './docker-migration-preflight.js';

const constructors = {
  DockerMigrationService,
  DockerMigrationPreflightService,
  DockerMigrationCoordinator,
  DockerMigrationExecutor,
  DockerMigrationDispatchAdapter,
};
export type DockerMigrationConstructors = typeof constructors;

import { and, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import {
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerContainerFolderAssignments,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerEnvVars,
  dockerHealthChecks,
  dockerImageCleanupSettings,
  dockerMigrationArtifacts,
  dockerMigrationNodeLocks,
  dockerMigrations,
  dockerRuntimeSettings,
  dockerSecrets,
  dockerSourceBindings,
  dockerWebhooks,
  nodes,
  proxyHosts,
} from '@/db/schema/index.js';
import { migrationTransferRelay } from '@/grpc/services/migration-transfer.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  DockerWorkloadResolverService,
  matchRuntimeIdentity,
} from '@/modules/docker/availability/docker-workload-resolver.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { assertDockerCreationAccess, placeCreatedDockerResource } from '@/modules/docker/docker-creation-access.js';
import { dockerGpuAttachmentFromInspect } from '@/modules/docker/docker-gpu-attachment.js';
import { DockerMigrationCreateInputSchema } from '@/modules/docker/docker-migration.schemas.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { waitForShutdownTasks } from '@/services/shutdown-coordinator.service.js';

const loggerDockerMigrationService = createChildLogger('DockerMigrationService');
export const dockerMigrationCommercialRuntime = {
  constructors,
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  dockerMigrationArtifacts,
  dockerMigrationNodeLocks,
  dockerMigrations,
  createChildLogger,
  AppError,
  assertDockerCreationAccess,
  placeCreatedDockerResource,
  dockerContainerFolderAssignments,
  dockerDeployments,
  dockerEnvVars,
  dockerSecrets,
  nodes,
  proxyHosts,
  requireConfiguredLicensePolicy,
  dockerGpuAttachmentFromInspect,
  dockerDeploymentSlots,
  dockerHealthChecks,
  dockerImageCleanupSettings,
  dockerRuntimeSettings,
  dockerSourceBindings,
  dockerWebhooks,
  migrationTransferRelay: migrationTransferRelay as Pick<
    typeof migrationTransferRelay,
    'readArtifact' | 'writeArtifact' | 'relayArtifact'
  >,
  ne,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  DockerWorkloadResolverService,
  matchRuntimeIdentity,
  hasScope,
  hasScopeForCreation,
  hasScopeForResource,
  hasDockerResourceScope,
  DockerMigrationCreateInputSchema,
  CryptoService,
  waitForShutdownTasks,
  loggerDockerMigrationService,
};
