import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_FOLDER_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  databaseService: { create: vi.fn() },
  managedDatabaseService: { create: vi.fn() },
  folderService: { assertFolderExists: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      if (token?.name === 'DatabaseConnectionService') return mocks.databaseService;
      if (token?.name === 'ManagedDatabaseService') return mocks.managedDatabaseService;
      if (token?.name === 'DatabaseFolderService') return mocks.folderService;
      return {};
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: () => async (_c: any, next: () => Promise<void>) => next(),
}));

import { databaseRoutes } from './databases.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', databaseRoutes);
  return app;
}

function createDatabase(folderId?: string) {
  return createApp().request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Redis',
      ...(folderId === undefined ? {} : { folderId }),
      type: 'redis',
      tags: [],
      config: { host: 'redis.example.test', port: 6379, password: 'secret', db: 0, tlsEnabled: false },
    }),
  });
}

describe('database create destination authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.folderService.assertFolderExists.mockResolvedValue(undefined);
    mocks.databaseService.create.mockResolvedValue({ id: 'database-1' });
  });

  it('allows the exact folder target and validates it before probing the database connection', async () => {
    mocks.scopes = [`databases:create:folder/${FOLDER_ID}`];

    const response = await createDatabase(FOLDER_ID);

    expect(response.status).toBe(201);
    expect(mocks.folderService.assertFolderExists).toHaveBeenCalledWith(FOLDER_ID);
    expect(mocks.databaseService.create).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: FOLDER_ID }),
      'user-1'
    );
  });

  it('does not allow a folder-only grant to create at root or in an unrelated folder', async () => {
    mocks.scopes = [`databases:create:folder/${FOLDER_ID}`];

    const root = await createDatabase();
    const unrelated = await createDatabase(OTHER_FOLDER_ID);

    expect(root.status).toBe(403);
    expect(unrelated.status).toBe(403);
    expect(mocks.folderService.assertFolderExists).not.toHaveBeenCalled();
    expect(mocks.databaseService.create).not.toHaveBeenCalled();
  });

  it('keeps broad creation access but blocks a missing destination before connection creation', async () => {
    mocks.scopes = ['databases:create'];
    mocks.folderService.assertFolderExists.mockRejectedValue(new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found'));

    const response = await createDatabase(FOLDER_ID);

    expect(response.status).toBe(404);
    expect(mocks.databaseService.create).not.toHaveBeenCalled();
  });
});
