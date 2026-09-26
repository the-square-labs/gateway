import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { folderRoutes } from '@/modules/proxy/folder.routes.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv, User } from '@/types.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER, resetIdempotencyStateForTests } from './idempotency.js';
import {
  MemoryIdempotencyRedis,
  registerIdempotencyRedis,
  registerIdempotencyRuntime,
} from './idempotency.test-helpers.js';

const OWNER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: null,
  email: 'owner@example.com',
  name: 'Owner',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['proxy:folders:manage', 'proxy:view'],
  isBlocked: false,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/proxy-host-folders', folderRoutes);
  return app;
}

function registerTokens(scopesByToken: Record<string, string[]>) {
  container.registerInstance(TokensService, {
    validateToken: vi.fn(async (raw: string) => {
      const scopes = scopesByToken[raw];
      return scopes ? { user: OWNER, scopes, tokenId: `id-${raw}`, tokenPrefix: raw.slice(0, 10) } : null;
    }),
  } as unknown as TokensService);
}

function createFolder(app: Hono<AppEnv>, token: string, body: unknown, key?: string) {
  return app.request('/api/proxy-host-folders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}),
    },
    body: JSON.stringify(body),
  });
}

let redis: MemoryIdempotencyRedis;
let create: ReturnType<typeof vi.fn>;
let auditLog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetIdempotencyStateForTests();
  redis = new MemoryIdempotencyRedis();
  registerIdempotencyRedis(redis);
  ({ auditLog } = registerIdempotencyRuntime());
  let created = 0;
  create = vi.fn(async (input: { name: string }) => {
    created += 1;
    return { id: `folder-${created}`, name: input.name };
  });
  container.registerInstance(FolderService, { createFolder: create } as unknown as FolderService);
  registerTokens({
    gw_writer: ['proxy:folders:manage'],
    gw_other: ['proxy:folders:manage'],
    gw_reader: ['proxy:view'],
  });
});

afterEach(() => {
  container.reset();
});

describe('Idempotency-Key on POST /api/proxy-host-folders', () => {
  it('creates one folder for a retried request and replays the original 201', async () => {
    const app = createApp();

    const first = await createFolder(app, 'gw_writer', { name: 'office' }, 'folder-create-1');
    const firstBody = await first.json();
    const retry = await createFolder(app, 'gw_writer', { name: 'office' }, 'folder-create-1');

    expect(first.status).toBe(201);
    expect(firstBody).toEqual({ data: { id: 'folder-1', name: 'office' } });
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await retry.json()).toEqual(firstBody);
    expect(create).toHaveBeenCalledTimes(1);
    expect(redis.dump()).not.toContain('office');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api.idempotency.replay',
        details: expect.objectContaining({ path: '/api/proxy-host-folders', tokenId: 'id-gw_writer' }),
      })
    );
  });

  it('replays nothing once the token scopes change', async () => {
    const app = createApp();

    await createFolder(app, 'gw_writer', { name: 'office' }, 'folder-create-scoped');
    registerTokens({ gw_writer: ['proxy:folders:manage', 'proxy:view'] });
    const afterScopeChange = await createFolder(app, 'gw_writer', { name: 'office' }, 'folder-create-scoped');

    expect(afterScopeChange.status).toBe(201);
    expect(afterScopeChange.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a different body under the same key and keeps tokens apart', async () => {
    const app = createApp();

    await createFolder(app, 'gw_writer', { name: 'office' }, 'folder-create-2');
    const reused = await createFolder(app, 'gw_writer', { name: 'lab' }, 'folder-create-2');
    const otherToken = await createFolder(app, 'gw_other', { name: 'office' }, 'folder-create-2');

    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(otherToken.status).toBe(201);
    expect(otherToken.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(await otherToken.json()).toEqual({ data: { id: 'folder-2', name: 'office' } });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('stores validation errors but not authorization failures', async () => {
    const app = createApp();

    const invalid = await createFolder(app, 'gw_writer', { name: '' }, 'folder-invalid');
    const invalidRetry = await createFolder(app, 'gw_writer', { name: '' }, 'folder-invalid');
    expect(invalid.status).toBe(400);
    expect(invalidRetry.status).toBe(400);
    expect(invalidRetry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');

    const denied = await createFolder(app, 'gw_reader', { name: 'office' }, 'folder-denied');
    expect(denied.status).toBe(403);
    registerTokens({ gw_reader: ['proxy:folders:manage'] });
    const allowed = await createFolder(app, 'gw_reader', { name: 'office' }, 'folder-denied');
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();

    const unauthenticated = await createFolder(app, 'gw_unknown', { name: 'office' }, 'folder-denied');
    expect(unauthenticated.status).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
