import 'reflect-metadata';
// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { NginxTemplateFolderService } from './nginx-template-folders.service.js';

const scopes = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', scopes.current);
    await next();
  },
}));

const { nginxTemplateRoutes } = await import('./nginx-template.routes.js');

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';

function setup(granted: string[]) {
  scopes.current = granted;
  const service = {
    getFolderTree: vi.fn().mockResolvedValue([]),
    createFolder: vi.fn().mockResolvedValue({ id: FOLDER }),
    updateFolder: vi.fn().mockResolvedValue({ id: FOLDER }),
    moveFolder: vi.fn().mockResolvedValue({ id: FOLDER }),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    reorderFolders: vi.fn().mockResolvedValue(undefined),
    moveResourcesToFolder: vi.fn().mockResolvedValue(undefined),
    reorderResources: vi.fn().mockResolvedValue(undefined),
    // The real create rule, with the folder lookup stubbed.
    assertFolderExists: vi.fn().mockResolvedValue(undefined),
    assertCreateFolder: NginxTemplateFolderService.prototype.assertCreateFolder,
  };
  const templates = { createTemplate: vi.fn().mockResolvedValue({ id: TEMPLATE }) };
  container.registerInstance(NginxTemplateFolderService, service as unknown as NginxTemplateFolderService);
  container.registerInstance(NginxTemplateService, templates as unknown as NginxTemplateService);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/nginx-templates', nginxTemplateRoutes);
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api/nginx-templates${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { service, templates, call };
}

afterEach(() => {
  container.reset();
});

describe('nginx template folder routes', () => {
  it('lists folders for template viewers but changes them only with the folder scope', async () => {
    const { service, call } = setup(['proxy:templates:view']);

    expect((await call('/folders')).status).toBe(200);
    expect(service.getFolderTree).toHaveBeenCalledWith({ includeAllFolders: true });
    expect((await call('/folders', 'POST', { name: 'Security' })).status).toBe(403);
    expect(service.createFolder).not.toHaveBeenCalled();
  });

  it('moves a template only with proxy:templates:manage on it and on the destination', async () => {
    const move = { ids: [TEMPLATE], folderId: FOLDER };
    let routes = setup(['proxy:templates:folders:manage', `proxy:templates:manage:${TEMPLATE}`]);
    expect((await routes.call('/folders/move-templates', 'POST', move)).status).toBe(403);
    expect(routes.service.moveResourcesToFolder).not.toHaveBeenCalled();
    container.reset();

    routes = setup([
      'proxy:templates:folders:manage',
      `proxy:templates:manage:${TEMPLATE}`,
      `proxy:templates:manage:folder/${FOLDER}`,
    ]);
    expect((await routes.call('/folders/move-templates', 'POST', move)).status).toBe(200);
    expect(routes.service.moveResourcesToFolder).toHaveBeenCalledWith(move, 'user-1');
  });

  it('creates, renames, reorders, moves and deletes folders with the folder scope', async () => {
    const { service, call } = setup(['proxy:templates:folders:manage']);

    expect((await call('/folders', 'POST', { name: 'Security' })).status).toBe(201);
    expect((await call(`/folders/${FOLDER}`, 'PUT', { name: 'Hardened' })).status).toBe(200);
    expect((await call('/folders/reorder', 'PUT', { items: [{ id: FOLDER, sortOrder: 1 }] })).status).toBe(200);
    expect((await call(`/folders/${FOLDER}/move`, 'PUT', { parentId: null })).status).toBe(200);
    expect((await call(`/folders/${FOLDER}`, 'DELETE')).status).toBe(200);
    expect(service.createFolder).toHaveBeenCalledWith({ name: 'Security' }, 'user-1');
    expect(service.updateFolder).toHaveBeenCalledWith(FOLDER, { name: 'Hardened' }, 'user-1');
    expect(service.reorderFolders).toHaveBeenCalledWith({ items: [{ id: FOLDER, sortOrder: 1 }] });
    expect(service.moveFolder).toHaveBeenCalledWith(FOLDER, { parentId: null }, 'user-1', {
      scopes: ['proxy:templates:folders:manage'],
      editScope: 'proxy:templates:manage',
    });
    expect(service.deleteFolder).toHaveBeenCalledWith(FOLDER, 'user-1');
  });

  it('creates a template in a folder with proxy:templates:manage on that folder only', async () => {
    const template = { name: 'Geo', type: 'proxy', content: 'server {}' };
    const { templates, call } = setup([`proxy:templates:manage:folder/${FOLDER}`]);

    expect((await call('', 'POST', template)).status).toBe(403);
    expect((await call('', 'POST', { ...template, folderId: TEMPLATE })).status).toBe(403);
    expect(templates.createTemplate).not.toHaveBeenCalled();
    expect((await call('', 'POST', { ...template, folderId: FOLDER })).status).toBe(201);
    expect(templates.createTemplate).toHaveBeenCalledWith(expect.objectContaining({ folderId: FOLDER }), 'user-1');
  });
});
