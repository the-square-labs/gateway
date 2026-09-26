import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { AppEnv, User } from '@/types.js';
import { accessSummaryRoutes } from './access-summary.routes.js';

const FOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: null,
  email: 'dev@example.com',
  name: 'Dev',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'developers',
  scopes: [`docker:containers:view:folder/${FOLDER}`, `docker:containers:create:folder/${FOLDER}`, 'proxy:view'],
  isBlocked: false,
};

vi.mock('./auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    const header = c.req.header('Authorization');
    if (!header) return c.json({ message: 'Authentication required' }, 401);
    const token = header === 'Bearer gw_token';
    c.set('user', USER);
    c.set('authType', token ? 'api-token' : 'session');
    // A token bounded by its owner: only the owner's folder grant survives.
    c.set('effectiveScopes', token ? [`docker:containers:view:folder/${FOLDER}`] : USER.scopes);
    await next();
  },
}));

function app() {
  const root = new Hono<AppEnv>();
  root.route('/api/auth', accessSummaryRoutes);
  return root;
}

afterEach(() => {
  container.reset();
});

describe('GET /api/auth/me/access', () => {
  it('requires authentication', async () => {
    expect((await app().request('/api/auth/me/access')).status).toBe(401);
  });

  it('summarizes a session user by area, with creation destinations', async () => {
    const response = await app().request('/api/auth/me/access', { headers: { Authorization: 'Session' } });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: any };

    expect(data.principal).toEqual({
      userId: USER.id,
      name: 'Dev',
      email: 'dev@example.com',
      group: 'developers',
      credential: 'session',
      boundedByOwner: false,
    });
    expect(data.limited).toBe(true);
    expect(data.areas.find((area: any) => area.area === 'routes')).toMatchObject({
      access: 'broad',
      broadActions: ['view'],
    });
    expect(data.areas.find((area: any) => area.area === 'docker_containers')).toMatchObject({
      access: 'limited',
      folders: [{ id: FOLDER, actions: ['create', 'view'], includesSubfolders: true }],
      create: { scope: 'docker:containers:create', atRoot: false, folders: [{ id: FOLDER }] },
    });
    expect(data.summary).toContain('Docker containers and deployments');
    expect(data.summary).not.toContain('Ingress routes:');
  });

  it('reports a token as bounded by its owner and summarizes its bounded scopes', async () => {
    const response = await app().request('/api/auth/me/access', { headers: { Authorization: 'Bearer gw_token' } });
    const { data } = (await response.json()) as { data: any };

    expect(data.principal).toMatchObject({ credential: 'api-token', boundedByOwner: true });
    expect(data.areas.map((area: any) => area.area)).toEqual(['docker_containers']);
    expect(data.areas[0]).toMatchObject({ folders: [{ id: FOLDER, actions: ['view'] }] });
    expect(data.areas[0].create).toBeUndefined();
  });
});
