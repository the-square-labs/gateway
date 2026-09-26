import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { accessListRoutes } from '@/modules/access-lists/access-list.routes.js';
import { AccessListService } from '@/modules/access-lists/access-list.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv, User } from '@/types.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER, resetIdempotencyStateForTests } from './idempotency.js';
import { MemoryIdempotencyRedis, registerIdempotencyRedis } from './idempotency.test-helpers.js';

const OWNER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: null,
  email: 'owner@example.com',
  name: 'Owner',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['acl:create', 'acl:view'],
  isBlocked: false,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/access-lists', accessListRoutes);
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

function createAccessList(app: Hono<AppEnv>, token: string, body: unknown, key?: string) {
  return app.request('/api/access-lists', {
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

beforeEach(() => {
  resetIdempotencyStateForTests();
  redis = new MemoryIdempotencyRedis();
  registerIdempotencyRedis(redis);
  let created = 0;
  create = vi.fn(async (input: { name: string }) => {
    created += 1;
    return { id: `acl-${created}`, name: input.name };
  });
  container.registerInstance(AccessListService, { create } as unknown as AccessListService);
  registerTokens({ gw_writer: ['acl:create'], gw_other: ['acl:create'], gw_reader: ['acl:view'] });
});

afterEach(() => {
  container.reset();
});

describe('Idempotency-Key on POST /api/access-lists', () => {
  it('creates one access list for a retried request and replays the original 201', async () => {
    const app = createApp();

    const first = await createAccessList(app, 'gw_writer', { name: 'office' }, 'acl-create-1');
    const firstBody = await first.json();
    const retry = await createAccessList(app, 'gw_writer', { name: 'office' }, 'acl-create-1');

    expect(first.status).toBe(201);
    expect(firstBody).toEqual({ data: { id: 'acl-1', name: 'office' } });
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await retry.json()).toEqual(firstBody);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects a different body under the same key and keeps tokens apart', async () => {
    const app = createApp();

    await createAccessList(app, 'gw_writer', { name: 'office' }, 'acl-create-2');
    const reused = await createAccessList(app, 'gw_writer', { name: 'lab' }, 'acl-create-2');
    const otherToken = await createAccessList(app, 'gw_other', { name: 'office' }, 'acl-create-2');

    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(otherToken.status).toBe(201);
    expect(otherToken.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(await otherToken.json()).toEqual({ data: { id: 'acl-2', name: 'office' } });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('stores validation errors but not authorization failures', async () => {
    const app = createApp();

    const invalid = await createAccessList(app, 'gw_writer', { name: '' }, 'acl-invalid');
    const invalidRetry = await createAccessList(app, 'gw_writer', { name: '' }, 'acl-invalid');
    expect(invalid.status).toBe(400);
    expect(invalidRetry.status).toBe(400);
    expect(invalidRetry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');

    const denied = await createAccessList(app, 'gw_reader', { name: 'office' }, 'acl-denied');
    expect(denied.status).toBe(403);
    registerTokens({ gw_reader: ['acl:create'] });
    const allowed = await createAccessList(app, 'gw_reader', { name: 'office' }, 'acl-denied');
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();

    const unauthenticated = await createAccessList(app, 'gw_unknown', { name: 'office' }, 'acl-denied');
    expect(unauthenticated.status).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
