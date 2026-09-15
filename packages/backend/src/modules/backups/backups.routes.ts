import { OpenAPIHono, z } from '@hono/zod-openapi';
import { container } from '@/container.js';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  openApiValidationHook,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { BackupService } from './backups.service.js';

const BackupLimitsSchema = z.object({
  workspaceBytes: z.number().int(),
  timeoutSeconds: z.number().int(),
  cpuCores: z.number().int(),
  memoryMb: z.number().int(),
});
export const BackupPolicySchema = z.object({
  destinationId: z.string().uuid(),
  bucket: z.string().trim().min(3).max(255),
  prefix: z.string().trim().max(1024),
  stagingStorageConnectionId: z.string().uuid().nullable().optional(),
  stagingBucket: z.string().trim().min(3).max(255).nullable().optional(),
  executorNodeId: z.string().uuid(),
  schedule: z.string().nullable().optional(),
  timezone: z.string().trim().min(1).max(64),
  retentionCount: z.number().int(),
  limits: BackupLimitsSchema,
  enabled: z.boolean().optional(),
});
export const BackupRestoreSchema = z.object({
  executorNodeId: z.string().uuid(),
  newManagedDatabaseName: z.string().trim().min(1).max(96).optional(),
  restoreTargetConnectionId: z.string().uuid().optional(),
  overwrite: z.literal(false).optional(),
  limits: BackupLimitsSchema.partial().optional(),
});
const RunParamSchema = IdParamSchema.extend({ runId: z.string().uuid() });

const listPoliciesRoute = appRoute({
  method: 'get',
  path: '/databases/{id}/backups/policies',
  tags: ['Database backups'],
  summary: 'List database backup policies',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
const createPolicyRoute = appRoute({
  method: 'post',
  path: '/databases/{id}/backups/policies',
  tags: ['Database backups'],
  summary: 'Create database backup policy',
  request: { params: IdParamSchema, ...jsonBody(BackupPolicySchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
const updatePolicyRoute = appRoute({
  method: 'put',
  path: '/databases/{id}/backups/policies/{policyId}',
  tags: ['Database backups'],
  summary: 'Update or disable a database backup policy',
  request: { params: IdParamSchema.extend({ policyId: z.string().uuid() }), ...jsonBody(BackupPolicySchema) },
  responses: okJson(UnknownDataResponseSchema),
});
const deletePolicyRoute = appRoute({
  method: 'delete',
  path: '/databases/{id}/backups/policies/{policyId}',
  tags: ['Database backups'],
  summary: 'Delete a database backup policy',
  request: { params: IdParamSchema.extend({ policyId: z.string().uuid() }) },
  responses: okJson(z.object({ success: z.boolean() })),
});
const listRunsRoute = appRoute({
  method: 'get',
  path: '/databases/{id}/backups/runs',
  tags: ['Database backups'],
  summary: 'List database backup runs',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
const startRunRoute = appRoute({
  method: 'post',
  path: '/databases/{id}/backups/policies/{policyId}/runs',
  tags: ['Database backups'],
  summary: 'Queue database backup',
  request: { params: IdParamSchema.extend({ policyId: z.string().uuid() }) },
  responses: createdJson(UnknownDataResponseSchema),
});
const restoreRoute = appRoute({
  method: 'post',
  path: '/databases/{id}/backups/runs/{runId}/restore',
  tags: ['Database backups'],
  summary: 'Queue restore to a new target',
  request: { params: RunParamSchema, ...jsonBody(BackupRestoreSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
const cancelRoute = appRoute({
  method: 'post',
  path: '/databases/{id}/backups/runs/{runId}/cancel',
  tags: ['Database backups'],
  summary: 'Cancel database backup run',
  request: { params: RunParamSchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

/** BackupService rechecks source, destination, and executor authority for every operation. */
export const backupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
// This router is mounted at /api: a wildcard here would intercept unrelated
// MCP, webhook, logging-ingest and Pages-deploy authentication.
backupRoutes.use('/databases/:id/backups/*', authMiddleware);
export function assertBackupOperationScopes(
  c: any,
  input: {
    destinationId?: string;
    stagingStorageConnectionId?: string | null;
    executorNodeId: string;
    purpose: 'read' | 'write';
  }
) {
  const scopes = c.get('effectiveScopes') ?? [];
  const requiredStorage =
    input.purpose === 'read'
      ? ['storage:objects:read', 'storage:credentials:reveal']
      : ['storage:objects:write', 'storage:credentials:reveal'];
  for (const scope of requiredStorage) {
    if (input.destinationId && !hasScopeForResource(scopes, scope, input.destinationId))
      throw new AppError(403, 'FORBIDDEN', `Missing ${scope} for backup storage target`);
    const stagingScope = scope === 'storage:objects:read' ? 'storage:objects:write' : scope;
    if (
      input.stagingStorageConnectionId &&
      !hasScopeForResource(scopes, stagingScope, input.stagingStorageConnectionId)
    )
      throw new AppError(403, 'FORBIDDEN', `Missing ${scope} for backup staging target`);
  }
  if (!hasScopeForResource(scopes, 'nodes:backups:execute', input.executorNodeId))
    throw new AppError(403, 'FORBIDDEN', 'Missing nodes:backups:execute for selected Storage node');
}
backupRoutes.openapi(
  { ...listPoliciesRoute, middleware: requireScopeForResource('databases:backups:view', 'id') },
  async (c) => c.json({ data: await container.resolve(BackupService).listPolicies(c.req.param('id')!) })
);
backupRoutes.openapi(
  { ...updatePolicyRoute, middleware: requireScopeForResource('databases:backups:manage', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const input = BackupPolicySchema.parse(await c.req.json());
    assertBackupOperationScopes(c, {
      destinationId: input.destinationId,
      stagingStorageConnectionId: input.stagingStorageConnectionId,
      executorNodeId: input.executorNodeId,
      purpose: 'write',
    });
    return c.json({
      data: await container
        .resolve(BackupService)
        .updatePolicy(c.req.param('id')!, c.req.param('policyId')!, input, user.id),
    });
  }
);
backupRoutes.openapi(
  { ...deletePolicyRoute, middleware: requireScopeForResource('databases:backups:manage', 'id') },
  async (c) => {
    const service = container.resolve(BackupService);
    const policy = (await service.listPolicies(c.req.param('id')!)).find(
      (candidate) => candidate.id === c.req.param('policyId')!
    );
    if (!policy) throw new AppError(404, 'BACKUP_POLICY_NOT_FOUND', 'Backup policy not found');
    assertBackupOperationScopes(c, {
      destinationId: policy.destinationId,
      stagingStorageConnectionId: policy.stagingStorageConnectionId,
      executorNodeId: policy.executorNodeId,
      purpose: 'write',
    });
    await service.deletePolicy(c.req.param('id')!, policy.id, c.get('user')!.id);
    return c.json({ success: true });
  }
);
backupRoutes.openapi(
  { ...createPolicyRoute, middleware: requireScopeForResource('databases:backups:manage', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const input = BackupPolicySchema.parse(await c.req.json());
    assertBackupOperationScopes(c, {
      destinationId: input.destinationId,
      stagingStorageConnectionId: input.stagingStorageConnectionId,
      executorNodeId: input.executorNodeId,
      purpose: 'write',
    });
    return c.json(
      {
        data: await container.resolve(BackupService).createPolicy(c.req.param('id')!, input, user.id),
      },
      201
    );
  }
);
backupRoutes.openapi(
  { ...listRunsRoute, middleware: requireScopeForResource('databases:backups:view', 'id') },
  async (c) => c.json({ data: await container.resolve(BackupService).listRuns(c.req.param('id')!) })
);
backupRoutes.openapi(
  { ...startRunRoute, middleware: requireScopeForResource('databases:backups:run', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const policy = (await container.resolve(BackupService).listPolicies(c.req.param('id')!)).find(
      (candidate) => candidate.id === c.req.param('policyId')!
    );
    if (!policy) throw new AppError(404, 'BACKUP_POLICY_NOT_FOUND', 'Backup policy not found');
    assertBackupOperationScopes(c, {
      destinationId: policy.destinationId,
      stagingStorageConnectionId: policy.stagingStorageConnectionId,
      executorNodeId: policy.executorNodeId,
      purpose: 'write',
    });
    return c.json(
      {
        data: await container.resolve(BackupService).startBackup(c.req.param('id')!, c.req.param('policyId')!, user.id),
      },
      201
    );
  }
);
backupRoutes.openapi(
  { ...restoreRoute, middleware: requireScopeForResource('databases:backups:restore', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const input = BackupRestoreSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    if (input.newManagedDatabaseName && !hasScopeForCreation(scopes, 'databases:create', null, input.executorNodeId))
      throw new AppError(403, 'FORBIDDEN', 'Missing databases:create on the restore node');
    if (
      input.restoreTargetConnectionId &&
      (!hasScopeForResource(scopes, 'databases:backups:restore', input.restoreTargetConnectionId) ||
        !hasScopeForResource(scopes, 'databases:edit', input.restoreTargetConnectionId))
    )
      throw new AppError(403, 'FORBIDDEN', 'Missing restore and edit permission on the restore target');
    const run = (await container.resolve(BackupService).listRuns(c.req.param('id')!)).find(
      (candidate) => candidate.id === c.req.param('runId')!
    );
    if (!run) throw new AppError(404, 'BACKUP_RUN_NOT_FOUND', 'Backup run not found');
    assertBackupOperationScopes(c, {
      destinationId: run.destinationId,
      stagingStorageConnectionId: run.stagingStorageConnectionId,
      executorNodeId: input.executorNodeId,
      purpose: 'read',
    });
    return c.json(
      {
        data: await container
          .resolve(BackupService)
          .startRestore(c.req.param('id')!, c.req.param('runId')!, input, user.id),
      },
      201
    );
  }
);
backupRoutes.openapi(
  { ...cancelRoute, middleware: requireScopeForResource('databases:backups:run', 'id') },
  async (c) => {
    const service = container.resolve(BackupService);
    const run = (await service.listRuns(c.req.param('id')!)).find(
      (candidate) => candidate.id === c.req.param('runId')!
    );
    if (!run) throw new AppError(404, 'BACKUP_RUN_NOT_FOUND', 'Backup run not found');
    assertBackupOperationScopes(c, {
      destinationId: run.destinationId,
      stagingStorageConnectionId: run.stagingStorageConnectionId,
      executorNodeId: run.executorNodeId,
      purpose: 'write',
    });
    await service.cancel(c.req.param('id')!, run.id, c.get('user')!.id);
    return c.json({ success: true });
  }
);

backupRoutes.openapi(
  {
    ...appRoute({
      method: 'delete',
      path: '/databases/{id}/backups/runs/{runId}',
      tags: ['Database backups'],
      summary: 'Remove retired backup history',
      request: { params: RunParamSchema },
      responses: okJson(z.object({ success: z.boolean() })),
    }),
    middleware: requireScopeForResource('databases:backups:manage', 'id'),
  },
  async (c) =>
    c.json(
      await container.resolve(BackupService).deleteHistory(c.req.param('id')!, c.req.param('runId')!, c.get('user')!.id)
    )
);
