import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { dockerWebhookTriggerRoutes } from './docker-webhook.routes.js';
import { DockerWebhookService } from './docker-webhook.service.js';

vi.mock('@/modules/demo/demo-mode.js', () => ({ isDemoMode: () => false }));

const token = '11111111-1111-4111-8111-111111111111';

function setup(managed: Record<string, unknown> | null) {
  const docker = {
    getManagedContainerConfiguration: vi.fn().mockResolvedValue(managed),
    listContainers: vi.fn().mockResolvedValue([{ id: 'physical-id', name: '/app' }]),
  };
  const service = {
    getByToken: vi.fn().mockResolvedValue({
      id: 'webhook-1',
      enabled: true,
      targetType: 'container',
      nodeId: 'origin-node',
      containerName: 'app',
    }),
    triggerUpdate: vi.fn().mockResolvedValue({ taskId: 'task-1' }),
    triggerWebhookToken: vi.fn().mockResolvedValue({ taskId: 'deployment-task' }),
  };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerWebhookService, service as never);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/webhooks', dockerWebhookTriggerRoutes);
  const request = () =>
    app.request(`/webhooks/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'next' }),
    });
  return { docker, service, request };
}

afterEach(() => {
  container.reset();
});

describe('Docker webhook trigger resource resolution', () => {
  it('routes HA updates by canonical identity without listing the offline origin node', async () => {
    const { docker, service, request } = setup({
      image: 'registry.example/app:stable',
      nodeId: 'canonical-node',
      containerName: 'canonical-app',
      shouldRun: false,
    });
    docker.listContainers.mockRejectedValue(new Error('Origin is offline'));
    const response = await request();
    expect(response.status).toBe(200);
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('origin-node', 'app');
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(service.triggerUpdate).toHaveBeenCalledExactlyOnceWith({
      nodeId: 'canonical-node',
      containerName: 'canonical-app',
      containerId: 'canonical-app',
      tag: 'next',
      webhookId: 'webhook-1',
    });
  });

  it('retains physical ID lookup for single-node containers', async () => {
    const { docker, service, request } = setup(null);
    expect((await request()).status).toBe(200);
    expect(docker.listContainers).toHaveBeenCalledWith('origin-node');
    expect(service.triggerUpdate).toHaveBeenCalledWith({
      nodeId: 'origin-node',
      containerName: 'app',
      containerId: 'physical-id',
      tag: 'next',
      webhookId: 'webhook-1',
    });
    expect(docker.getManagedContainerConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      docker.listContainers.mock.invocationCallOrder[0]!
    );
  });

  it('retains not-found behavior for missing single-node containers', async () => {
    const { docker, service, request } = setup(null);
    docker.listContainers.mockResolvedValue([]);
    expect((await request()).status).toBe(404);
    expect(service.triggerUpdate).not.toHaveBeenCalled();
  });

  it('does not inspect containers for deployment webhooks', async () => {
    const { docker, service, request } = setup(null);
    service.getByToken.mockResolvedValue({
      id: 'deployment-hook',
      enabled: true,
      targetType: 'deployment',
      nodeId: 'origin-node',
      containerName: 'app',
    });
    expect((await request()).status).toBe(200);
    expect(service.triggerWebhookToken).toHaveBeenCalledWith(token, 'next');
    expect(docker.getManagedContainerConfiguration).not.toHaveBeenCalled();
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(service.triggerUpdate).not.toHaveBeenCalled();
  });

  it('rejects disabled tokens before any resource resolution', async () => {
    const { docker, service, request } = setup(null);
    service.getByToken.mockResolvedValue({
      id: 'webhook-1',
      enabled: false,
      targetType: 'container',
      nodeId: 'origin-node',
      containerName: 'app',
    });
    expect((await request()).status).toBe(404);
    expect(docker.getManagedContainerConfiguration).not.toHaveBeenCalled();
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(service.triggerUpdate).not.toHaveBeenCalled();
  });
});
