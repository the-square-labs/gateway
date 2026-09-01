import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import {
  createLoggingEnvironmentFolderRoute,
  createLoggingEnvironmentRoute,
  createLoggingSchemaFolderRoute,
  createLoggingSchemaRoute,
  createLoggingTokenRoute,
  deleteLoggingEnvironmentFolderRoute,
  deleteLoggingEnvironmentRoute,
  deleteLoggingSchemaFolderRoute,
  deleteLoggingSchemaRoute,
  deleteLoggingTokenRoute,
  getLoggingEnvironmentBySlugRoute,
  getLoggingEnvironmentRoute,
  getLoggingSchemaBySlugRoute,
  getLoggingSchemaRoute,
  listLoggingEnvironmentFoldersRoute,
  listLoggingEnvironmentsRoute,
  listLoggingSchemaFoldersRoute,
  listLoggingSchemasRoute,
  listLoggingTokensRoute,
  loggingBatchIngestRoute,
  loggingFacetsRoute,
  loggingHealthRoute,
  loggingIngestRoute,
  loggingMetadataRoute,
  moveLoggingEnvironmentFolderRoute,
  moveLoggingEnvironmentsToFolderRoute,
  moveLoggingSchemaFolderRoute,
  moveLoggingSchemasToFolderRoute,
  reorderLoggingEnvironmentFoldersRoute,
  reorderLoggingEnvironmentsRoute,
  reorderLoggingSchemaFoldersRoute,
  reorderLoggingSchemasRoute,
  searchLogsRoute,
  updateLoggingEnvironmentFolderRoute,
  updateLoggingEnvironmentRoute,
  updateLoggingSchemaFolderRoute,
  updateLoggingSchemaRoute,
} from './logging.docs.js';
import {
  CreateLoggingEnvironmentSchema,
  CreateLoggingSchemaSchema,
  CreateLoggingTokenSchema,
  LoggingBatchSchema,
  LoggingFacetsQuerySchema,
  LoggingSearchSchema,
  UpdateLoggingEnvironmentSchema,
  UpdateLoggingSchemaSchema,
} from './logging.schemas.js';
import { LoggingEnvironmentService } from './logging-environment.service.js';
import { LoggingEnvironmentFolderService } from './logging-environment-folders.service.js';
import { LoggingFeatureService } from './logging-feature.service.js';
import { LoggingIngestService } from './logging-ingest.service.js';
import { loggingIngestAuthMiddleware } from './logging-ingest-auth.middleware.js';
import { LoggingMaintenanceService } from './logging-maintenance.service.js';
import { LoggingMetadataService } from './logging-metadata.service.js';
import { LoggingRateLimitService } from './logging-rate-limit.service.js';
import { LoggingSchemaService } from './logging-schema.service.js';
import { LoggingSchemaFolderService } from './logging-schema-folders.service.js';
import { LoggingSearchService } from './logging-search.service.js';
import { LoggingTokenService } from './logging-token.service.js';

export const loggingRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

const requireLoggingRuntimeMiddleware = async (_c: any, next: () => Promise<void>) => {
  // Existing configured ingestion remains available during ordinary expiry continuity.
  await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('structured-logging');
  const feature = container.resolve(LoggingFeatureService);
  feature.requireEnabled();
  await next();
};

const requireLoggingEnabledMiddleware = async (_c: any, next: () => Promise<void>) => {
  // Configuration and expansion still require the current Business entitlement.
  await container.resolve(LicensePolicyService).requireFeature('structured-logging');
  const feature = container.resolve(LoggingFeatureService);
  feature.requireEnabled();
  await next();
};

loggingRoutes.use('/ingest', requireLoggingRuntimeMiddleware);
loggingRoutes.use('/ingest/batch', requireLoggingRuntimeMiddleware);

loggingRoutes.openapi({ ...loggingIngestRoute, middleware: loggingIngestAuthMiddleware }, async (c) => {
  const body = await c.req.json();
  return handleIngest(c, body, [body]);
});

loggingRoutes.openapi({ ...loggingBatchIngestRoute, middleware: loggingIngestAuthMiddleware }, async (c) => {
  const body = await c.req.json();
  const parsed = LoggingBatchSchema.parse(body);
  return handleIngest(c, body, parsed.logs);
});

loggingRoutes.use('*', authMiddleware);

loggingRoutes.openapi({ ...loggingHealthRoute, middleware: requireScope('housekeeping:view') }, async (c) => {
  const service = container.resolve(LoggingMaintenanceService);
  return c.json({ data: service.getSnapshot() });
});

for (const path of ['/environments', '/environment-folders', '/schemas', '/schema-folders']) {
  loggingRoutes.use(path, requireLoggingEnabledMiddleware);
  loggingRoutes.use(`${path}/*`, requireLoggingEnabledMiddleware);
}

loggingRoutes.openapi(
  { ...listLoggingEnvironmentsRoute, middleware: requireLoggingEnvironmentListScope() },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentService);
    const scopes = c.get('effectiveScopes') ?? [];
    const hasGlobalAccess =
      TokensService.hasScope(scopes, 'logs:environments:view') || TokensService.hasScope(scopes, 'logs:manage');
    const allowedIds = hasGlobalAccess ? undefined : [...resourceScopedIds(scopes, 'logs:environments:view')];
    const data = await service.list({ search: c.req.query('search'), allowedIds });
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...createLoggingEnvironmentRoute, middleware: requireLoggingScope('logs:environments:create') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentService);
    const user = c.get('user')!;
    const input = CreateLoggingEnvironmentSchema.parse(await c.req.json());
    const data = await service.create(input, user.id);
    return c.json({ data }, 201);
  }
);

loggingRoutes.openapi(getLoggingEnvironmentBySlugRoute, async (c) => {
  const service = container.resolve(LoggingEnvironmentService);
  const data = await service.getBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') ?? [];
  if (
    !TokensService.hasScope(scopes, 'logs:manage') &&
    !TokensService.hasScope(scopes, `logs:environments:view:${data.id}`)
  ) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: logs:environments:view:${data.id}`);
  }
  return c.json({ data });
});

loggingRoutes.openapi(
  { ...getLoggingEnvironmentRoute, middleware: requireLoggingResourceScope('logs:environments:view') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentService);
    const data = await service.get(c.req.param('id')!);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...updateLoggingEnvironmentRoute, middleware: requireLoggingResourceScope('logs:environments:edit') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentService);
    const user = c.get('user')!;
    const input = UpdateLoggingEnvironmentSchema.parse(await c.req.json());
    const data = await service.update(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...deleteLoggingEnvironmentRoute, middleware: requireLoggingResourceScope('logs:environments:delete') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentService);
    const user = c.get('user')!;
    await service.delete(c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);

loggingRoutes.openapi(
  { ...listLoggingEnvironmentFoldersRoute, middleware: requireLoggingEnvironmentFolderListScope() },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const scopes = c.get('effectiveScopes') ?? [];
    const canManageFolders =
      TokensService.hasScope(scopes, 'logs:environments:folders:manage') ||
      TokensService.hasScope(scopes, 'logs:manage');
    const hasGlobalView =
      TokensService.hasScope(scopes, 'logs:environments:view') || TokensService.hasScope(scopes, 'logs:manage');
    const allowedIds = [...resourceScopedIds(scopes, 'logs:environments:view')];
    const data = await service.getFolderTree(
      canManageFolders || hasGlobalView ? { includeAllFolders: canManageFolders } : { allowedResourceIds: allowedIds }
    );
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...createLoggingEnvironmentFolderRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

loggingRoutes.openapi(
  { ...reorderLoggingEnvironmentFoldersRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...moveLoggingEnvironmentsToFolderRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...reorderLoggingEnvironmentsRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...updateLoggingEnvironmentFolderRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...moveLoggingEnvironmentFolderRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const data = await service.moveFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...deleteLoggingEnvironmentFolderRoute, middleware: requireLoggingScope('logs:environments:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingEnvironmentFolderService);
    const user = c.get('user')!;
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi({ ...listLoggingSchemasRoute, middleware: requireLoggingSchemaListScope() }, async (c) => {
  const service = container.resolve(LoggingSchemaService);
  const scopes = c.get('effectiveScopes') ?? [];
  const data = await service.list({ search: c.req.query('search') });
  if (TokensService.hasScope(scopes, 'logs:schemas:view') || TokensService.hasScope(scopes, 'logs:manage')) {
    return c.json({ data });
  }
  const visibleIds = resourceScopedIds(scopes, 'logs:schemas:view');
  return c.json({ data: data.filter((schema) => visibleIds.has(schema.id)) });
});

loggingRoutes.openapi(
  { ...listLoggingSchemaFoldersRoute, middleware: requireLoggingSchemaFolderListScope() },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const scopes = c.get('effectiveScopes') ?? [];
    const canManageFolders =
      TokensService.hasScope(scopes, 'logs:schemas:folders:manage') || TokensService.hasScope(scopes, 'logs:manage');
    const hasGlobalView =
      TokensService.hasScope(scopes, 'logs:schemas:view') || TokensService.hasScope(scopes, 'logs:manage');
    const allowedIds = [...resourceScopedIds(scopes, 'logs:schemas:view')];
    const data = await service.getFolderTree(
      canManageFolders || hasGlobalView ? { includeAllFolders: canManageFolders } : { allowedResourceIds: allowedIds }
    );
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...createLoggingSchemaFolderRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

loggingRoutes.openapi(
  { ...reorderLoggingSchemaFoldersRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...moveLoggingSchemasToFolderRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...reorderLoggingSchemasRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...updateLoggingSchemaFolderRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...moveLoggingSchemaFolderRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const data = await service.moveFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...deleteLoggingSchemaFolderRoute, middleware: requireLoggingScope('logs:schemas:folders:manage') },
  async (c) => {
    const service = container.resolve(LoggingSchemaFolderService);
    const user = c.get('user')!;
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

loggingRoutes.openapi(
  { ...createLoggingSchemaRoute, middleware: requireLoggingScope('logs:schemas:create') },
  async (c) => {
    const service = container.resolve(LoggingSchemaService);
    const user = c.get('user')!;
    const input = CreateLoggingSchemaSchema.parse(await c.req.json());
    const data = await service.create(input, user.id);
    return c.json({ data }, 201);
  }
);

loggingRoutes.openapi(getLoggingSchemaBySlugRoute, async (c) => {
  const service = container.resolve(LoggingSchemaService);
  const data = await service.getBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') ?? [];
  if (
    !TokensService.hasScope(scopes, 'logs:manage') &&
    !TokensService.hasScope(scopes, `logs:schemas:view:${data.id}`)
  ) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: logs:schemas:view:${data.id}`);
  }
  return c.json({ data });
});

loggingRoutes.openapi(
  { ...getLoggingSchemaRoute, middleware: requireLoggingSchemaScope('logs:schemas:view') },
  async (c) => {
    const service = container.resolve(LoggingSchemaService);
    const data = await service.get(c.req.param('schemaId')!);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...updateLoggingSchemaRoute, middleware: requireLoggingSchemaScope('logs:schemas:edit') },
  async (c) => {
    const service = container.resolve(LoggingSchemaService);
    const user = c.get('user')!;
    const input = UpdateLoggingSchemaSchema.parse(await c.req.json());
    const data = await service.update(c.req.param('schemaId')!, input, user.id);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...deleteLoggingSchemaRoute, middleware: requireLoggingSchemaScope('logs:schemas:delete') },
  async (c) => {
    const service = container.resolve(LoggingSchemaService);
    const user = c.get('user')!;
    await service.delete(c.req.param('schemaId')!, user.id);
    return c.body(null, 204);
  }
);

loggingRoutes.openapi(
  { ...listLoggingTokensRoute, middleware: requireLoggingResourceScope('logs:tokens:view') },
  async (c) => {
    const service = container.resolve(LoggingTokenService);
    const data = await service.list(c.req.param('id')!);
    return c.json({ data });
  }
);

loggingRoutes.openapi(
  { ...createLoggingTokenRoute, middleware: requireLoggingResourceScope('logs:tokens:create') },
  async (c) => {
    const service = container.resolve(LoggingTokenService);
    const user = c.get('user')!;
    const input = CreateLoggingTokenSchema.parse(await c.req.json());
    const data = await service.create(c.req.param('id')!, input, user.id);
    return c.json({ data }, 201);
  }
);

loggingRoutes.openapi(
  { ...deleteLoggingTokenRoute, middleware: requireLoggingResourceScope('logs:tokens:delete') },
  async (c) => {
    const service = container.resolve(LoggingTokenService);
    const user = c.get('user')!;
    await service.delete(c.req.param('id')!, c.req.param('tokenId')!, user.id);
    return c.body(null, 204);
  }
);

loggingRoutes.openapi({ ...searchLogsRoute, middleware: requireLoggingResourceScope('logs:read') }, async (c) => {
  const feature = container.resolve(LoggingFeatureService);
  feature.requireAvailableForStorage();
  const service = container.resolve(LoggingSearchService);
  const input = LoggingSearchSchema.parse(await c.req.json());
  const data = await service.search(c.req.param('id')!, input as any);
  return c.json(data);
});

loggingRoutes.openapi({ ...loggingFacetsRoute, middleware: requireLoggingResourceScope('logs:read') }, async (c) => {
  const feature = container.resolve(LoggingFeatureService);
  feature.requireAvailableForStorage();
  const service = container.resolve(LoggingSearchService);
  const input = LoggingFacetsQuerySchema.parse(c.req.query());
  const data = await service.facets(c.req.param('id')!, input);
  return c.json({ data });
});

loggingRoutes.openapi({ ...loggingMetadataRoute, middleware: requireLoggingResourceScope('logs:read') }, async (c) => {
  const service = container.resolve(LoggingMetadataService);
  const data = await service.get(c.req.param('id')!);
  return c.json({ data });
});

async function handleIngest(c: any, body: unknown, logs: unknown[]) {
  const feature = container.resolve(LoggingFeatureService);
  feature.requireAvailableForIngest();
  const ingestContext = c.get('loggingIngest');
  if (!ingestContext) throw new AppError(401, 'LOGGING_AUTH_REQUIRED', 'Logging ingest token required');
  const rateLimit = container.resolve(LoggingRateLimitService);
  await rateLimit.check({
    tokenId: ingestContext.tokenId,
    environmentId: ingestContext.environmentId,
    events: logs.length,
    environmentRequestLimit: ingestContext.environment.rateLimitRequestsPerWindow,
    environmentEventLimit: ingestContext.environment.rateLimitEventsPerWindow,
  });
  const service = container.resolve(LoggingIngestService);
  const data = await service.ingest({
    body,
    contentLength: c.req.header('Content-Length'),
    logs,
    environment: ingestContext.environment,
  });
  return c.json(data);
}

function requireLoggingScope(scope: string) {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') ?? [];
    if (!TokensService.hasScope(scopes, scope) && !TokensService.hasScope(scopes, 'logs:manage')) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await next();
  };
}

function resourceScopedIds(scopes: string[], scope: string): Set<string> {
  const ids = new Set<string>();
  for (const candidate of scopes) {
    const base = extractBaseScope(candidate);
    if (candidate === base) continue;
    const id = candidate.slice(base.length + 1);
    if (id && TokensService.hasScope([candidate], `${scope}:${id}`)) ids.add(id);
  }
  return ids;
}

function requireLoggingSchemaListScope() {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !TokensService.hasScope(scopes, 'logs:schemas:view') &&
      !TokensService.hasScope(scopes, 'logs:manage') &&
      resourceScopedIds(scopes, 'logs:schemas:view').size === 0
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: logs:schemas:view');
    }
    await next();
  };
}

function requireLoggingEnvironmentListScope() {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !TokensService.hasScope(scopes, 'logs:environments:view') &&
      !TokensService.hasScope(scopes, 'logs:manage') &&
      resourceScopedIds(scopes, 'logs:environments:view').size === 0
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: logs:environments:view');
    }
    await next();
  };
}

function requireLoggingEnvironmentFolderListScope() {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !TokensService.hasScope(scopes, 'logs:environments:folders:manage') &&
      !TokensService.hasScope(scopes, 'logs:environments:view') &&
      !TokensService.hasScope(scopes, 'logs:manage') &&
      resourceScopedIds(scopes, 'logs:environments:view').size === 0
    ) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Missing required scope: logs:environments:view or logs:environments:folders:manage'
      );
    }
    await next();
  };
}

function requireLoggingSchemaFolderListScope() {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !TokensService.hasScope(scopes, 'logs:schemas:folders:manage') &&
      !TokensService.hasScope(scopes, 'logs:schemas:view') &&
      !TokensService.hasScope(scopes, 'logs:manage') &&
      resourceScopedIds(scopes, 'logs:schemas:view').size === 0
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: logs:schemas:view or logs:schemas:folders:manage');
    }
    await next();
  };
}

function requireLoggingSchemaScope(scope: string) {
  return async (c: any, next: () => Promise<void>) => {
    const schemaId = c.req.param('schemaId')!;
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !TokensService.hasScope(scopes, `${scope}:${schemaId}`) &&
      !TokensService.hasScope(scopes, scope) &&
      !TokensService.hasScope(scopes, 'logs:manage')
    ) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}:${schemaId}`);
    }
    await next();
  };
}

function requireLoggingResourceScope(scope: string) {
  return async (c: any, next: () => Promise<void>) => {
    const id = c.req.param('id')!;
    const scopes = c.get('effectiveScopes') ?? [];
    if (
      !TokensService.hasScope(scopes, `${scope}:${id}`) &&
      !TokensService.hasScope(scopes, scope) &&
      !TokensService.hasScope(scopes, 'logs:manage')
    ) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}:${id}`);
    }
    await next();
  };
}
