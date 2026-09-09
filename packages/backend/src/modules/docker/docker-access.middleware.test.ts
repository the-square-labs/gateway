import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import {
  assertDockerNodeScope,
  assertDockerResourceScope,
  requireDockerNetworkScope,
  resolveDockerContainerScopeResourceId,
} from './docker-access.middleware.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';

afterEach(() => {
  container.reset();
});

describe('Docker permission diagnostics', () => {
  it('names the canonical child identity, not only the base scope', () => {
    expect(() => assertDockerResourceScope([], 'docker:containers:edit', 'node-1', 'resource-1')).toThrow(
      'Missing required scope: docker:containers:edit:node-1/resource-1'
    );
  });
  it('names the node when checking node access', () => {
    expect(() => assertDockerNodeScope([], 'docker:containers:view', 'node-1')).toThrow(
      'Missing required scope: docker:containers:view:node-1'
    );
  });
  it.each([
    'docker:containers:edit',
    'docker:containers:edit:node-1',
    'docker:containers:edit:node-1/resource-1',
  ])('preserves allowed grant %s', (scope) => {
    expect(() => assertDockerResourceScope([scope], 'docker:containers:edit', 'node-1', 'resource-1')).not.toThrow();
  });
  it('continues allowing a node through its child grant', () => {
    expect(() =>
      assertDockerNodeScope(['docker:containers:view:node-1/resource-1'], 'docker:containers:view', 'node-1')
    ).not.toThrow();
  });
});

describe('Docker container emergency scope identity', () => {
  it('uses persisted identity only while the stable name has an active transition', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('container temporarily absent'));
    const resolvePersisted = vi.fn().mockResolvedValue('resource-1');

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => true,
        resolvePersisted,
      })
    ).resolves.toBe('resource-1');
    expect(resolvePersisted).toHaveBeenCalledOnce();
  });

  it('does not trust persisted identity when no transition is active', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('container absent'));
    const resolvePersisted = vi.fn();

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => false,
        resolvePersisted,
      })
    ).rejects.toThrow('container absent');
    expect(resolvePersisted).not.toHaveBeenCalled();
  });

  it('never falls back to persisted identity for a Gateway-owned internal container', async () => {
    const inspect = vi.fn().mockRejectedValue(new AppError(404, 'GATEWAY_INTERNAL_CONTAINER', 'Container not found'));
    const resolvePersisted = vi.fn().mockResolvedValue('resource-1');

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => true,
        resolvePersisted,
      })
    ).rejects.toMatchObject({ code: 'GATEWAY_INTERNAL_CONTAINER' });
    expect(resolvePersisted).not.toHaveBeenCalled();
  });
});

describe('Docker network scoped middleware', () => {
  it('allows only the persisted network resource identity and never a raw daemon ID grant', async () => {
    const resources = { resolveNetwork: vi.fn().mockResolvedValue('network-resource-1') };
    container.registerInstance(DockerNetworkAccessResourceService, resources as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', ['docker:networks:delete:node-1/network-resource-1']);
      await next();
    });
    app.delete('/nodes/:nodeId/networks/:networkId', requireDockerNetworkScope('docker:networks:delete'), (c) =>
      c.json({ success: true })
    );

    const response = await app.request('/nodes/node-1/networks/raw-daemon-network-id', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(resources.resolveNetwork).toHaveBeenCalledWith('node-1', 'raw-daemon-network-id');
  });

  it('denies an unrelated persisted network resource before the action handler runs', async () => {
    const resources = { resolveNetwork: vi.fn().mockResolvedValue('network-resource-2') };
    container.registerInstance(DockerNetworkAccessResourceService, resources as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', ['docker:networks:delete:node-1/network-resource-1']);
      await next();
    });
    const handler = vi.fn((c: any) => c.json({ success: true }));
    app.delete('/nodes/:nodeId/networks/:networkId', requireDockerNetworkScope('docker:networks:delete'), handler);

    const response = await app.request('/nodes/node-1/networks/raw-daemon-network-id', { method: 'DELETE' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'HTTP_ERROR',
      message: 'Missing required scope: docker:networks:delete:node-1/network-resource-2',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not invent a child permission when its identity cannot be resolved', async () => {
    container.registerInstance(DockerNetworkAccessResourceService, {
      resolveNetwork: vi.fn().mockResolvedValue(null),
    } as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', []);
      await next();
    });
    const handler = vi.fn((c: any) => c.json({ success: true }));
    app.delete('/nodes/:nodeId/networks/:networkId', requireDockerNetworkScope('docker:networks:delete'), handler);
    const response = await app.request('/nodes/node-1/networks/unknown', { method: 'DELETE' });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Docker resource identity could not be resolved for access verification',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
