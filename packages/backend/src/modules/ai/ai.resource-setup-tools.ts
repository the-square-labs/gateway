import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateManagedDatabaseBindingSchema,
  CreateManagedDatabaseSchema,
  DeleteManagedDatabaseBindingSchema,
  ManagedDatabaseListQuerySchema,
} from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import {
  DockerMigrationCreateInputSchema,
  DockerMigrationPreflightInputSchema,
} from '@/modules/docker/docker-migration.schemas.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import type { User } from '@/types.js';

export const RESOURCE_SETUP_TOOL_NAMES = new Set([
  'manage_managed_database',
  'manage_docker_migration',
  'manage_logging_backend',
]);

export async function executeResourceSetupTool(user: User, toolName: string, args: Record<string, unknown>) {
  if (toolName === 'manage_managed_database') return manageManagedDatabase(user, args);
  if (toolName === 'manage_docker_migration') return manageDockerMigration(user, args);
  if (toolName === 'manage_logging_backend') return manageLoggingBackend(user, args);
  throw new Error(`Unsupported resource setup tool: ${toolName}`);
}

async function manageManagedDatabase(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const service = container.resolve(ManagedDatabaseService);
  const bindings = container.resolve(ManagedDatabaseBindingService);

  if (operation === 'catalog') {
    ensureScope(user, 'databases:view');
    return service.listCatalog();
  }
  if (operation === 'list') {
    ensureScope(user, 'databases:view');
    return service.list(ManagedDatabaseListQuerySchema.parse({ nodeId: args.nodeId, type: args.type }));
  }
  if (operation === 'create') {
    ensureScope(user, 'databases:create');
    return service.create(CreateManagedDatabaseSchema.parse(args), user.id);
  }

  const databaseId = requiredString(args.databaseId);
  if (operation === 'get') {
    ensureScope(user, 'databases:view');
    return service.get(databaseId);
  }
  if (operation === 'retry') {
    ensureScope(user, 'databases:edit');
    return service.retryProvisioning(databaseId, user.id);
  }
  if (operation === 'delete') {
    ensureScope(user, 'databases:delete');
    return service.delete(databaseId, user.id);
  }
  if (operation === 'list_bindings') {
    ensureScope(user, 'databases:view');
    return bindings.list(databaseId);
  }
  if (operation === 'create_binding') {
    ensureScope(user, 'databases:edit');
    const input = CreateManagedDatabaseBindingSchema.parse(args);
    ensureBindingTargetScopes(user, input);
    return bindings.create(databaseId, input, user.id);
  }
  if (operation === 'delete_binding') {
    ensureScope(user, 'databases:delete');
    const bindingId = requiredString(args.bindingId);
    ensureBindingTargetScopes(user, await bindings.getTarget(databaseId, bindingId));
    return bindings.delete(databaseId, bindingId, user.id, DeleteManagedDatabaseBindingSchema.parse(args));
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported managed database operation: ${operation}`);
}

async function manageDockerMigration(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const service = container.resolve(DockerMigrationService);
  if (operation === 'preflight') {
    ensureScope(user, 'docker:containers:migrate');
    return service.preflightMigration(DockerMigrationPreflightInputSchema.parse(args), user.scopes);
  }
  if (operation === 'start') {
    ensureScope(user, 'docker:containers:migrate');
    return service.create(DockerMigrationCreateInputSchema.parse(args), user.id, user.scopes);
  }
  const migrationId = requiredString(args.migrationId);
  if (operation === 'get') {
    ensureScope(user, 'docker:tasks');
    return service.get(migrationId, user.scopes);
  }
  if (operation === 'cancel') {
    ensureScope(user, 'docker:tasks:manage');
    return service.cancel(migrationId, user.id, user.scopes);
  }
  if (operation === 'retry_cleanup') {
    ensureScope(user, 'docker:tasks:manage');
    return service.retryCleanup(migrationId, user.id, user.scopes);
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Docker migration operation: ${operation}`);
}

async function manageLoggingBackend(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  if (operation === 'get') {
    ensureScope(user, 'settings:gateway:view');
    return container.resolve(LoggingSettingsService).getPublicConfig();
  }
  ensureScope(user, 'settings:gateway:edit');
  const runtime = container.resolve(LoggingRuntimeService);
  if (operation === 'enable_local') return runtime.update({ mode: 'local' });
  if (operation === 'configure_external') {
    return runtime.update({
      mode: 'external',
      url: requiredString(args.url),
      username: requiredString(args.username),
      password: requiredString(args.password),
      database: optionalString(args.database),
      table: optionalString(args.table),
      requestTimeoutMs: optionalNumber(args.requestTimeoutMs),
    });
  }
  if (operation === 'disable') return runtime.update({ mode: 'disabled' });
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported logging backend operation: ${operation}`);
}

function ensureBindingTargetScopes(
  user: User,
  target: { targetType: 'container' | 'deployment'; targetNodeId: string; targetResourceId: string }
) {
  const scopes =
    target.targetType === 'deployment'
      ? ['docker:containers:edit', 'docker:containers:manage', 'docker:containers:secrets']
      : ['docker:containers:environment', 'docker:containers:secrets'];
  for (const scope of scopes) ensureScope(user, scope);
}

function ensureScope(user: User, scope: string) {
  if (!hasScope(user.scopes, scope)) throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
