import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, rejectImpersonation, requireScopeBase } from '@/modules/auth/auth.middleware.js';
import {
  createManagedStorageAccessKeyRoute,
  createManagedStorageBindingRoute,
  createManagedStorageRoute,
  deleteManagedStorageBindingRoute,
  deleteManagedStorageRoute,
  getManagedStorageRoute,
  listManagedStorageAccessKeysRoute,
  listManagedStorageBindingsRoute,
  listManagedStorageCatalogRoute,
  listManagedStorageRoute,
  removeManagedStorageAccessKeyRoute,
  restartManagedStorageRoute,
  retryManagedStorageProvisioningRoute,
  revealManagedStorageCredentialsRoute,
  updateManagedStorageRoute,
} from './managed-storage.docs.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  UpdateManagedStorageSchema,
} from './managed-storage.schemas.js';
import { ManagedStorageService } from './managed-storage.service.js';
import { ManagedStorageBindingsService } from './managed-storage-bindings.service.js';
export const managedStorageRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  getResourceScopedIds,
  hasScope,
  hasScopeForCreation,
  AppError,
  authMiddleware,
  rejectImpersonation,
  requireScopeBase,
  createManagedStorageAccessKeyRoute,
  createManagedStorageBindingRoute,
  createManagedStorageRoute,
  deleteManagedStorageBindingRoute,
  deleteManagedStorageRoute,
  getManagedStorageRoute,
  listManagedStorageAccessKeysRoute,
  listManagedStorageBindingsRoute,
  listManagedStorageCatalogRoute,
  listManagedStorageRoute,
  removeManagedStorageAccessKeyRoute,
  restartManagedStorageRoute,
  retryManagedStorageProvisioningRoute,
  revealManagedStorageCredentialsRoute,
  updateManagedStorageRoute,
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  UpdateManagedStorageSchema,
  ManagedStorageService,
  ManagedStorageBindingsService,
};
