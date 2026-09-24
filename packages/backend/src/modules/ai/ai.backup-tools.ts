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
      'List native backup policies/history, manage policies (config: destinationId, bucket, prefix, optional staging target, executorNodeId, schedule, timezone, retentionCount, limits, enabled), run or cancel a backup or restore run (config.force ends a run whose executor cannot confirm), restore a verified artifact into an empty target (config: executorNodeId plus newManagedDatabaseName or restoreTargetConnectionId, optional targetDatabaseName and limits), and delete_run to remove retired backup history. Runtime addresses and credentials are resolved by Gateway.',
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
            'delete_run',
          ],
        },
        databaseId: { type: 'string' },
        policyId: { type: 'string' },
        runId: { type: 'string' },
        config: {
          type: 'object',
          description: 'Policy body for create/update_policy, restore body for restore, { force } for cancel.',
          properties: {
            destinationId: { type: 'string' },
            bucket: { type: 'string' },
            prefix: { type: 'string' },
            stagingStorageConnectionId: { type: ['string', 'null'] },
            stagingBucket: { type: ['string', 'null'] },
            executorNodeId: { type: 'string' },
            schedule: { type: ['string', 'null'], description: 'Cron expression; null for manual runs only.' },
            timezone: { type: 'string' },
            retentionCount: { type: 'number' },
            limits: {
              type: 'object',
              properties: {
                workspaceBytes: { type: 'number' },
                timeoutSeconds: { type: 'number' },
                cpuCores: { type: 'number' },
                memoryMb: { type: 'number' },
              },
              additionalProperties: false,
            },
            enabled: { type: 'boolean' },
            newManagedDatabaseName: { type: 'string' },
            targetDatabaseName: { type: 'string', description: 'Database name inside the restore target.' },
            restoreTargetConnectionId: { type: 'string' },
            overwrite: { type: 'boolean', enum: [false] },
            force: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['action', 'databaseId'],
      additionalProperties: false,
    },
  },
];
export async function executeBackupTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeBackupTool(user, args, backupRuntime);
}
