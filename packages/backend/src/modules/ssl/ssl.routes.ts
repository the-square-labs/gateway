import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import {
  authMiddleware,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
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
  cancelPendingAcmeCertificateRoute,
  createSslCertificateFolderRoute,
  deleteSslCertificateFolderRoute,
  deleteSslCertificateRoute,
  getSslCertificateRoute,
  linkInternalSslCertificateRoute,
  listSslCertificateFoldersRoute,
  listSslCertificatesRoute,
  moveSslCertificateFolderRoute,
  moveSslCertificatesToFolderRoute,
  renewSslCertificateRoute,
  reorderSslCertificateFoldersRoute,
  reorderSslCertificatesRoute,
  requestAcmeCertificateRoute,
  resyncSslCertificateDistributionRoute,
  setSslCertificateAutoRenewRoute,
  updateSslCertificateFolderRoute,
  uploadSslCertificateRoute,
  verifyDnsSslCertificateRoute,
} from './ssl.docs.js';
import {
  LinkInternalCertSchema,
  RequestACMECertSchema,
  SetSslAutoRenewSchema,
  SSLCertListQuerySchema,
  UploadCertSchema,
} from './ssl.schemas.js';
import { SSLService } from './ssl.service.js';
import { SSLCertificateFolderService } from './ssl-certificate-folders.service.js';

export const sslRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

sslRoutes.use('*', authMiddleware);

sslRoutes.openapi({ ...listSslCertificateFoldersRoute, middleware: requireScopeBase('ssl:cert:view') }, async (c) => {
  const service = container.resolve(SSLCertificateFolderService);
  const scopes = c.get('effectiveScopes') || [];
  const canManageFolders = hasScope(scopes, 'ssl:cert:folders:manage');
  const hasGlobalView = hasScope(scopes, 'ssl:cert:view');
  const data = await service.getFolderTree(
    canManageFolders || hasGlobalView
      ? { includeAllFolders: canManageFolders }
      : { allowedResourceIds: getResourceScopedIds(scopes, 'ssl:cert:view') }
  );
  return c.json({ data });
});

sslRoutes.openapi(
  { ...createSslCertificateFolderRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const data = await service.createFolder(CreateResourceFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ data }, 201);
  }
);

sslRoutes.openapi(
  { ...reorderSslCertificateFoldersRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    await service.reorderFolders(ReorderResourceFoldersSchema.parse(await c.req.json()));
    return c.json({ success: true });
  }
);

sslRoutes.openapi(
  { ...moveSslCertificatesToFolderRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    await service.moveResourcesToFolder(MoveResourcesToFolderSchema.parse(await c.req.json()), c.get('user')!.id);
    return c.json({ success: true });
  }
);

sslRoutes.openapi(
  { ...reorderSslCertificatesRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    await service.reorderResources(ReorderResourcesSchema.parse(await c.req.json()));
    return c.json({ success: true });
  }
);

sslRoutes.openapi(
  { ...updateSslCertificateFolderRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const data = await service.updateFolder(
      c.req.param('id')!,
      UpdateResourceFolderSchema.parse(await c.req.json()),
      c.get('user')!.id
    );
    return c.json({ data });
  }
);

sslRoutes.openapi(
  { ...moveSslCertificateFolderRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    const data = await service.moveFolder(
      c.req.param('id')!,
      MoveResourceFolderSchema.parse(await c.req.json()),
      c.get('user')!.id
    );
    return c.json({ data });
  }
);

sslRoutes.openapi(
  { ...deleteSslCertificateFolderRoute, middleware: requireScope('ssl:cert:folders:manage') },
  async (c) => {
    const service = container.resolve(SSLCertificateFolderService);
    await service.deleteFolder(c.req.param('id')!, c.get('user')!.id);
    return c.json({ success: true });
  }
);

// List SSL certificates (paginated, filterable)
sslRoutes.openapi({ ...listSslCertificatesRoute, middleware: requireScopeBase('ssl:cert:view') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const query = SSLCertListQuerySchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    type: c.req.query('type'),
    status: c.req.query('status'),
    search: c.req.query('search'),
    showSystem: c.req.query('showSystem'),
  });
  const scopes = c.get('effectiveScopes') || [];
  if (query.showSystem && !hasScope(scopes, 'admin:details:certificates')) {
    return c.json({ code: 'FORBIDDEN', message: 'Insufficient permissions' }, 403);
  }
  const result = await sslService.listCerts(
    query,
    hasScope(scopes, 'ssl:cert:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'ssl:cert:view') }
  );
  return c.json(result);
});

// Get SSL certificate detail
sslRoutes.openapi(
  { ...getSslCertificateRoute, middleware: requireScopeForResource('ssl:cert:view', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const id = c.req.param('id')!;
    const cert = await sslService.getCert(id);
    return c.json({ data: cert });
  }
);

// Request ACME certificate
sslRoutes.openapi({ ...requestAcmeCertificateRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = RequestACMECertSchema.parse(body);
  const result = await sslService.requestACMECert(input, user.id, user.email);
  return c.json({ data: result }, 201);
});

// Upload certificate
sslRoutes.openapi({ ...uploadSslCertificateRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = UploadCertSchema.parse(body);
  const cert = await sslService.uploadCert(input, user.id);
  return c.json({ data: cert }, 201);
});

// Link internal CA certificate
sslRoutes.openapi({ ...linkInternalSslCertificateRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = LinkInternalCertSchema.parse(body);
  const cert = await sslService.linkInternalCert(input, user.id);
  return c.json({ data: cert }, 201);
});

// Manual renew
sslRoutes.openapi({ ...renewSslCertificateRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const cert = await sslService.renewCert(id, user.id);
  return c.json({ data: cert });
});

sslRoutes.openapi({ ...setSslCertificateAutoRenewRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const input = SetSslAutoRenewSchema.parse(body);
  const cert = await sslService.setAutoRenew(id, input, user.id);
  return c.json({ data: cert });
});

// Complete DNS-01 verification
sslRoutes.openapi({ ...verifyDnsSslCertificateRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const cert = await sslService.completeDNS01Verification(id, user.id);
  return c.json({ data: cert });
});

sslRoutes.openapi({ ...cancelPendingAcmeCertificateRoute, middleware: requireScope('ssl:cert:issue') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  await sslService.cancelPendingAcmeIssue(c.req.param('id')!, user.id);
  return c.body(null, 204);
});

// Repair is an operator action and deliberately uses the existing global
// admin mutation permission rather than exposing certificate material.
sslRoutes.openapi({ ...resyncSslCertificateDistributionRoute, middleware: requireScope('admin:update') }, async (c) => {
  const sslService = container.resolve(SSLService);
  const user = c.get('user')!;
  const result = await sslService.resyncDistribution(c.req.param('id')!, user.id);
  return c.json({ data: result });
});

// Delete SSL certificate
sslRoutes.openapi(
  { ...deleteSslCertificateRoute, middleware: requireScopeForResource('ssl:cert:delete', 'id') },
  async (c) => {
    const sslService = container.resolve(SSLService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    await sslService.deleteCert(id, user.id);
    return c.body(null, 204);
  }
);
