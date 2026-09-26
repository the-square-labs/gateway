import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { AppEnv, User } from '@/types.js';
import {
  findSecretMaterial,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENT_CREATE_ROUTES,
  isIdempotencyEligibleRequest,
  resetIdempotencyStateForTests,
  runWithIdempotency,
} from './idempotency.js';
import {
  FailingIdempotencyRedis,
  MemoryIdempotencyRedis,
  registerIdempotencyRedis,
  registerIdempotencyRuntime,
} from './idempotency.test-helpers.js';

const idempotencyLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));

vi.mock('@/lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger.js')>();
  return {
    ...actual,
    createChildLogger: (context: string) =>
      context === 'Idempotency' ? idempotencyLogger : actual.createChildLogger(context),
  };
});

function user(id: string): User {
  return {
    id,
    oidcSubject: null,
    email: `${id}@example.com`,
    name: id,
    avatarUrl: null,
    groupId: 'group-1',
    groupName: 'admin',
    scopes: [],
    isBlocked: false,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Test routes opt in wholesale, except one that shows the default is off. */
const testEligible = (method: string, path: string) =>
  ['POST', 'PUT', 'PATCH'].includes(method) && path !== '/api/not-opted-in';

function createApp(eligible: (method: string, path: string) => boolean = testEligible) {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return calls[name]!;
  };
  const gates: { slow?: Deferred } = {};
  const app = new Hono<AppEnv>();

  // Stand-in for authMiddleware: the principal comes from test headers, then idempotency runs.
  app.use('/api/*', async (c, next) => {
    const token = c.req.header('x-test-token');
    const sessionUser = c.req.header('x-test-user');
    c.set('effectiveScopes', (c.req.header('x-test-scopes') ?? 'acl:create').split(','));
    if (token) {
      c.set('user', user('token-owner'));
      c.set('authType', 'api-token');
      c.set('authTokenId', token);
    } else if (sessionUser) {
      c.set('user', user(sessionUser));
      c.set('authType', 'session');
      c.set('sessionId', c.req.header('x-test-session') ?? `session-of-${sessionUser}`);
      const actor = c.req.header('x-test-impersonator');
      if (actor) c.set('impersonation', { actor: user(actor), subject: user(sessionUser), authorized: true });
    }
    return runWithIdempotency(c, next, eligible);
  });

  app.post('/api/things', async (c) => {
    const n = count('things');
    const body = await c.req.json();
    c.header('Location', `/api/things/thing-${n}`);
    c.header('X-Internal', 'not-replayed');
    return c.json({ data: { id: `thing-${n}`, ...body } }, 201);
  });
  app.patch('/api/things/:id', async (c) => {
    const n = count('patch');
    return c.json({ data: { id: c.req.param('id'), revision: n } });
  });
  app.post('/api/flaky', async (c) => {
    const n = count('flaky');
    if (n === 1) return c.json({ code: 'INTERNAL_ERROR', message: 'boom' }, 500);
    return c.json({ data: { attempt: n } }, 201);
  });
  app.post('/api/throws', async () => {
    count('throws');
    throw new Error('handler exploded');
  });
  app.post('/api/forbidden', async (c) => {
    const n = count('forbidden');
    return c.json({ code: 'FORBIDDEN', message: `denied ${n}` }, 403);
  });
  app.post('/api/conflict', async (c) => {
    const n = count('conflict');
    return c.json({ code: 'CONFLICT', message: `exists ${n}` }, 409);
  });
  app.post('/api/slow', async (c) => {
    const n = count('slow');
    await gates.slow?.promise;
    return c.json({ data: { attempt: n } }, 201);
  });
  app.post('/api/events', async (c) => {
    count('events');
    return c.body('data: hello\n\n', 200, { 'Content-Type': 'text/event-stream' });
  });
  app.post('/api/upload', async (c) => {
    count('upload');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ data: { bytes: bytes.byteLength } }, 201);
  });
  app.post('/api/not-opted-in', async (c) => {
    const n = count('notOptedIn');
    return c.json({ data: { attempt: n } }, 201);
  });
  app.post('/api/enroll', async (c) => {
    const n = count('enroll');
    c.header('Location', `/api/nodes/node-${n}`);
    return c.json({ data: { id: `node-${n}`, enrollmentToken: `enroll-secret-${n}` } }, 201);
  });
  app.post('/api/connection', async (c) => {
    const n = count('connection');
    return c.json({ data: { id: `db-${n}`, url: `postgres://app:hunter2-${n}@db:5432/app` } }, 201);
  });
  app.get('/api/things', async (c) => {
    const n = count('list');
    return c.json({ data: [], n });
  });
  app.onError((error, c) => c.json({ code: 'INTERNAL_ERROR', message: error.message }, 500));

  return { app, calls, gates };
}

function post(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-token': 'token-1', ...headers },
      body: JSON.stringify(body),
    })
  );
}

let redis: MemoryIdempotencyRedis;
let auditLog: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetIdempotencyStateForTests();
  idempotencyLogger.warn.mockClear();
  idempotencyLogger.info.mockClear();
  redis = new MemoryIdempotencyRedis();
  registerIdempotencyRedis(redis);
  ({ auditLog } = registerIdempotencyRuntime());
});

afterEach(() => {
  container.reset();
});

describe('Idempotency-Key middleware', () => {
  it('runs the first request, then replays the stored response for a retry with the same key', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'create-thing-1' };

    const first = await post(app, '/api/things?dryRun=false', { name: 'alpha' }, key);
    const firstBody = await first.json();
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(firstBody).toEqual({ data: { id: 'thing-1', name: 'alpha' } });

    const retry = await post(app, '/api/things?dryRun=false', { name: 'alpha' }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(retry.headers.get('Location')).toBe('/api/things/thing-1');
    expect(retry.headers.get('Content-Type')).toContain('application/json');
    expect(retry.headers.get('X-Internal')).toBeNull();
    expect(await retry.json()).toEqual(firstBody);
    expect(calls.things).toBe(1);
    // Stored results are encrypted with the master key; Redis never holds the plaintext body.
    expect(redis.dump()).not.toContain('alpha');
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'token-owner',
        action: 'api.idempotency.replay',
        details: expect.objectContaining({
          method: 'POST',
          path: '/api/things',
          status: 201,
          withheld: false,
          tokenId: 'token-1',
        }),
      })
    );
  });

  it('never stores a response carrying a secret; a retry learns only that the request completed', async () => {
    const { app, calls } = createApp();

    for (const path of ['/api/enroll', '/api/connection']) {
      const key = { [IDEMPOTENCY_KEY_HEADER]: `secret-key-${path}` };
      const first = await post(app, path, {}, key);
      expect(first.status).toBe(201);
      const retry = await post(app, path, {}, key);
      expect(retry.status).toBe(409);
      expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
      const body = await retry.json();
      expect(body).toMatchObject({ code: 'IDEMPOTENCY_RESPONSE_WITHHELD', originalStatus: 201 });
      expect(JSON.stringify(body)).not.toMatch(/enroll-secret|hunter2/);
    }
    expect(
      await (await post(app, '/api/enroll', {}, { [IDEMPOTENCY_KEY_HEADER]: 'secret-key-/api/enroll' })).headers.get(
        'Location'
      )
    ).toBe('/api/nodes/node-1');

    expect(calls).toMatchObject({ enroll: 1, connection: 1 });
    expect(redis.dump()).not.toMatch(/enroll-secret|hunter2|postgres:/);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ withheld: true, status: 201 }) })
    );
  });

  it('stores completion only when results cannot be encrypted', async () => {
    container.reset();
    registerIdempotencyRedis(redis);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'no-crypto-key' };

    await post(app, '/api/things', { name: 'alpha' }, key);
    const retry = await post(app, '/api/things', { name: 'alpha' }, key);

    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: 'IDEMPOTENCY_RESPONSE_WITHHELD' });
    expect(calls.things).toBe(1);
    expect(redis.dump()).not.toContain('alpha');
  });

  it('treats reordered JSON keys as the same request', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'order-key' };

    await post(app, '/api/things', { name: 'alpha', size: 2 }, key);
    const retry = await app.request('/api/things', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-token': 'token-1', ...key },
      body: '{"size":2,"name":"alpha"}',
    });

    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(calls.things).toBe(1);
  });

  it('rejects the same key with a different body as IDEMPOTENCY_KEY_REUSED', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'reused-key' };

    expect((await post(app, '/api/things', { name: 'alpha' }, key)).status).toBe(201);
    const mismatch = await post(app, '/api/things', { name: 'beta' }, key);
    const differentQuery = await post(app, '/api/things?force=true', { name: 'alpha' }, key);

    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(differentQuery.status).toBe(422);
    expect(calls.things).toBe(1);
  });

  it('answers 409 IDEMPOTENCY_KEY_IN_PROGRESS with Retry-After while the first request runs', async () => {
    const { app, calls, gates } = createApp();
    gates.slow = deferred();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'slow-key' };

    const first = post(app, '/api/slow', {}, key);
    await vi.waitFor(() => expect(calls.slow).toBe(1));
    const concurrent = await post(app, '/api/slow', {}, key);

    expect(concurrent.status).toBe(409);
    expect(concurrent.headers.get('Retry-After')).toBe('2');
    expect(await concurrent.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });

    gates.slow.resolve();
    expect((await first).status).toBe(201);
    const retry = await post(app, '/api/slow', {}, key);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await retry.json()).toEqual({ data: { attempt: 1 } });
    expect(calls.slow).toBe(1);
  });

  it('releases the key after a 5xx or a thrown error so a retry runs again', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'flaky-key' };

    expect((await post(app, '/api/flaky', {}, key)).status).toBe(500);
    const retry = await post(app, '/api/flaky', {}, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    const replay = await post(app, '/api/flaky', {}, key);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await replay.json()).toEqual({ data: { attempt: 2 } });
    expect(calls.flaky).toBe(2);

    const throwsKey = { [IDEMPOTENCY_KEY_HEADER]: 'throws-key' };
    expect((await post(app, '/api/throws', {}, throwsKey)).status).toBe(500);
    expect((await post(app, '/api/throws', {}, throwsKey)).status).toBe(500);
    expect(calls.throws).toBe(2);
    expect(redis.entries.size).toBe(1);
  });

  it('stores deterministic 409s but never 401/403', async () => {
    const { app, calls } = createApp();

    await post(app, '/api/conflict', {}, { [IDEMPOTENCY_KEY_HEADER]: 'conflict-key' });
    const conflictRetry = await post(app, '/api/conflict', {}, { [IDEMPOTENCY_KEY_HEADER]: 'conflict-key' });
    expect(conflictRetry.status).toBe(409);
    expect(conflictRetry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await conflictRetry.json()).toMatchObject({ message: 'exists 1' });

    await post(app, '/api/forbidden', {}, { [IDEMPOTENCY_KEY_HEADER]: 'forbidden-key' });
    const forbiddenRetry = await post(app, '/api/forbidden', {}, { [IDEMPOTENCY_KEY_HEADER]: 'forbidden-key' });
    expect(forbiddenRetry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(await forbiddenRetry.json()).toMatchObject({ message: 'denied 2' });
    expect(calls).toMatchObject({ conflict: 1, forbidden: 2 });
  });

  it('never buffers or replays streamed responses', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'sse-key' };

    const first = await post(app, '/api/events', {}, key);
    expect(await first.text()).toBe('data: hello\n\n');
    await post(app, '/api/events', {}, key);

    expect(calls.events).toBe(2);
    expect(redis.entries.size).toBe(0);
  });

  it('runs without idempotency and logs once when Redis is down', async () => {
    const failing = new FailingIdempotencyRedis();
    registerIdempotencyRedis(failing);
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'redis-down-key' };

    const first = await post(app, '/api/things', { name: 'alpha' }, key);
    const second = await post(app, '/api/things', { name: 'alpha' }, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(calls.things).toBe(2);
    expect(failing.commands).toBeGreaterThan(0);
    expect(idempotencyLogger.warn).toHaveBeenCalledTimes(1);

    registerIdempotencyRedis(redis);
    await post(app, '/api/things', { name: 'alpha' }, key);
    expect(idempotencyLogger.info).toHaveBeenCalledWith('Idempotency store available again');
  });

  it('runs without idempotency when no Redis client is registered', async () => {
    container.reset();
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'no-redis-key' };

    expect((await post(app, '/api/things', { name: 'alpha' }, key)).status).toBe(201);
    expect((await post(app, '/api/things', { name: 'alpha' }, key)).status).toBe(201);
    expect(calls.things).toBe(2);
  });

  it('isolates keys per principal: tokens, users, and impersonation sessions', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'shared-key' };
    const session = (id: string, actor?: string) => ({
      ...key,
      'x-test-token': '',
      'x-test-user': id,
      ...(actor ? { 'x-test-impersonator': actor } : {}),
    });

    const tokenOne = await (await post(app, '/api/things', { name: 'alpha' }, key)).json();
    const tokenTwo = await (
      await post(app, '/api/things', { name: 'alpha' }, { ...key, 'x-test-token': 'token-2' })
    ).json();
    const userA = await (await post(app, '/api/things', { name: 'alpha' }, session('user-a'))).json();
    const impersonated = await (await post(app, '/api/things', { name: 'alpha' }, session('user-a', 'admin-1'))).json();

    const ids = [tokenOne, tokenTwo, userA, impersonated].map((body) => (body as { data: { id: string } }).data.id);
    expect(new Set(ids).size).toBe(4);
    expect(calls.things).toBe(4);

    const userARetry = await post(app, '/api/things', { name: 'alpha' }, session('user-a'));
    expect(userARetry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await userARetry.json()).toEqual(userA);
    expect(calls.things).toBe(4);

    // Another browser session of the same user never replays this session's result.
    const otherSession = await post(
      app,
      '/api/things',
      { name: 'alpha' },
      {
        ...session('user-a'),
        'x-test-session': 'second-session',
      }
    );
    expect(otherSession.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(calls.things).toBe(5);
  });

  it('never replays a result once the caller scopes change', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'scoped-key', 'x-test-scopes': 'acl:create,acl:view' };

    await post(app, '/api/things', { name: 'alpha' }, key);
    const narrowed = await post(app, '/api/things', { name: 'alpha' }, { ...key, 'x-test-scopes': 'acl:view' });
    const sameScopes = await post(
      app,
      '/api/things',
      { name: 'alpha' },
      { ...key, 'x-test-scopes': 'acl:view,acl:create' }
    );

    expect(narrowed.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(sameScopes.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(calls.things).toBe(2);
  });

  it('scopes keys to the method and path', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'path-key' };

    await post(app, '/api/things/a', {}, key, 'PATCH');
    await post(app, '/api/things/b', {}, key, 'PATCH');
    const replay = await post(app, '/api/things/a', {}, key, 'PATCH');

    expect(calls.patch).toBe(2);
    expect(await replay.json()).toEqual({ data: { id: 'a', revision: 1 } });
  });

  it('rejects malformed keys with 400 IDEMPOTENCY_KEY_INVALID', async () => {
    const { app, calls } = createApp();

    for (const value of ['', 'x'.repeat(256), 'caf\u00e9', 'tab\there']) {
      const response = await app.request('/api/things', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-token': 'token-1', [IDEMPOTENCY_KEY_HEADER]: value },
        body: '{}',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
    }
    expect(calls.things).toBeUndefined();
  });

  it('ignores the header on reads, excluded routes, and binary bodies', async () => {
    const { app, calls } = createApp();
    const key = { [IDEMPOTENCY_KEY_HEADER]: 'ignored-key' };

    await app.request('/api/things', { headers: { 'x-test-token': 'token-1', ...key } });
    await app.request('/api/things', { headers: { 'x-test-token': 'token-1', ...key } });
    await post(app, '/api/not-opted-in', {}, key);
    await post(app, '/api/not-opted-in', {}, key);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const upload = await app.request('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-test-token': 'token-1', ...key },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(await upload.json()).toEqual({ data: { bytes: 3 } });
    }

    expect(calls).toMatchObject({ list: 2, notOptedIn: 2, upload: 2 });
    expect(redis.commands).toBe(0);
  });

  it('does not touch Redis without the header', async () => {
    const { app, calls } = createApp();

    await post(app, '/api/things', { name: 'alpha' });
    await post(app, '/api/things', { name: 'alpha' });

    expect(calls.things).toBe(2);
    expect(redis.commands).toBe(0);
  });

  it('applies the default only to the opt-in create routes', () => {
    expect(isIdempotencyEligibleRequest('POST', '/api/domains')).toBe(true);
    expect(isIdempotencyEligibleRequest('post', '/api/proxy-hosts')).toBe(true);
    expect(isIdempotencyEligibleRequest('POST', '/api/docker/nodes/n1/containers')).toBe(true);
    expect(isIdempotencyEligibleRequest('POST', '/api/docker/nodes/{nodeId}/deployments')).toBe(true);
    expect(isIdempotencyEligibleRequest('PUT', '/api/proxy-hosts/1')).toBe(false);
    expect(isIdempotencyEligibleRequest('DELETE', '/api/domains/1')).toBe(false);
    expect(isIdempotencyEligibleRequest('POST', '/api/docker/nodes/n1/containers/c1/restart')).toBe(false);
    expect(isIdempotencyEligibleRequest('POST', '/auth/logout')).toBe(false);
    expect(isIdempotencyEligibleRequest('POST', '/api/mcp')).toBe(false);
    expect(isIdempotencyEligibleRequest('POST', '/api/inference/v1/responses')).toBe(false);
    expect(isIdempotencyEligibleRequest('POST', '/api/pages-deploy/deployments')).toBe(false);
    expect(isIdempotencyEligibleRequest('POST', '/api/docker/nodes/n1/containers/archive')).toBe(false);
  });

  it('never makes a secret-returning route idempotent', () => {
    const secretRoutes = [
      '/api/tokens',
      '/api/nodes',
      '/api/nodes/{id}/enrollment-token',
      '/api/certificates',
      '/api/certificates/from-csr',
      '/api/cas/{id}/export-key',
      '/api/managed-storage/{id}/iam-keys',
      '/api/managed-storage/{id}/iam-keys/import',
      '/api/managed-storage/{id}/bindings',
      '/api/logging/environments/{id}/tokens',
      '/api/inference/tokens',
      '/api/pages/{projectId}/tokens',
      '/api/databases/managed/{id}/rotate-direct-credentials',
      '/api/databases/managed/{id}/bindings',
      '/api/admin/users/{id}/password-setup',
      '/api/access-lists',
      '/api/notifications/webhooks',
      '/api/docker/nodes/{nodeId}/deployments/{deploymentId}/webhook/regenerate',
      '/api/docker/nodes/{nodeId}/containers/{containerName}/webhook/regenerate',
    ];
    for (const path of secretRoutes) {
      for (const method of ['POST', 'PUT', 'PATCH']) {
        expect(isIdempotencyEligibleRequest(method, path), `${method} ${path}`).toBe(false);
      }
    }
    // Anything minting, revealing, rotating or binding credentials must stay off the opt-in list.
    for (const route of IDEMPOTENT_CREATE_ROUTES) {
      expect(route.path, route.path).not.toMatch(
        /token|key|secret|credential|password|enroll|reveal|rotate|regenerate|mfa|binding|export|iam/i
      );
    }
  });

  it('detects secret-looking material and ignores redacted or harmless fields', () => {
    const secrets: unknown[] = [
      { data: { enrollmentToken: 'abc' } },
      { data: { token: 'gw_0123456789abcdef0123456789abcdef' } },
      { data: { credentials: { password: 'hunter2' } } },
      { privateKeyPem: 'x' },
      { data: { key: '-----BEGIN EC PRIVATE KEY-----\nMHc=\n-----END EC PRIVATE KEY-----' } },
      { secretAccessKey: 'wJalrXUtnFEMI' },
      { url: 'postgres://app:hunter2@db:5432/app' },
      { env: ['PATH=/usr/bin', 'POSTGRES_PASSWORD=hunter2'] },
      { env: { DATABASE_PASSWORD: 'hunter2' } },
      { note: 'use gwo_abcdefghijklmnopqrstuvwx to connect' },
      { recoveryCodes: ['aaaa-bbbb'] },
      { basicAuthUsers: [{ username: 'ops', passwordHash: '$2b$10$N9qo8uLOickgx2ZMRZoMye' }] },
      { users: [{ username: 'ops', hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA' }] },
    ];
    for (const value of secrets) expect(findSecretMaterial(value), JSON.stringify(value)).not.toBeNull();

    const harmless: unknown[] = [
      { data: { id: 'c1', name: 'api', tokenPrefix: 'gw_abc', hasPassword: true, passwordSet: true } },
      { webhook: { token: '[REDACTED]' }, password: '********', secret: null, apiKey: '' },
      { secretKeys: ['DB_PASSWORD'], env: ['PATH=/usr/bin', 'NODE_ENV=production'] },
      { url: 'https://example.com/path', upstream: 'http://api:8080' },
    ];
    for (const value of harmless) expect(findSecretMaterial(value), JSON.stringify(value)).toBeNull();
  });
});
