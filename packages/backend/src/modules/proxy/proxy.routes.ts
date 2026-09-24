import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import type { AppEnv } from '@/types.js';
import {
  createAdditionalRouteRoute,
  deleteAdditionalRouteRoute,
  getAdditionalRouteRoute,
  listAdditionalRoutesRoute,
  retryAdditionalRouteRoute,
  updateAdditionalRouteRoute,
} from './additional-route.docs.js';
import { AdditionalRouteService } from './additional-route.service.js';
import { CreateAdditionalRouteSchema, UpdateAdditionalRouteSchema } from './additional-route.validation.js';
import { FolderService } from './folder.service.js';
import {
  redactProxyHostForScopes,
  redactAdditionalRouteForScopes as serializeAdditionalRoute,
} from './page-target-visibility.js';
import {
  createProxyHostRoute,
  deleteProxyHostRoute,
  getProxyHostBySlugRoute,
  getProxyHostHealthHistoryRoute,
  getProxyHostRoute,
  listProxyHostsRoute,
  renderedProxyConfigRoute,
  resyncProxyHostTlsRoute,
  toggleProxyHostRoute,
  toggleProxyMaintenanceRoute,
  updateProxyHostRoute,
  validateProxyConfigRoute,
} from './proxy.docs.js';
import {
  CreateAdditionalSecureLinkSchema,
  CreateProxyHostSchema,
  ProxyHostListQuerySchema,
  ToggleProxyHostSchema,
  ToggleProxyMaintenanceSchema,
  UpdateProxyHostSchema,
  ValidateAdvancedConfigSchema,
} from './proxy.schemas.js';
import { ProxyService } from './proxy.service.js';
import { ProxyMaintenanceAccessService } from './proxy-maintenance-access.service.js';
import { redactRawProxyConfigForBrowser } from './raw-visibility.js';

export const proxyRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

proxyRoutes.use('*', authMiddleware);

type RawModeState = { type?: string | null; rawConfigEnabled?: boolean | null };

/**
 * A raw-mode "toggle" is an actual change of the stored mode. Clients that
 * submit a complete form echo the unchanged `rawConfigEnabled`/`type`, which
 * must not require the raw scopes.
 */
function requestTogglesRawProxyConfig(
  input: { type?: string; rawConfigEnabled?: unknown },
  existing: RawModeState = {}
): boolean {
  const becomesRawType = input.type === 'raw' && existing.type !== 'raw';
  const leavesRawType = existing.type === 'raw' && input.type !== undefined && input.type !== 'raw';
  const changesFlag =
    input.rawConfigEnabled !== undefined && input.rawConfigEnabled !== (existing.rawConfigEnabled ?? false);
  return becomesRawType || leavesRawType || changesFlag;
}

function normalizedAdvancedConfig(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requestOnlyUpdatesRawProxyConfig(input: Record<string, unknown>): boolean {
  const rawKeys = new Set(['rawConfig']);
  return Object.keys(input).length > 0 && Object.keys(input).every((key) => rawKeys.has(key));
}

function canReadRawProxyConfig(scopes: string[], id: string) {
  return scopes.includes('proxy:raw:read') || scopes.includes(`proxy:raw:read:${id}`);
}

function serializeProxyHostForBrowser(host: Record<string, unknown>, scopes: string[], id: string) {
  const scoped = redactProxyHostForScopes(host, scopes);
  return canReadRawProxyConfig(scopes, id) ? scoped : redactRawProxyConfigForBrowser(scoped);
}

proxyRoutes.openapi({ ...listProxyHostsRoute, middleware: requireScopeBase('proxy:view') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const query = ProxyHostListQuerySchema.parse(c.req.query());
  const scopes = c.get('effectiveScopes') || [];
  const result = await proxyService.listProxyHosts(
    query,
    hasScope(scopes, 'proxy:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'proxy:view') }
  );
  const scopedData = result.data.map((host) => redactProxyHostForScopes(host as any, scopes));
  return c.json({ ...result, data: scopedData });
});

proxyRoutes.openapi(getProxyHostBySlugRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const host = await proxyService.getProxyHostBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') || [];
  if (!hasScope(scopes, `proxy:view:${host.id}`)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:view:${host.id}`);
  }
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, host.id) });
});

proxyRoutes.openapi({ ...getProxyHostRoute, middleware: requireScopeForResource('proxy:view', 'id') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const id = c.req.param('id')!;
  const host = await proxyService.getProxyHost(id);
  const scopes = c.get('effectiveScopes') || [];
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
});

proxyRoutes.openapi(
  { ...getProxyHostHealthHistoryRoute, middleware: requireScopeForResource('proxy:view', 'id') },
  async (c) => {
    const proxyService = container.resolve(ProxyService);
    const id = c.req.param('id')!;
    const healthHistory = await proxyService.getProxyHostHealthHistory(id);
    return c.json({ data: healthHistory });
  }
);

proxyRoutes.get('/:id/secure-link', requireScopeForResource('proxy:view', 'id'), async (c) => {
  const data = await container.resolve(ProxyService).getProxySecureLinkStatus(c.req.param('id')!);
  return c.json({ data });
});

proxyRoutes.post(
  '/:id/maintenance-access-code',
  requireScopeForResource('proxy:maintenance:bypass', 'id'),
  async (c) => {
    const data = await container.resolve(ProxyMaintenanceAccessService).issue(c.req.param('id')!, c.get('user')!.id);
    return c.json({ data });
  }
);

proxyRoutes.get('/:id/additional-secure-links', requireScopeForResource('proxy:view', 'id'), async (c) => {
  const data = await container.resolve(ProxyService).listAdditionalSecureLinks(c.req.param('id')!);
  return c.json({ data });
});

proxyRoutes.post('/:id/additional-secure-links', requireScopeForResource('proxy:edit', 'id'), async (c) => {
  const data = await container
    .resolve(ProxyService)
    .createAdditionalSecureLink(
      c.req.param('id')!,
      CreateAdditionalSecureLinkSchema.parse(await c.req.json()),
      c.get('user')!.id,
      c.get('effectiveScopes') || []
    );
  return c.json({ data }, 201);
});

proxyRoutes.post(
  '/:id/additional-secure-links/:bindingId/retry',
  requireScopeForResource('proxy:edit', 'id'),
  async (c) => {
    const data = await container
      .resolve(ProxyService)
      .retryAdditionalSecureLink(
        c.req.param('id')!,
        c.req.param('bindingId')!,
        c.get('user')!.id,
        c.get('effectiveScopes') || []
      );
    return c.json({ data });
  }
);

proxyRoutes.delete(
  '/:id/additional-secure-links/:bindingId',
  requireScopeForResource('proxy:edit', 'id'),
  async (c) => {
    await container
      .resolve(ProxyService)
      .deleteAdditionalSecureLink(c.req.param('id')!, c.req.param('bindingId')!, c.get('user')!.id);
    return c.body(null, 204);
  }
);

proxyRoutes.openapi(
  { ...listAdditionalRoutesRoute, middleware: requireScopeForResource('proxy:view', 'id') },
  async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const rows = await container.resolve(AdditionalRouteService).list(c.req.param('id')!);
    return c.json({ data: rows.map((row) => serializeAdditionalRoute(row as Record<string, unknown>, scopes)) });
  }
);

proxyRoutes.openapi(
  { ...createAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const input = CreateAdditionalRouteSchema.parse(await c.req.json());
    if (input.advancedConfig !== undefined && !hasScope(scopes, `proxy:advanced:${c.req.param('id')!}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Advanced proxy configuration scope is required', {
        requiredScope: `proxy:advanced:${c.req.param('id')!}`,
      });
    }
    if (input.targetKind === 'pages') {
      await container.resolve(LicensePolicyService).requireFeature('pages');
      await container.resolve(PageProfileService).requireEnabled();
    }
    const row = await container.resolve(AdditionalRouteService).create(c.req.param('id')!, input, user.id, scopes);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) }, 201);
  }
);

proxyRoutes.openapi(
  { ...getAdditionalRouteRoute, middleware: requireScopeForResource('proxy:view', 'id') },
  async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const row = await container.resolve(AdditionalRouteService).get(c.req.param('id')!, c.req.param('routeId')!);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) });
  }
);

proxyRoutes.openapi(
  { ...updateAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const input = UpdateAdditionalRouteSchema.parse(await c.req.json());
    if (input.targetKind === 'pages' || input.pageProjectId != null || input.pageTagId != null) {
      await container.resolve(LicensePolicyService).requireFeature('pages');
      await container.resolve(PageProfileService).requireEnabled();
    }
    if (input.advancedConfig !== undefined && !hasScope(scopes, `proxy:advanced:${c.req.param('id')!}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Advanced proxy configuration scope is required', {
        requiredScope: `proxy:advanced:${c.req.param('id')!}`,
      });
    }
    const row = await container
      .resolve(AdditionalRouteService)
      .update(c.req.param('id')!, c.req.param('routeId')!, input, user.id, scopes);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) });
  }
);

proxyRoutes.openapi(
  { ...retryAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const existing = await container.resolve(AdditionalRouteService).get(c.req.param('id')!, c.req.param('routeId')!);
    if (existing.targetKind === 'pages') {
      await container.resolve(LicensePolicyService).requireFeature('pages');
    }
    const row = await container
      .resolve(AdditionalRouteService)
      .retry(c.req.param('id')!, c.req.param('routeId')!, user.id, scopes);
    const view = await container.resolve(AdditionalRouteService).present(row);
    return c.json({ data: serializeAdditionalRoute(view as Record<string, unknown>, scopes) });
  }
);

proxyRoutes.openapi(
  { ...deleteAdditionalRouteRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    await container
      .resolve(AdditionalRouteService)
      .remove(c.req.param('id')!, c.req.param('routeId')!, c.get('user')!.id);
    return c.body(null, 204);
  }
);

proxyRoutes.openapi(createProxyHostRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const input = CreateProxyHostSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  if (input.upstreamKind === 'pages') {
    await container.resolve(LicensePolicyService).requireFeature('pages');
    await container.resolve(PageProfileService).requireEnabled();
  }
  if (!hasScopeForCreation(scopes, 'proxy:create', input.folderId, input.nodeId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected destination');
  }
  await container.resolve(FolderService).assertFolderExists(input.folderId);
  if (input.advancedConfig && !hasScope(scopes, 'proxy:advanced')) {
    throw new AppError(403, 'FORBIDDEN', 'Advanced config requires proxy:advanced scope');
  }
  if (
    input.upstreamKind === 'pages' &&
    (!input.pageProjectId || !hasScope(scopes, `pages:view:${input.pageProjectId}`))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
  const bypassAdvancedValidation = hasScope(scopes, 'proxy:advanced:bypass');
  const bypassRawValidation = hasScope(scopes, 'proxy:raw:bypass');
  if (requestTogglesRawProxyConfig(input) && !hasScope(scopes, 'proxy:raw:toggle')) {
    throw new AppError(403, 'FORBIDDEN', 'Enabling raw mode requires proxy:raw:toggle scope');
  }
  if (input.rawConfig !== undefined && !hasScope(scopes, 'proxy:raw:write')) {
    throw new AppError(403, 'FORBIDDEN', 'Writing raw config requires proxy:raw:write scope');
  }
  await proxyService.assertReferenceAccess(scopes, input);
  const host = await proxyService.createProxyHost(input, user.id, {
    bypassAdvancedValidation,
    bypassRawValidation,
    actorScopes: scopes,
  });
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, (host as any).id) }, 201);
});

proxyRoutes.openapi(updateProxyHostRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const input = UpdateProxyHostSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  const existing = await proxyService.getProxyHost(id);
  // Moving a route between folders goes through the same checks as the move
  // endpoint. An unchanged folderId (full-object PUT) is ignored.
  if (input.folderId !== undefined) {
    if ((input.folderId ?? null) === ((existing as { folderId?: string | null }).folderId ?? null)) {
      delete input.folderId;
    } else {
      if (!hasScope(scopes, 'proxy:folders:manage')) {
        throw new AppError(403, 'FORBIDDEN', 'Moving a route requires proxy:folders:manage scope', {
          requiredScope: 'proxy:folders:manage',
        });
      }
      if (!hasScope(scopes, `proxy:edit:${id}`) || !hasScopeForCreation(scopes, 'proxy:edit', input.folderId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
      }
      await container.resolve(FolderService).assertFolderExists(input.folderId ?? undefined);
    }
  }
  if (input.upstreamKind === 'pages' || input.pageProjectId != null || input.pageTagId != null) {
    await container.resolve(LicensePolicyService).requireFeature('pages');
    await container.resolve(PageProfileService).requireEnabled();
  }
  const existingPageTarget = existing.pageTarget as { projectId?: unknown } | null | undefined;
  if (
    existing.upstreamKind === 'pages' &&
    (typeof existingPageTarget?.projectId !== 'string' ||
      !hasScope(scopes, `pages:view:${existingPageTarget.projectId}`))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
  const rawOnlyUpdate = requestOnlyUpdatesRawProxyConfig(input);
  if (!rawOnlyUpdate && !hasScope(scopes, `proxy:edit:${id}`)) {
    throw new AppError(403, 'FORBIDDEN', 'Editing proxy host settings requires proxy:edit scope');
  }
  if (
    (input.pageProjectId !== undefined || input.pageTagId !== undefined) &&
    (!input.pageProjectId || !input.pageTagId || !hasScope(scopes, `pages:view:${input.pageProjectId}`))
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
  }
  // Setting or clearing the advanced config both need the scope; echoing the
  // stored value (or the redacted null a scope-less viewer received) does not.
  if (
    input.advancedConfig !== undefined &&
    !hasScope(scopes, `proxy:advanced:${id}`) &&
    normalizedAdvancedConfig(input.advancedConfig) !== normalizedAdvancedConfig(existing.advancedConfig)
  ) {
    if (normalizedAdvancedConfig(input.advancedConfig) === null) {
      delete input.advancedConfig;
    } else {
      throw new AppError(403, 'FORBIDDEN', 'Advanced config requires proxy:advanced scope');
    }
  }
  const bypassAdvancedValidation = hasScope(scopes, `proxy:advanced:bypass:${id}`);
  const bypassRawValidation = hasScope(scopes, `proxy:raw:bypass:${id}`);
  if (requestTogglesRawProxyConfig(input, existing)) {
    if (!hasScope(scopes, `proxy:raw:toggle:${id}`) && !hasScope(scopes, 'proxy:raw:toggle')) {
      throw new AppError(403, 'FORBIDDEN', 'Toggling raw mode requires proxy:raw:toggle scope');
    }
  }
  if (input.rawConfig !== undefined) {
    if (!hasScope(scopes, `proxy:raw:write:${id}`) && !hasScope(scopes, 'proxy:raw:write')) {
      throw new AppError(403, 'FORBIDDEN', 'Writing raw config requires proxy:raw:write scope');
    }
  }
  if (input.nodeId && input.nodeId !== existing.nodeId && !hasScopeForResource(scopes, 'proxy:create', input.nodeId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:create:${input.nodeId}`);
  }
  await proxyService.assertReferenceAccess(scopes, input, existing);
  const host = await proxyService.updateProxyHost(id, input, user.id, {
    bypassAdvancedValidation,
    bypassRawValidation,
    actorScopes: scopes,
  });
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
});

proxyRoutes.openapi(
  { ...deleteProxyHostRoute, middleware: requireScopeForResource('proxy:delete', 'id') },
  async (c) => {
    const proxyService = container.resolve(ProxyService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    await proxyService.deleteProxyHost(id, user.id);
    return c.body(null, 204);
  }
);

proxyRoutes.openapi({ ...toggleProxyHostRoute, middleware: requireScopeForResource('proxy:edit', 'id') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const { enabled } = ToggleProxyHostSchema.parse(await c.req.json());
  const host = await proxyService.toggleProxyHost(id, enabled, user.id);
  const scopes = c.get('effectiveScopes') || [];
  return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
});

proxyRoutes.openapi(
  { ...toggleProxyMaintenanceRoute, middleware: requireScopeForResource('proxy:edit', 'id') },
  async (c) => {
    const proxyService = container.resolve(ProxyService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const { enabled } = ToggleProxyMaintenanceSchema.parse(await c.req.json());
    const host = await proxyService.toggleMaintenance(id, enabled, user.id);
    const scopes = c.get('effectiveScopes') || [];
    return c.json({ data: serializeProxyHostForBrowser(host as any, scopes, id) });
  }
);

proxyRoutes.openapi({ ...resyncProxyHostTlsRoute, middleware: requireScope('admin:update') }, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const user = c.get('user')!;
  const result = await proxyService.resyncTlsHost(c.req.param('id')!, user.id);
  return c.json({ data: result });
});

proxyRoutes.openapi(renderedProxyConfigRoute, async (c) => {
  const id = c.req.param('id')!;
  const scopes = c.get('effectiveScopes') || [];
  if (!scopes.includes(`proxy:raw:read:${id}`) && !scopes.includes('proxy:raw:read')) {
    return c.json({ message: `Missing required scope: proxy:raw:read:${id}` }, 403);
  }
  const proxyService = container.resolve(ProxyService);
  const rendered = await proxyService.getRenderedConfig(id);
  return c.json({ data: { rendered } });
});

proxyRoutes.openapi(validateProxyConfigRoute, async (c) => {
  const proxyService = container.resolve(ProxyService);
  const scopes = c.get('effectiveScopes') || [];
  const { snippet, mode, proxyHostId } = ValidateAdvancedConfigSchema.parse(await c.req.json());

  const requiredScope =
    mode === 'raw'
      ? proxyHostId
        ? `proxy:raw:write:${proxyHostId}`
        : 'proxy:raw:write'
      : proxyHostId
        ? `proxy:advanced:${proxyHostId}`
        : 'proxy:advanced';
  if (!hasScope(scopes, requiredScope)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      mode === 'raw'
        ? 'Raw config validation requires proxy:raw:write scope'
        : 'Advanced config requires proxy:advanced scope'
    );
  }

  const bypassAdvancedScope = proxyHostId ? `proxy:advanced:bypass:${proxyHostId}` : 'proxy:advanced:bypass';
  const bypassRawScope = proxyHostId ? `proxy:raw:bypass:${proxyHostId}` : 'proxy:raw:bypass';
  const result =
    mode === 'advanced'
      ? await proxyService.validateAdvancedConfig(
          snippet,
          false,
          hasScope(scopes, bypassAdvancedScope),
          false,
          proxyHostId
        )
      : await proxyService.validateAdvancedConfig(snippet, true, false, hasScope(scopes, bypassRawScope));
  return c.json({ data: result });
});
