import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { registerImageRoutes } from './docker-image.routes.js';
import { DockerRegistryService } from './docker-registry.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const SCOPES = [`docker:containers:create:folder/${FOLDER_ID}`];

function app() {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('effectiveScopes', SCOPES);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerImageRoutes(router);
  return router;
}

function register() {
  const docker = {
    pullImageForWorkload: vi.fn().mockResolvedValue({ status: 'pulled' }),
    pullImageImmediate: vi.fn().mockResolvedValue({ status: 'pulled' }),
    pullImage: vi.fn().mockResolvedValue({ taskId: 'task-1' }),
  };
  const registry = {
    resolveAuthForImagePull: vi.fn().mockResolvedValue(null),
    rememberImageRegistry: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerRegistryService, registry as never);
  return docker;
}

const post = (path: string, body: unknown) =>
  app().request(`/nodes/${NODE_ID}/images/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

afterEach(() => container.reset());

describe('image pull for a workload deploy', () => {
  it('routes a deploy pull through the workload destination check', async () => {
    const docker = register();

    const response = await post('pull-sync', { imageRef: 'nginx:alpine', workload: { folderId: FOLDER_ID } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { success: true, imageRef: 'nginx:alpine' } });
    expect(docker.pullImageForWorkload).toHaveBeenCalledWith(
      NODE_ID,
      'nginx:alpine',
      undefined,
      FOLDER_ID,
      'user-1',
      SCOPES
    );
    expect(docker.pullImageImmediate).not.toHaveBeenCalled();
  });

  it('keeps standalone pulls on the image pull check', async () => {
    const docker = register();

    const response = await post('pull-sync', { imageRef: 'nginx:alpine', folderId: FOLDER_ID });

    expect(response.status).toBe(200);
    expect(docker.pullImageImmediate).toHaveBeenCalledWith(
      NODE_ID,
      'nginx:alpine',
      undefined,
      FOLDER_ID,
      'user-1',
      SCOPES
    );
    expect(docker.pullImageForWorkload).not.toHaveBeenCalled();
  });

  it('rejects an image folder next to a workload destination and workload pulls on the async route', async () => {
    const docker = register();

    const both = await post('pull-sync', {
      imageRef: 'nginx:alpine',
      folderId: FOLDER_ID,
      workload: { folderId: FOLDER_ID },
    });
    const async = await post('pull', { imageRef: 'nginx:alpine', workload: { folderId: FOLDER_ID } });

    expect([both.status, async.status]).toEqual([400, 400]);
    expect(docker.pullImageForWorkload).not.toHaveBeenCalled();
    expect(docker.pullImage).not.toHaveBeenCalled();
  });
});
