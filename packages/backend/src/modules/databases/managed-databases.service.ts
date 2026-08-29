export {
  DEFAULT_MANAGED_REDIS_CONFIG,
  daemonCreateConfig,
  MANAGED_DATABASE_CATALOG,
  type ManagedDatabaseLogOptions,
  type ManagedDatabaseLogTarget,
  type ManagedDatabaseRuntimeStats,
  managedConnectionConfig,
} from './managed-databases.service.core.js';

import { ManagedDatabaseMutationService } from './managed-databases.service.mutations.js';

export class ManagedDatabaseService extends ManagedDatabaseMutationService {}
