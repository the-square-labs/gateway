import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const ORIGIN_NODE = '11111111-1111-4111-8111-111111111111';
const REPLICA_NODE = '33333333-3333-4333-8333-333333333333';

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerContainerRoutes(router);
  return router;
}

/** A failover workload "app" whose serving replica runs on another node under an internal name. */
function registerFailedOverWorkload() {
  container.registerInstance(DockerWorkloadResolverService, {
    resolveContainerRuntimeTarget: vi.fn().mockResolvedValue({
      workload: {
        policy: {
          id: 'policy-1',
          resourceKind: 'container',
          mode: 'failover',
          originNodeId: ORIGIN_NODE,
          sourceNodeId: ORIGIN_NODE,
          containerName: 'app',
          displayName: 'app',
        },
        managementTarget: { nodeId: ORIGIN_NODE, resourceId: 'access-app' },
      },
      placementId: 'placement-2',
      nodeId: REPLICA_NODE,
      containerId: 'replica-id',
    }),
  } as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
  } as never);
  const docker = {
    // Secrets are stored for the logical container on its origin node, never under the replica's internal name.
    secretService: {
      getSecretKeys: vi.fn(async (nodeId: string, name: string) =>
        nodeId === ORIGIN_NODE && name === 'app' ? new Set(['API_TOKEN']) : new Set<string>()
      ),
    },
    inspectContainer: vi.fn(async (_nodeId: string, id: string) =>
      id === 'replica-id'
        ? {
            Id: 'replica-id',
            Name: '/gw-ha-app-2',
            Config: { Labels: {}, Env: ['API_TOKEN=plain-secret', 'MODE=prod'] },
          }
        : { Id: 'origin-id', Name: '/app', Config: { Labels: {}, Env: [] }, scopeResourceId: 'access-app' }
    ),
    maskSecretEnv: DockerManagementService.prototype.maskSecretEnv,
    decorateContainerDetailSnapshot: vi.fn(async (_nodeId: string, data: unknown) => data),
  };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerSnapshotService, {} as never);
}

afterEach(() => container.reset());

describe('HA replica inspect by logical name', () => {
  it('masks the workload secrets for a caller with environment but without secrets access', async () => {
    registerFailedOverWorkload();
    const response = await app([
      `docker:containers:view:${ORIGIN_NODE}`,
      `docker:containers:environment:${ORIGIN_NODE}`,
    ]).request(`/nodes/${ORIGIN_NODE}/containers/by-name/app`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { Config: { Env: string[] } } };
    expect(body.data.Config.Env).toEqual(['API_TOKEN=********', 'MODE=prod']);
  });
});
