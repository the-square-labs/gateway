import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { databaseToolRuntime } from '@/modules/databases/database-tool-runtime.js';
import type { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import type { User } from '@/types.js';

export const DATABASE_TOOL_NAMES = new Set([
  'list_databases',
  'get_database_connection',
  'query_postgres_read',
  'execute_postgres_sql',
  'browse_redis_keys',
  'get_redis_key',
  'set_redis_key',
  'execute_redis_command',
  'manage_database_connection',
  'manage_postgres_data',
  'manage_redis_data',
]);

export interface DatabaseToolContext {
  databaseService: DatabaseConnectionService;
}

export async function executeDatabaseTool(
  context: DatabaseToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeDatabaseTool(context, user, toolName, args, databaseToolRuntime);
}
