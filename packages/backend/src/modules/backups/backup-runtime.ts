import { OpenAPIHono, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import cron from 'node-cron';
import { resolveBackupRunnerImage } from '@/config/backup-runner-image.js';
import { container } from '@/container.js';
import {
  backupPolicies,
  backupRunNodeLeases,
  backupRuns,
  databaseConnections,
  managedDatabaseInstances,
  nodes,
} from '@/db/schema/index.js';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  openApiValidationHook,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { CreateManagedDatabaseSchema } from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { StorageCAService } from '@/services/storage-ca.service.js';
import { BackupService } from './backups.service.js';

/** Existing host instances and DTO constructors shared with the private backup domain. */
export const backupRuntime = {
  OpenAPIHono,
  z,
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  cron,
  container,
  backupPolicies,
  backupRunNodeLeases,
  backupRuns,
  databaseConnections,
  managedDatabaseInstances,
  nodes,
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  openApiValidationHook,
  UnknownDataResponseSchema,
  hasScope,
  hasScopeForCreation,
  hasScopeForResource,
  AppError,
  authMiddleware,
  requireScopeForResource,
  resolveLiveUser,
  CreateManagedDatabaseSchema,
  BackupService,
  ManagedDatabaseService,
  ObjectStorageService,
  AuditService,
  CryptoService,
  NodeDispatchService,
  StorageCAService,
  resolveBackupRunnerImage,
};
