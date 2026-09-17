import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { backupRuntime } from '@/modules/backups/backup-runtime.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';
export const BACKUP_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_database_backups',
    category: 'Databases',
    requiredScope: 'databases:backups:view',
    destructive: true,
    invalidateStores: [],
    description:
      'List native backup policies/history, manage policies, run or cancel a backup, and restore a verified artifact into an empty target. Runtime addresses and credentials are resolved by Gateway.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_policies',
            'list_runs',
            'create_policy',
            'update_policy',
            'delete_policy',
            'run',
            'cancel',
            'restore',
          ],
        },
        databaseId: { type: 'string' },
        policyId: { type: 'string' },
        runId: { type: 'string' },
        config: { type: 'object', additionalProperties: true },
      },
      required: ['action', 'databaseId'],
    },
  },
];
export async function executeBackupTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeBackupTool(user, args, backupRuntime);
}
