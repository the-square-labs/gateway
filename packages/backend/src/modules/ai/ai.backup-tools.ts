import { container } from '@/container.js';
import { hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  assertBackupOperationScopes,
  BackupPolicySchema,
  BackupRestoreSchema,
} from '@/modules/backups/backups.routes.js';
import { BackupService } from '@/modules/backups/backups.service.js';
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
export async function executeBackupTool(user: User, args: Record<string, unknown>) {
  const action = String(args.action ?? ''),
    id = String(args.databaseId ?? ''),
    policyId = String(args.policyId ?? ''),
    runId = String(args.runId ?? '');
  const scope = action.startsWith('list_')
    ? 'databases:backups:view'
    : action === 'restore'
      ? 'databases:backups:restore'
      : ['run', 'cancel'].includes(action)
        ? 'databases:backups:run'
        : 'databases:backups:manage';
  if (!hasScopeForResource(user.scopes, scope, id)) throw new AppError(403, 'FORBIDDEN', `Missing ${scope}`);
  const service = container.resolve(BackupService);
  const context = { get: () => user.scopes };
  if (action === 'list_policies') return service.listPolicies(id);
  if (action === 'list_runs') return service.listRuns(id);
  if (action === 'create_policy' || action === 'update_policy') {
    const input = BackupPolicySchema.parse(args.config);
    assertBackupOperationScopes(context, { ...input, purpose: 'write' });
    return action === 'create_policy'
      ? service.createPolicy(id, input, user.id)
      : service.updatePolicy(id, policyId, input, user.id);
  }
  if (action === 'run' || action === 'delete_policy') {
    const policy = (await service.listPolicies(id)).find((row) => row.id === policyId);
    if (!policy) throw new AppError(404, 'BACKUP_POLICY_NOT_FOUND', 'Backup policy not found');
    assertBackupOperationScopes(context, { ...policy, purpose: 'write' });
    return action === 'run' ? service.startBackup(id, policyId, user.id) : service.deletePolicy(id, policyId, user.id);
  }
  const run = (await service.listRuns(id)).find((row) => row.id === runId);
  if (!run) throw new AppError(404, 'BACKUP_RUN_NOT_FOUND', 'Backup run not found');
  if (action === 'cancel') {
    assertBackupOperationScopes(context, { ...run, purpose: run.direction === 'restore' ? 'read' : 'write' });
    return service.cancel(id, runId, user.id);
  }
  if (action === 'restore') {
    const input = BackupRestoreSchema.parse(args.config);
    assertBackupOperationScopes(context, { ...run, executorNodeId: input.executorNodeId, purpose: 'read' });
    if (
      input.newManagedDatabaseName &&
      !hasScopeForCreation(user.scopes, 'databases:create', null, input.executorNodeId)
    )
      throw new AppError(403, 'FORBIDDEN', 'Missing database creation authority');
    if (
      input.restoreTargetConnectionId &&
      (!hasScopeForResource(user.scopes, 'databases:backups:restore', input.restoreTargetConnectionId) ||
        !hasScopeForResource(user.scopes, 'databases:edit', input.restoreTargetConnectionId))
    )
      throw new AppError(403, 'FORBIDDEN', 'Missing target restore authority');
    return service.startRestore(id, runId, input, user.id);
  }
  throw new AppError(400, 'BACKUP_ACTION_INVALID', 'Unsupported backup operation');
}
