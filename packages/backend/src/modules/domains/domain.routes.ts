import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import type { AppEnv } from '@/types.js';
import {
  checkDomainDnsRoute,
  createDomainFolderRoute,
  createDomainRoute,
  deleteDomainFolderRoute,
  deleteDomainRoute,
  getDomainRoute,
  issueDomainCertificateRoute,
  listDomainFoldersRoute,
  listDomainsRoute,
  moveDomainFolderRoute,
  moveDomainsToFolderRoute,
  previewDomainRoute,
  reorderDomainFoldersRoute,
  reorderDomainsRoute,
  searchDomainsRoute,
  updateDomainFolderRoute,
  updateDomainRoute,
} from './domain.docs.js';
import {
  CreateDomainSchema,
  DeleteDomainSchema,
  DomainListQuerySchema,
  PreviewDomainSchema,
  UpdateDomainSchema,
} from './domain.schemas.js';
import { DomainsService } from './domain.service.js';

export const domainRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

domainRoutes.use('*', authMiddleware);

domainRoutes.openapi({ ...listDomainFoldersRoute, middleware: requireScope('domains:view') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const data = await service.getFolderTree({
    includeAllFolders: hasScope(c.get('effectiveScopes') || [], 'domains:folders:manage'),
  });
  return c.json({ data });
});

domainRoutes.openapi({ ...createDomainFolderRoute, middleware: requireScope('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const user = c.get('user')!;
  const input = CreateResourceFolderSchema.parse(await c.req.json());
  const data = await service.createFolder(input, user.id);
  return c.json({ data }, 201);
});

domainRoutes.openapi(
  { ...reorderDomainFoldersRoute, middleware: requireScope('domains:folders:manage') },
  async (c) => {
    const service = container.resolve(DomainFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

domainRoutes.openapi({ ...moveDomainsToFolderRoute, middleware: requireScope('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const user = c.get('user')!;
  const input = MoveResourcesToFolderSchema.parse(await c.req.json());
  await service.moveResourcesToFolder(input, user.id);
  return c.json({ success: true });
});

domainRoutes.openapi({ ...reorderDomainsRoute, middleware: requireScope('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const input = ReorderResourcesSchema.parse(await c.req.json());
  await service.reorderResources(input);
  return c.json({ success: true });
});

domainRoutes.openapi({ ...updateDomainFolderRoute, middleware: requireScope('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const user = c.get('user')!;
  const input = UpdateResourceFolderSchema.parse(await c.req.json());
  const data = await service.updateFolder(c.req.param('id')!, input, user.id);
  return c.json({ data });
});

domainRoutes.openapi({ ...moveDomainFolderRoute, middleware: requireScope('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const user = c.get('user')!;
  const input = MoveResourceFolderSchema.parse(await c.req.json());
  const data = await service.moveFolder(c.req.param('id')!, input, user.id);
  return c.json({ data });
});

domainRoutes.openapi({ ...deleteDomainFolderRoute, middleware: requireScope('domains:folders:manage') }, async (c) => {
  const service = container.resolve(DomainFolderService);
  const user = c.get('user')!;
  await service.deleteFolder(c.req.param('id')!, user.id);
  return c.json({ success: true });
});

// List domains (paginated)
domainRoutes.openapi({ ...listDomainsRoute, middleware: requireScope('domains:view') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  const query = DomainListQuerySchema.parse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    search: c.req.query('search'),
    dnsStatus: c.req.query('dnsStatus'),
  });
  const result = await domainsService.listDomains(query);
  return c.json(result);
});

// Autocomplete search (must be before /:id)
domainRoutes.openapi({ ...searchDomainsRoute, middleware: requireScope('domains:view') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  const q = c.req.query('q') || '';
  const results = await domainsService.searchDomains(q);
  return c.json({ data: results });
});

// Preview domain DNS (must be before /:id)
domainRoutes.openapi({ ...previewDomainRoute, middleware: requireScope('domains:create') }, async (c) => {
  const body = await c.req.json();
  const input = PreviewDomainSchema.parse(body);
  const domainsService = container.resolve(DomainsService);
  try {
    const preview = await domainsService.previewDomain(input);
    return c.json({ data: preview });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to preview domain' }, 400);
  }
});

// Get domain detail with usage
domainRoutes.openapi({ ...getDomainRoute, middleware: requireScope('domains:view') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  try {
    const domain = await domainsService.getDomain(c.req.param('id')!);
    return c.json({ data: domain });
  } catch {
    return c.json({ code: 'NOT_FOUND', message: 'Domain not found' }, 404);
  }
});

// Create domain
domainRoutes.openapi({ ...createDomainRoute, middleware: requireScope('domains:create') }, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = CreateDomainSchema.parse(body);
  const domainsService = container.resolve(DomainsService);
  try {
    const domain = await domainsService.createDomain(input, user.id);
    return c.json({ data: domain }, 201);
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    const msg = err instanceof Error ? err.message : 'Failed to create domain';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return c.json({ code: 'DUPLICATE', message: 'Domain already exists' }, 409);
    }
    return c.json({ code: 'ERROR', message: msg }, 400);
  }
});

// Update domain
domainRoutes.openapi({ ...updateDomainRoute, middleware: requireScope('domains:edit') }, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = UpdateDomainSchema.parse(body);
  const domainsService = container.resolve(DomainsService);
  try {
    const domain = await domainsService.updateDomain(c.req.param('id')!, input, user.id);
    return c.json({ data: domain });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to update domain' }, 400);
  }
});

// Delete domain
domainRoutes.openapi({ ...deleteDomainRoute, middleware: requireScope('domains:delete') }, async (c) => {
  const user = c.get('user')!;
  const domainsService = container.resolve(DomainsService);
  try {
    const rawBody = await c.req.text();
    const input = rawBody ? DeleteDomainSchema.parse(JSON.parse(rawBody)) : {};
    await domainsService.deleteDomain(c.req.param('id')!, user.id, input);
    return c.json({ data: { success: true } });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, details: err.details }, err.statusCode as never);
    }
    if (err instanceof SyntaxError) {
      return c.json({ code: 'BAD_REQUEST', message: 'Malformed JSON in request body' }, 400);
    }
    return c.json({ code: 'ERROR', message: err instanceof Error ? err.message : 'Failed to delete domain' }, 400);
  }
});

// Manual DNS check
domainRoutes.openapi({ ...checkDomainDnsRoute, middleware: requireScope('domains:edit') }, async (c) => {
  const domainsService = container.resolve(DomainsService);
  try {
    const domain = await domainsService.checkDns(c.req.param('id')!);
    return c.json({ data: domain });
  } catch {
    return c.json({ code: 'NOT_FOUND', message: 'Domain not found' }, 404);
  }
});

// Issue ACME cert for domain
domainRoutes.openapi({ ...issueDomainCertificateRoute, middleware: requireScope('domains:edit') }, async (c) => {
  const user = c.get('user')!;
  const domainsService = container.resolve(DomainsService);
  const sslService = container.resolve(SSLService);
  if (!hasScope(c.get('effectiveScopes') || [], 'ssl:cert:issue')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: ssl:cert:issue');
  }

  let domainRow: Awaited<ReturnType<DomainsService['getDomain']>> | undefined;
  try {
    domainRow = await domainsService.getDomain(c.req.param('id')!);
  } catch {
    return c.json({ code: 'NOT_FOUND', message: 'Domain not found' }, 404);
  }

  try {
    const cert = await sslService.requestACMECert(
      {
        domains: [domainRow.domain],
        challengeType: 'http-01',
        provider: 'letsencrypt',
        autoRenew: true,
      },
      user.id
    );
    return c.json({ data: cert }, 201);
  } catch (err) {
    return c.json({ code: 'CERT_ERROR', message: err instanceof Error ? err.message : 'Failed to issue cert' }, 400);
  }
});
