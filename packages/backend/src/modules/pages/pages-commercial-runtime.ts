import { PageArtifactStore } from './artifacts/page-artifact-store.js';
import { PageBuildRolloutService } from './deployments/page-build-rollout.service.js';
import { PageDeploymentService } from './deployments/page-deployment.service.js';
import { PageProjectService } from './page-project.service.js';
import { PageProfileService } from './profile/page-profile.service.js';
import { PageMaintenanceService } from './retention/page-maintenance.service.js';
import { PageRetentionService } from './retention/page-retention.service.js';
import { PageRouteService } from './routes/page-route.service.js';
import { PageNodeRuntimeService } from './runtime/page-node-runtime.service.js';
import { PageRuntimeConfigService } from './runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from './tags/page-publication.service.js';
import { PageTagService } from './tags/page-tag.service.js';
import { PageDeployTokenService } from './tokens/page-deploy-token.service.js';

const constructors = {
  PageProjectService,
  PageArtifactStore,
  PageBuildRolloutService,
  PageDeploymentService,
  PageTagService,
  PagePublicationService,
  PageRuntimeConfigService,
  PageRouteService,
  PageNodeRuntimeService,
  PageRetentionService,
  PageMaintenanceService,
  PageDeployTokenService,
  PageProfileService,
};
export type PagesConstructors = typeof constructors;

import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, max, ne, sql } from 'drizzle-orm';
import { getDomain } from 'tldts';
import {
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerBuilds,
  dockerSourceBindings,
  domains,
  nodes,
  pageDeploymentReplicas,
  pageDeployments,
  pageDeployTokens,
  pageIngressMigrations,
  pageProjectFolders,
  pageProjects,
  pageRouteTargets,
  pageRuntimeConfigs,
  pageTagActivations,
  pageTags,
  pageUploadSessions,
  pageWildcardProfiles,
  proxyAdditionalRoutes,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '@/modules/pages/page-events.js';
import {
  CreatePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
} from '@/modules/pages/page-project.schemas.js';
import { canAccessEveryPageProject, visiblePageProjectIds } from '@/modules/pages/page-project-access.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { PAGE_RUNTIME_CONFIG_MAX_BYTES } from '@/modules/pages/runtime-config/page-runtime-config.schemas.js';
export const pagesCommercialRuntime = {
  constructors,
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  max,
  ne,
  dockerSourceBindings,
  nodes,
  pageDeployments,
  pageProjectFolders,
  pageProjects,
  pageRouteTargets,
  pageRuntimeConfigs,
  pageTagActivations,
  pageTags,
  proxyAdditionalRoutes,
  proxyHosts,
  grantCreatedResourcePermissions,
  writeWithAllocatedSlug,
  buildWhere,
  AppError,
  PAGE_EVENT_CHANNELS,
  pageProjectEvent,
  sql,
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerBuilds,
  pageUploadSessions,
  hasScopeForResource,
  PAGE_RUNTIME_CONFIG_MAX_BYTES,
  domains,
  pageDeploymentReplicas,
  pageWildcardProfiles,
  pageIngressMigrations,
  lt,
  pageDeployTokens,
  sslCertificates,
  getDomain,
  CreatePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
  canAccessEveryPageProject,
  visiblePageProjectIds,
  PageProjectFolderService,
  createChildLogger,
};
