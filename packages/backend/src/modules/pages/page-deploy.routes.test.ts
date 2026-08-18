import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const PROJECT_1 = '11111111-1111-4111-8111-111111111111';
const PROJECT_2 = '22222222-2222-4222-8222-222222222222';
const UPLOAD_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '55555555-5555-4555-8555-555555555555';
const DEPLOY_TOKEN = `gwp_${'a'.repeat(64)}`;

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  tokenService: {
    validate: vi.fn(),
    assertTagAllowed: vi.fn(),
  },
  deploymentService: {
    create: vi.fn(),
    appendChunk: vi.fn(),
    finalize: vi.fn(),
    get: vi.fn(),
  },
  publicationService: { markDeploymentReady: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      if (token?.name === 'PageDeployTokenService') return mocks.tokenService;
      if (token?.name === 'PagePublicationService') return mocks.publicationService;
      return mocks.deploymentService;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', email: 'operator@example.test' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
}));

import { pageDeployRoutes } from './page-deploy.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', pageDeployRoutes);
  return app;
}

function deploy(projectId: string, authorization?: string, tag?: string) {
  return createApp().request('/deployments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      projectId,
      declaredSizeBytes: 10,
      sha256: '0'.repeat(64),
      source: {},
      ...(tag ? { tag } : {}),
    }),
  });
}

describe('Pages Deploy API authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.deploymentService.create.mockResolvedValue({
      deployment: { id: 'deployment-1' },
      upload: { id: 'upload-1' },
    });
    mocks.deploymentService.finalize.mockResolvedValue({ deployment: { id: DEPLOYMENT_ID, status: 'stored' } });
    mocks.deploymentService.get.mockResolvedValue({ id: DEPLOYMENT_ID, status: 'ready' });
    mocks.tokenService.validate.mockResolvedValue(null);
  });

  it('accepts a Project-scoped user or API-token principal only for that Project', async () => {
    mocks.scopes = [`pages:deploy:${PROJECT_1}`];

    expect((await deploy(PROJECT_1)).status).toBe(201);
    expect((await deploy(PROJECT_2)).status).toBe(403);
    expect(mocks.deploymentService.create).toHaveBeenCalledTimes(1);
    expect(mocks.deploymentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_1 }),
      expect.objectContaining({ kind: 'user', userId: 'user-1' })
    );
  });

  it('authenticates a deploy token independently and applies its tag policy', async () => {
    const validated = {
      tokenId: '33333333-3333-4333-8333-333333333333',
      tokenPrefix: DEPLOY_TOKEN.slice(0, 12),
      projectId: PROJECT_1,
      allowedTagPatterns: ['mr-*'],
      allowUserTag: true,
    };
    mocks.tokenService.validate.mockResolvedValue(validated);

    const response = await deploy(PROJECT_1, `Bearer ${DEPLOY_TOKEN}`, 'mr-42');

    expect(response.status).toBe(201);
    expect(mocks.tokenService.validate).toHaveBeenCalledWith(DEPLOY_TOKEN);
    expect(mocks.tokenService.assertTagAllowed).toHaveBeenCalledWith(validated, 'mr-42');
    expect(mocks.deploymentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_1, tag: 'mr-42' }),
      { kind: 'deploy-token', token: validated }
    );
  });

  it('never falls back to session auth for an invalid deploy-token credential', async () => {
    mocks.scopes = ['pages:deploy'];

    const response = await deploy(PROJECT_1, `Bearer ${DEPLOY_TOKEN}`);

    expect(response.status).toBe(401);
    expect(mocks.deploymentService.create).not.toHaveBeenCalled();
  });

  it('rejects a valid deploy token used against another Project', async () => {
    mocks.tokenService.validate.mockResolvedValue({
      tokenId: '33333333-3333-4333-8333-333333333333',
      tokenPrefix: DEPLOY_TOKEN.slice(0, 12),
      projectId: PROJECT_1,
      allowedTagPatterns: [],
      allowUserTag: false,
    });

    const response = await deploy(PROJECT_2, `Bearer ${DEPLOY_TOKEN}`);

    expect(response.status).toBe(403);
    expect(mocks.tokenService.assertTagAllowed).not.toHaveBeenCalled();
    expect(mocks.deploymentService.create).not.toHaveBeenCalled();
  });

  it('publishes a finalized upload before returning the ready Deployment', async () => {
    const response = await createApp().request(`/uploads/${UPLOAD_ID}/finalize`, { method: 'POST' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { deployment: { id: DEPLOYMENT_ID, status: 'ready' } } });
    expect(mocks.publicationService.markDeploymentReady).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(mocks.deploymentService.get).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(mocks.publicationService.markDeploymentReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentService.get.mock.invocationCallOrder[0]!
    );
  });
});
