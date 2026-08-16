import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  scopes: ['pki:ca:view:intermediate'],
  caService: {
    getCATree: vi.fn(),
    getCA: vi.fn(),
    createIntermediateCA: vi.fn(),
  },
  generalSettings: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => (token?.name === 'GeneralSettingsService' ? mocks.generalSettings : mocks.caService)),
  },
}));

vi.mock('@/modules/audit/audit.service.js', () => ({
  AuditService: class AuditService {},
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireAnyScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireAnyScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: (base: string, param: string) => async (c: any, next: () => Promise<void>) => {
    const id = c.req.param(param);
    if (!mocks.scopes.includes(base) && !mocks.scopes.includes(`${base}:${id}`)) {
      return c.json({ message: `Missing required scope: ${base}:${id}` }, 403);
    }
    await next();
  },
}));

vi.mock('./ca.service.js', () => ({
  CAService: class CAService {},
}));

vi.mock('./export.service.js', () => ({
  ExportService: class ExportService {},
}));

import { caRoutes } from './ca.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', caRoutes);
  return app;
}

describe('CA routes scoped visibility', () => {
  beforeEach(() => {
    mocks.scopes = ['pki:ca:view:intermediate'];
    vi.clearAllMocks();
    mocks.caService.getCATree.mockResolvedValue([
      { id: 'root-1', type: 'root', commonName: 'Root' },
      { id: 'int-1', type: 'intermediate', commonName: 'Intermediate' },
    ]);
    mocks.generalSettings.isFeatureEnabled.mockResolvedValue(true);
    mocks.caService.getCA.mockResolvedValue({ id: 'root-1', type: 'root', commonName: 'Root' });
    mocks.caService.createIntermediateCA.mockResolvedValue({ id: 'int-2', type: 'intermediate' });
  });

  it('filters CA list by root/intermediate view scopes', async () => {
    const response = await createApp().request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'int-1', type: 'intermediate', commonName: 'Intermediate' }]);
  });

  it('exposes only the CA targeted by a resource-scoped certificate issue grant', async () => {
    mocks.scopes = ['pki:cert:issue:root-1'];

    const response = await createApp().request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'root-1', type: 'root', commonName: 'Root' }]);
  });

  it('rejects CA detail when the caller lacks the matching CA type view scope', async () => {
    const response = await createApp().request('/root-1');

    expect(response.status).toBe(403);
  });

  it('allows parent-scoped intermediate CA creation', async () => {
    mocks.scopes = ['pki:ca:create:intermediate:root-1'];

    const response = await createApp().request('/root-1/intermediate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commonName: 'Intermediate',
        keyAlgorithm: 'rsa-2048',
        validityYears: 5,
      }),
    });

    expect(response.status).toBe(201);
    expect(mocks.caService.createIntermediateCA).toHaveBeenCalledWith(
      'root-1',
      expect.objectContaining({ commonName: 'Intermediate' }),
      'user-1'
    );
  });

  it('rejects revoke when the caller lacks the matching CA type revoke scope', async () => {
    mocks.scopes = ['pki:ca:revoke:intermediate'];
    mocks.caService.getCA.mockResolvedValue({ id: 'root-1', type: 'root', commonName: 'Root' });

    const response = await createApp().request('/root-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'keyCompromise' }),
    });

    expect(response.status).toBe(403);
  });
});
