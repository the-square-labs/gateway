import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireAnyScopeBase,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import {
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerSourceBindingUpsertSchema,
  PagesBuildDiscoverySchema,
} from '@/modules/docker/docker-build.schemas.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { requireLicenseFeature, requireLicenseFeatureForRequest } from '@/modules/license/license-policy.middleware.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  createPageProjectFolderRoute,
  createPageProjectRoute,
  deletePageProjectFolderRoute,
  deletePageProjectRoute,
  getPageProjectBySlugRoute,
  getPageProjectRoute,
  listPageProjectFoldersRoute,
  listPageProjectPlacementOptionsRoute,
  listPageProjectsRoute,
  migratePageProjectRoute,
  movePageProjectFolderRoute,
  movePageProjectsToFolderRoute,
  reorderPageProjectFoldersRoute,
  reorderPageProjectsRoute,
  updatePageProjectFolderRoute,
  updatePageProjectRoute,
} from './page-project.docs.js';
import {
  CreatePageProjectSchema,
  MigratePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
} from './page-project.schemas.js';
import { PageProjectService } from './page-project.service.js';
import { canAccessEveryPageProject, canAccessPageProject, visiblePageProjectIds } from './page-project-access.js';
import { PageProjectFolderService } from './page-project-folder.service.js';
import { requirePagesEnabledForMutation } from './profile/page-enabled.middleware.js';
export const pageProjectRouteRuntime = {
  OpenAPIHono,
  container,
  getFolderScopedIds,
  openApiValidationHook,
  getResourceScopedIds,
  hasScope,
  hasScopeForCreation,
  AppError,
  authMiddleware,
  requireAnyScopeBase,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerSourceBindingUpsertSchema,
  PagesBuildDiscoverySchema,
  DockerSourceService,
  IntegrationsService,
  requireLicenseFeature,
  requireLicenseFeatureForRequest,
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
  createPageProjectFolderRoute,
  createPageProjectRoute,
  deletePageProjectFolderRoute,
  deletePageProjectRoute,
  getPageProjectBySlugRoute,
  getPageProjectRoute,
  listPageProjectFoldersRoute,
  listPageProjectPlacementOptionsRoute,
  listPageProjectsRoute,
  migratePageProjectRoute,
  movePageProjectFolderRoute,
  movePageProjectsToFolderRoute,
  reorderPageProjectFoldersRoute,
  reorderPageProjectsRoute,
  updatePageProjectFolderRoute,
  updatePageProjectRoute,
  CreatePageProjectSchema,
  MigratePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
  PageProjectService,
  canAccessEveryPageProject,
  canAccessPageProject,
  visiblePageProjectIds,
  PageProjectFolderService,
  requirePagesEnabledForMutation,
};
