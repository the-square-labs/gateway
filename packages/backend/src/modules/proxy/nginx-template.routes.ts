import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { nginxTemplateFolderRouteDocs } from '@/modules/resource-folders/resource-folder.docs.js';
import { registerResourceFolderRoutes } from '@/modules/resource-folders/resource-folder.routes.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { AppEnv } from '@/types.js';
import {
  cloneNginxTemplateRoute,
  createNginxTemplateRoute,
  deleteNginxTemplateRoute,
  getNginxTemplateRoute,
  listNginxTemplatesRoute,
  previewNginxTemplateRoute,
  testNginxTemplateRoute,
  updateNginxTemplateRoute,
} from './nginx-template.docs.js';
import {
  CreateNginxTemplateSchema,
  PreviewNginxTemplateSchema,
  UpdateNginxTemplateSchema,
} from './nginx-template.schemas.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { NginxTemplateFolderService } from './nginx-template-folders.service.js';
import { renderTemplatePreviewForHost, testTemplateContent } from './nginx-template-preview.js';

export const nginxTemplateRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

nginxTemplateRoutes.use('*', authMiddleware);

// Folders of custom templates, registered before the `/{id}` routes. Placing a template needs
// proxy:templates:manage on it and on the destination (broadly or as a folder grant).
registerResourceFolderRoutes(nginxTemplateRoutes, {
  docs: nginxTemplateFolderRouteDocs,
  service: () => container.resolve(NginxTemplateFolderService),
  manageScope: 'proxy:templates:folders:manage',
  viewScope: 'proxy:templates:view',
  listScopes: ['proxy:templates:manage'],
  folderGrantScopes: ['proxy:templates:view', 'proxy:templates:manage'],
  placementScope: 'proxy:templates:manage',
});

// Template content is written under proxy:templates:manage (manual approval for
// programmatic callers). Broad manage creates templates anywhere, `manage:folder/<id>` in that
// folder; `manage:<id>` edits,
// tests and deletes that template. The service checks the content against the raw config deny-list
// unless the caller holds broad proxy:unrestricted, and limits a non-broad manager to templates
// whose routes they may edit.
// List all nginx templates
nginxTemplateRoutes.openapi(
  { ...listNginxTemplatesRoute, middleware: requireScopeBase('proxy:templates:view') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const scopes = c.get('effectiveScopes') || [];
    const templates = await service.listTemplates(
      hasScope(scopes, 'proxy:templates:view')
        ? undefined
        : { allowedIds: getResourceScopedIds(scopes, 'proxy:templates:view') }
    );
    return c.json({ data: templates });
  }
);

// Get single template
nginxTemplateRoutes.openapi(
  { ...getNginxTemplateRoute, middleware: requireScopeForResource('proxy:templates:view', 'id') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const id = c.req.param('id')!;
    const template = await service.getTemplate(id);
    return c.json({ data: template });
  }
);

// Create template
nginxTemplateRoutes.openapi(
  { ...createNginxTemplateRoute, middleware: requireScopeBase('proxy:templates:manage') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = CreateNginxTemplateSchema.parse(body);
    // Broad manage creates anywhere; `manage:folder/<id>` creates in that folder only.
    await container
      .resolve(NginxTemplateFolderService)
      .assertCreateFolder(c.get('effectiveScopes') ?? [], input.folderId);
    const template = await service.createTemplate(input, user.id, c.get('effectiveScopes') ?? []);
    return c.json({ data: template }, 201);
  }
);

// Update template
nginxTemplateRoutes.openapi(
  { ...updateNginxTemplateRoute, middleware: requireScopeForResource('proxy:templates:manage', 'id') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const body = await c.req.json();
    const input = UpdateNginxTemplateSchema.parse(body);
    const template = await service.updateTemplate(id, input, user.id, c.get('effectiveScopes') ?? []);
    return c.json({ data: template });
  }
);

// Delete template
nginxTemplateRoutes.openapi(
  { ...deleteNginxTemplateRoute, middleware: requireScopeForResource('proxy:templates:manage', 'id') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    await service.deleteTemplate(id, user.id);
    return c.body(null, 204);
  }
);

// Clone template: reads the source, creates a new template.
nginxTemplateRoutes.openapi(
  { ...cloneNginxTemplateRoute, middleware: requireScopeForResource('proxy:templates:view', 'id') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    if (!hasScope(scopes, 'proxy:templates:manage')) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: proxy:templates:manage', {
        requiredScope: 'proxy:templates:manage',
      });
    }
    const id = c.req.param('id')!;
    const clone = await service.cloneTemplate(id, user.id, scopes);
    return c.json({ data: clone }, 201);
  }
);

// Preview template with sample or real host data
nginxTemplateRoutes.openapi(
  { ...previewNginxTemplateRoute, middleware: requireScopeBase('proxy:templates:view') },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const body = await c.req.json();
    const input = PreviewNginxTemplateSchema.parse(body);

    let rendered: string;
    if (input.hostId) {
      const scopes = c.get('effectiveScopes') || [];
      if (!hasScope(scopes, `proxy:view:${input.hostId}`)) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:view:${input.hostId}`);
      }
      const canPreviewAdvancedConfig = hasScope(scopes, `proxy:advanced:${input.hostId}`);
      // Render with real host data — need ProxyService to resolve host config
      const { ProxyService } = await import('./proxy.service.js');
      const proxyService = container.resolve(ProxyService);
      const host = await proxyService.getProxyHost(input.hostId);
      rendered = renderTemplatePreviewForHost(service, input.content, host, canPreviewAdvancedConfig);
    } else {
      rendered = service.previewWithSampleData(input.content);
    }

    return c.json({ data: { rendered } });
  }
);

// Test template — render + send to daemon for nginx -t (test_only mode)
nginxTemplateRoutes.openapi(
  {
    ...testNginxTemplateRoute,
    middleware: requireScopeBase('proxy:templates:manage'),
  },
  async (c) => {
    const service = container.resolve(NginxTemplateService);
    const nodeDispatch = container.resolve(NodeDispatchService);
    const body = await c.req.json();
    const input = PreviewNginxTemplateSchema.parse(body);
    const scopes = c.get('effectiveScopes') || [];
    const requiredScope = input.templateId ? `proxy:templates:manage:${input.templateId}` : 'proxy:templates:manage';
    if (!hasScope(scopes, requiredScope)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`, { requiredScope });
    }

    return c.json({ data: await testTemplateContent(service, nodeDispatch, input.content, scopes) });
  }
);
