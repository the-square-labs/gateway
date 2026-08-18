import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const PROJECT_1 = '11111111-1111-4111-8111-111111111111';
const PROJECT_2 = '22222222-2222-4222-8222-222222222222';
const FOLDER_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => {
  const pageViewImplications = [
    'pages:edit',
    'pages:delete',
    'pages:deploy',
    'pages:deployments:manage',
    'pages:tags:manage',
    'pages:tokens:manage',
  ];
  const grants = (scopes: string[], required: string): boolean => {
    if (scopes.includes(required)) return true;
    const projectId = required.startsWith('pages:view:') ? required.slice('pages:view:'.length) : null;
    if (required === 'pages:view') return pageViewImplications.some((scope) => scopes.includes(scope));
    if (projectId) {
      return (
        scopes.includes('pages:view') ||
        pageViewImplications.some((scope) => scopes.includes(scope) || scopes.includes(`${scope}:${projectId}`))
      );
    }
    return false;
  };
  const grantsBase = (scopes: string[], base: string): boolean => {
    if (grants(scopes, base) || scopes.some((scope) => scope.startsWith(`${base}:`))) return true;
    return base === 'pages:view' && pageViewImplications.some((scope) => scopes.some((item) => item.startsWith(scope)));
  };
  return {
    scopes: [] as string[],
    grants,
    grantsBase,
    projectService: {
      list: vi.fn(),
      get: vi.fn(),
      getBySlug: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    folderService: {
      getFolderTree: vi.fn(),
      createFolder: vi.fn(),
      reorderFolders: vi.fn(),
      moveResourcesToFolder: vi.fn(),
      reorderResources: vi.fn(),
      updateFolder: vi.fn(),
      moveFolder: vi.fn(),
      deleteFolder: vi.fn(),
    },
    licensePolicy: { requireFeature: vi.fn() },
  };
});

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      if (token?.name === 'LicensePolicyService') return mocks.licensePolicy;
      return token?.name === 'PageProjectFolderService' ? mocks.folderService : mocks.projectService;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', email: 'operator@example.test' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScope: (scope: string) => async (c: any, next: () => Promise<void>) => {
    if (!mocks.grants(mocks.scopes, scope)) return c.json({ code: 'FORBIDDEN', message: 'Forbidden' }, 403);
    await next();
  },
  requireScopeBase: (scope: string) => async (c: any, next: () => Promise<void>) => {
    if (!mocks.grantsBase(mocks.scopes, scope)) return c.json({ code: 'FORBIDDEN', message: 'Forbidden' }, 403);
    await next();
  },
  requireAnyScopeBase:
    (...scopes: string[]) =>
    async (c: any, next: () => Promise<void>) => {
      if (!scopes.some((scope) => mocks.grantsBase(mocks.scopes, scope))) {
        return c.json({ code: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }
      await next();
    },
  requireScopeForResource: (scope: string, param: string) => async (c: any, next: () => Promise<void>) => {
    if (!mocks.grants(mocks.scopes, scope) && !mocks.grants(mocks.scopes, `${scope}:${c.req.param(param)}`)) {
      return c.json({ code: 'FORBIDDEN', message: 'Forbidden' }, 403);
    }
    await next();
  },
}));

import { pageProjectRoutes } from './page-project.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', pageProjectRoutes);
  return app;
}

function request(method: string, path: string, body?: unknown) {
  return createApp().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Page Project routes authorization', () => {
  beforeEach(() => {
    mocks.scopes = [];
    vi.clearAllMocks();
    mocks.projectService.list.mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
    mocks.projectService.get.mockResolvedValue({ id: PROJECT_1, name: 'Docs' });
    mocks.projectService.getBySlug.mockResolvedValue({ id: PROJECT_1, name: 'Docs', slug: 'docs' });
    mocks.projectService.create.mockResolvedValue({ id: PROJECT_1, name: 'Docs' });
    mocks.projectService.update.mockResolvedValue({ id: PROJECT_1, name: 'Docs 2' });
    mocks.folderService.getFolderTree.mockResolvedValue([]);
  });

  it('filters Project lists from any resource-qualified Pages read implication', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`, `pages:edit:${PROJECT_2}`];

    const response = await request('GET', '/');

    expect(response.status).toBe(200);
    expect(mocks.projectService.list).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }), {
      allowedIds: [PROJECT_1, PROJECT_2],
    });
  });

  it('prevents resource-qualified viewers from loading unrelated Projects', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`];

    expect((await request('GET', `/${PROJECT_1}`)).status).toBe(200);
    expect((await request('GET', `/${PROJECT_2}`)).status).toBe(403);
    expect(mocks.projectService.get).toHaveBeenCalledTimes(1);
  });

  it('resolves canonical slugs without bypassing Project-scoped access', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`];

    expect((await request('GET', '/by-slug/docs')).status).toBe(200);
    mocks.projectService.getBySlug.mockResolvedValueOnce({ id: PROJECT_2, name: 'Other', slug: 'other' });
    expect((await request('GET', '/by-slug/other')).status).toBe(403);
  });

  it('requires folder management when creating a Project inside a folder', async () => {
    mocks.scopes = ['pages:create'];

    const denied = await request('POST', '/', { name: 'Docs', nodeId: PROJECT_2, folderId: FOLDER_ID });
    expect(denied.status).toBe(403);
    expect(mocks.projectService.create).not.toHaveBeenCalled();

    mocks.scopes = ['pages:create', 'pages:folders:manage'];
    const allowed = await request('POST', '/', { name: 'Docs', nodeId: PROJECT_2, folderId: FOLDER_ID });
    expect(allowed.status).toBe(201);
    expect(mocks.projectService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Docs', folderId: FOLDER_ID }),
      'user-1'
    );
  });

  it('requires pages:edit for every Project in a bulk folder move', async () => {
    mocks.scopes = ['pages:folders:manage', `pages:edit:${PROJECT_1}`];

    const denied = await request('POST', '/folders/move-projects', {
      ids: [PROJECT_1, PROJECT_2],
      folderId: null,
    });
    expect(denied.status).toBe(403);
    expect(mocks.folderService.moveResourcesToFolder).not.toHaveBeenCalled();

    mocks.scopes = ['pages:folders:manage', `pages:edit:${PROJECT_1}`, `pages:edit:${PROJECT_2}`];
    const allowed = await request('POST', '/folders/move-projects', {
      ids: [PROJECT_1, PROJECT_2],
      folderId: null,
    });
    expect(allowed.status).toBe(200);
    expect(mocks.folderService.moveResourcesToFolder).toHaveBeenCalledWith(
      { ids: [PROJECT_1, PROJECT_2], folderId: null },
      'user-1'
    );
  });

  it('returns only authorized folder branches for resource-qualified viewers', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`];

    expect((await request('GET', '/folders')).status).toBe(200);
    expect(mocks.folderService.getFolderTree).toHaveBeenCalledWith({ allowedResourceIds: [PROJECT_1] });

    mocks.scopes = ['pages:folders:manage'];
    expect((await request('GET', '/folders')).status).toBe(200);
    expect(mocks.folderService.getFolderTree).toHaveBeenLastCalledWith({ includeAllFolders: true });
  });
});
