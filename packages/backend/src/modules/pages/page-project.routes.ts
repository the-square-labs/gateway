import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireAnyScopeBase,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { AppEnv } from '@/types.js';
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

export const pageProjectRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
pageProjectRoutes.use('*', authMiddleware);
pageProjectRoutes.use('*', requireLicenseFeature('pages'));

pageProjectRoutes.openapi(
  { ...listPageProjectFoldersRoute, middleware: requireAnyScopeBase('pages:view', 'pages:folders:manage') },
  async (c) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const includeAllFolders = hasScope(scopes, 'pages:view') || hasScope(scopes, 'pages:folders:manage');
    const data = await container
      .resolve(PageProjectFolderService)
      .getFolderTree(
        includeAllFolders ? { includeAllFolders: true } : { allowedResourceIds: visiblePageProjectIds(scopes) ?? [] }
      );
    return c.json({ data });
  }
);

pageProjectRoutes.openapi(
  { ...createPageProjectFolderRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    const data = await container
      .resolve(PageProjectFolderService)
      .createFolder(CreateResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data }, 201);
  }
);

pageProjectRoutes.openapi(
  { ...reorderPageProjectFoldersRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    await container
      .resolve(PageProjectFolderService)
      .reorderFolders(ReorderResourceFoldersSchema.parse(await c.req.json()));
    return c.json({ success: true });
  }
);

pageProjectRoutes.openapi(
  { ...movePageProjectsToFolderRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    if (!canAccessEveryPageProject(scopes, 'pages:edit', input.ids)) {
      throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:edit for one or more Projects');
    }
    await container.resolve(PageProjectFolderService).moveResourcesToFolder(input, c.get('user')!.id);
    return c.json({ success: true });
  }
);

pageProjectRoutes.openapi(
  { ...reorderPageProjectsRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    const input = ReorderResourcesSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !canAccessEveryPageProject(
        scopes,
        'pages:edit',
        input.items.map((item) => item.id)
      )
    ) {
      throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:edit for one or more Projects');
    }
    await container.resolve(PageProjectFolderService).reorderResources(input);
    return c.json({ success: true });
  }
);

pageProjectRoutes.openapi(
  { ...updatePageProjectFolderRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    const data = await container
      .resolve(PageProjectFolderService)
      .updateFolder(c.req.param('id')!, UpdateResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  }
);

pageProjectRoutes.openapi(
  { ...movePageProjectFolderRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    const data = await container
      .resolve(PageProjectFolderService)
      .moveFolder(c.req.param('id')!, MoveResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  }
);

pageProjectRoutes.openapi(
  { ...deletePageProjectFolderRoute, middleware: requireScope('pages:folders:manage') },
  async (c) => {
    await container.resolve(PageProjectFolderService).deleteFolder(c.req.param('id')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);

pageProjectRoutes.openapi({ ...listPageProjectsRoute, middleware: requireScopeBase('pages:view') }, async (c) => {
  const query = PageProjectListQuerySchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    search: c.req.query('search'),
    folderId: c.req.query('folderId'),
  });
  const allowedIds = visiblePageProjectIds(c.get('effectiveScopes') ?? []);
  return c.json(await container.resolve(PageProjectService).list(query, allowedIds ? { allowedIds } : undefined));
});

pageProjectRoutes.openapi({ ...createPageProjectRoute, middleware: requireScope('pages:create') }, async (c) => {
  const input = CreatePageProjectSchema.parse(await c.req.json());
  if (input.folderId && !hasScope(c.get('effectiveScopes') ?? [], 'pages:folders:manage')) {
    throw new AppError(403, 'PAGE_PROJECT_FOLDER_FORBIDDEN', 'pages:folders:manage is required to create in a folder');
  }
  const data = await container.resolve(PageProjectService).create(input, c.get('user')!.id);
  return c.json({ data }, 201);
});

pageProjectRoutes.openapi(
  { ...listPageProjectPlacementOptionsRoute, middleware: requireAnyScopeBase('pages:create', 'pages:edit') },
  async (c) => c.json({ data: await container.resolve(PageProjectService).placementOptions() })
);

pageProjectRoutes.openapi(getPageProjectBySlugRoute, async (c) => {
  const project = await container.resolve(PageProjectService).getBySlug(c.req.param('slug')!);
  if (!canAccessPageProject(c.get('effectiveScopes') ?? [], 'pages:view', project.id)) {
    throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:view for this Project');
  }
  return c.json({ data: project });
});

pageProjectRoutes.openapi(
  { ...getPageProjectRoute, middleware: requireScopeForResource('pages:view', 'id') },
  async (c) => c.json({ data: await container.resolve(PageProjectService).get(c.req.param('id')!) })
);

pageProjectRoutes.openapi(
  { ...updatePageProjectRoute, middleware: requireScopeForResource('pages:edit', 'id') },
  async (c) => {
    const data = await container
      .resolve(PageProjectService)
      .update(c.req.param('id')!, UpdatePageProjectSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  }
);

pageProjectRoutes.openapi(
  { ...migratePageProjectRoute, middleware: requireScopeForResource('pages:edit', 'id') },
  async (c) => {
    const data = await container
      .resolve(PageProjectService)
      .migrate(c.req.param('id')!, MigratePageProjectSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  }
);

pageProjectRoutes.openapi(
  { ...deletePageProjectRoute, middleware: requireScopeForResource('pages:delete', 'id') },
  async (c) => {
    await container.resolve(PageProjectService).delete(c.req.param('id')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);
