import type { OpenAPIHono } from '@hono/zod-openapi';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireAnyScopeBase, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import type { ResourceFolderRouteDocs } from './resource-folder.docs.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from './resource-folder.schemas.js';
import type { FolderedResourceService } from './resource-folder.service.js';

export interface ResourceFolderRouteConfig {
  docs: ResourceFolderRouteDocs;
  service: () => FolderedResourceService;
  /** Folder create, rename, move and delete, and every placement change. */
  manageScope: string;
  /** The family's view scope: held broadly it lists every folder. */
  viewScope: string;
  /** Other scopes that list folders; held broadly they list every folder (a create scope, for example). */
  listScopes?: readonly string[];
  /** Scopes whose resource grants make a resource's folder visible. Default: the view scope. */
  visibleResourceScopes?: readonly string[];
  /** Folder-scopable scopes of the family: a folder grant of any of them shows that folder. */
  folderGrantScopes?: readonly string[];
  /**
   * Per-resource scope for moving and reordering. Moving also needs it on the destination (broadly or as a
   * folder grant), because the destination's folder grants then extend to the moved resources.
   */
  placementScope: string;
  /** Replaces the per-resource placement check, for resources authorized through another resource. */
  authorizePlacement?: (scopes: readonly string[], ids: readonly string[]) => Promise<void> | void;
  /** Whether a move needs the placement scope on the destination. Default: true. */
  checkDestination?: boolean;
}

/**
 * Register the folder routes of a foldered resource list on its router. Call it before the resource's
 * `/{id}` routes so `/folders` never reaches them.
 */
export function registerResourceFolderRoutes(routes: OpenAPIHono<AppEnv>, config: ResourceFolderRouteConfig): void {
  const { docs, manageScope, viewScope, placementScope } = config;
  const listScopes = config.listScopes ?? [];
  const folderGrantScopes = config.folderGrantScopes ?? [];
  const manage = requireScope(manageScope);

  const authorizeItems = async (scopes: readonly string[], ids: readonly string[]) => {
    if (config.authorizePlacement) return config.authorizePlacement(scopes, ids);
    const missing = ids.find((id) => !hasScopeForResource([...scopes], placementScope, id));
    if (missing) throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${placementScope}:${missing}`);
  };

  routes.openapi(
    {
      ...docs.list,
      middleware: requireAnyScopeBase(viewScope, manageScope, ...listScopes, ...folderGrantScopes),
    },
    async (c) => {
      const scopes = c.get('effectiveScopes') ?? [];
      const listsAll = [manageScope, viewScope, ...listScopes].some((scope) => hasScope(scopes, scope));
      const data = await config.service().getFolderTree(
        listsAll
          ? { includeAllFolders: true }
          : {
              allowedResourceIds: [
                ...new Set(
                  (config.visibleResourceScopes ?? [viewScope]).flatMap((scope) => getResourceScopedIds(scopes, scope))
                ),
              ],
              allowedFolderIds: getFolderScopedIds(scopes, folderGrantScopes),
            }
      );
      return c.json({ data });
    }
  );

  routes.openapi({ ...docs.create, middleware: manage }, async (c) => {
    const data = await config
      .service()
      .createFolder(CreateResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data }, 201);
  });

  routes.openapi({ ...docs.reorderFolders, middleware: manage }, async (c) => {
    await config.service().reorderFolders(ReorderResourceFoldersSchema.parse(await c.req.json()));
    return c.json({ success: true });
  });

  routes.openapi({ ...docs.moveResources, middleware: manage }, async (c) => {
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') ?? [];
    await authorizeItems(scopes, input.ids);
    if (config.checkDestination !== false && !hasScopeForCreation(scopes, placementScope, input.folderId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing ${placementScope} for the move destination`);
    }
    await config.service().moveResourcesToFolder(input, c.get('user')!.id);
    return c.json({ success: true });
  });

  routes.openapi({ ...docs.reorderResources, middleware: manage }, async (c) => {
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await authorizeItems(
      c.get('effectiveScopes') ?? [],
      input.items.map((item) => item.id)
    );
    await config.service().reorderResources(input);
    return c.json({ success: true });
  });

  routes.openapi({ ...docs.update, middleware: manage }, async (c) => {
    const data = await config
      .service()
      .updateFolder(c.req.param('id')!, UpdateResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data });
  });

  routes.openapi({ ...docs.moveFolder, middleware: manage }, async (c) => {
    const data = await config
      .service()
      .moveFolder(c.req.param('id')!, MoveResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id, {
        scopes: c.get('effectiveScopes') ?? [],
        editScope: placementScope,
      });
    return c.json({ data });
  });

  routes.openapi({ ...docs.delete, middleware: manage }, async (c) => {
    await config.service().deleteFolder(c.req.param('id')!, c.get('user')!.id);
    return c.json({ success: true });
  });
}
