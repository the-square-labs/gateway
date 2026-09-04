import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { requireDockerContainerScope } from './docker-access.middleware.js';
import { compactContainerListItem } from './docker-container.routes.js';
import * as sourceModule from './docker-source.service.js';

const pending: sourceModule.PendingDockerSourceContainer = {
  pendingSourceBuild: true,
  Id: 'source-1',
  Name: '/api',
  nodeId: 'node-1',
  containerName: 'api',
  sourceId: 'source-1',
  sourceBindingId: 'source-1',
  repositoryFullPath: 'team/api',
  created: 1788480000,
  scopeResourceId: 'resource-1',
  initialConfig: { name: 'api', restartPolicy: 'no', runtimeProfile: 'secure' },
  latestBuild: null,
};

afterEach(() => {
  container.reset();
  vi.restoreAllMocks();
});

describe('Pending source presentation boundaries', () => {
  it('preserves pending identity and an empty image through the public list serializer', () => {
    expect(compactContainerListItem({ ...pending, image: '', state: 'pending', ports: [] })).toMatchObject({
      id: 'source-1',
      name: 'api',
      image: '',
      pendingSourceBuild: true,
      scopeResourceId: 'resource-1',
    });
  });
  it('appends only logical pending rows to public inventory without calling runtime inspection', async () => {
    vi.spyOn(sourceModule, 'readPendingDockerSourceContainers').mockResolvedValue([pending]);
    const service = new DockerManagementService({} as never, {} as never, {} as never, {} as never);
    vi.spyOn(service, 'decorateContainerSnapshot').mockImplementation(async (_nodeId, rows) => rows);
    const inspect = vi.spyOn(service, 'inspectContainer');
    const runtime = { id: 'docker-1', name: 'running-app', state: 'running' };
    expect(await service.decoratePublicContainerSnapshot('node-1', [runtime])).toEqual([
      runtime,
      {
        ...pending,
        id: pending.Id,
        name: 'api',
        kind: 'container',
        state: 'pending',
        status: 'Awaiting initial build',
        image: '',
        ports: [],
        portsCount: 0,
        portsTruncated: false,
        labels: {},
        healthCheckEnabled: false,
        healthStatus: 'unknown',
        secureLinkDown: false,
        folderId: null,
        folderIsSystem: false,
        folderSortOrder: 0,
      },
    ]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('does not duplicate a pending name once a real runtime appears', async () => {
    vi.spyOn(sourceModule, 'readPendingDockerSourceContainers').mockResolvedValue([pending]);
    const service = new DockerManagementService({} as never, {} as never, {} as never, {} as never);
    vi.spyOn(service, 'decorateContainerSnapshot').mockImplementation(async (_nodeId, rows) => rows);
    const runtime = { id: 'docker-1', name: '/api', state: 'running' };
    expect(await service.decoratePublicContainerSnapshot('node-1', [runtime])).toEqual([runtime]);
  });

  it('does not include pending source reservations in internal runtime inventory', async () => {
    const lookup = vi.spyOn(sourceModule, 'readPendingDockerSourceContainers').mockResolvedValue([pending]);
    const dispatch = { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '[]' }) };
    const service = new DockerManagementService({} as never, {} as never, dispatch as never, {} as never);
    vi.spyOn(service as any, 'validateDockerNode').mockResolvedValue(undefined);
    vi.spyOn(service, 'decorateContainerSnapshot').mockImplementation(async (_nodeId, rows) => rows);
    expect(await service.listAllContainers('node-1')).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never grants physical runtime operations through a pending Source identity', async () => {
    const source = { getPendingContainer: vi.fn().mockResolvedValue(pending) };
    const docker = {
      inspectContainer: vi.fn().mockRejectedValue(new AppError(404, 'CONTAINER_NOT_FOUND', 'No runtime')),
    };
    container.registerInstance(sourceModule.DockerSourceService, source as never);
    container.registerInstance(DockerManagementService, docker as never);
    container.registerInstance(DockerAvailabilityService, {
      resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
    } as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', ['docker:containers:manage:node-1/resource-1']);
      await next();
    });
    const start = vi.fn();
    app.post(
      '/nodes/:nodeId/containers/:containerName/start',
      requireDockerContainerScope('docker:containers:manage', 'containerName'),
      (c) => {
        start();
        return c.json({ success: true });
      }
    );
    expect((await app.request('/nodes/node-1/containers/api/start', { method: 'POST' })).status).toBe(404);
    expect(source.getPendingContainer).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
