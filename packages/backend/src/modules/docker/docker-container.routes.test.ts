import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import { DockerManagementService } from './docker.service.js';
import {
  containerRecreateRequiredScopes,
  containerUpdateRequiredScopes,
  registerContainerRoutes,
} from './docker-container.routes.js';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import { DockerSecretService } from './docker-secret.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const CONTAINER_ID = 'container-a';
const MANAGE_ONLY = ['docker:containers:manage', 'docker:containers:view'];
const FULL = [
  'docker:containers:manage',
  'docker:containers:view',
  'docker:containers:edit',
  'docker:containers:environment',
  'docker:containers:secrets',
  'docker:images:pull',
];

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerContainerRoutes(app);
  return app;
}

function registerDocker() {
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue({
      Id: CONTAINER_ID,
      Name: '/app-a',
      scopeResourceId: 'resource-a',
      Config: { Labels: {} },
    }),
    recreateWithConfig: vi.fn().mockResolvedValue({ taskId: 'task-1' }),
    updateContainer: vi.fn().mockResolvedValue({ taskId: 'task-2' }),
  };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
    isContainerManaged: vi.fn().mockResolvedValue(false),
  } as never);
  container.registerInstance(DockerWorkloadResolverService, { resolve: vi.fn().mockResolvedValue(null) } as never);
  container.registerInstance(TOKENS.DrizzleClient, {} as never);
  return docker;
}

function post(app: OpenAPIHono<AppEnv>, path: string, body: unknown, method = 'POST') {
  return app.request(`/nodes/${NODE_ID}/containers/${CONTAINER_ID}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  container.reset();
});

describe('container recreate/update scope requirements', () => {
  it('keeps a plain recreate on manage and gates execution changes like duplicate', () => {
    expect(containerRecreateRequiredScopes({})).toEqual([]);
    expect(containerRecreateRequiredScopes({ ports: [] })).toEqual(['docker:containers:edit']);
    for (const field of ['image', 'entrypoint', 'command', 'user', 'runtimeProfile']) {
      expect(containerRecreateRequiredScopes({ [field]: field === 'image' ? 'nginx:1' : ['x'] })).toEqual([
        'docker:containers:edit',
        'docker:containers:environment',
        'docker:containers:secrets',
      ]);
    }
    expect(containerUpdateRequiredScopes({ tag: '2' } as never)).toEqual([]);
    expect(containerUpdateRequiredScopes({ env: { A: '1' } })).toEqual(['docker:containers:environment']);
    expect(containerUpdateRequiredScopes({ removeEnv: ['A'] })).toEqual(['docker:containers:environment']);
  });

  it('refuses a manage-only recreate that replaces the command', async () => {
    const docker = registerDocker();

    const response = await post(appWithScopes(MANAGE_ONLY), '/recreate', { command: ['sh', '-c', 'env'] });

    expect(response.status).toBe(403);
    expect(docker.recreateWithConfig).not.toHaveBeenCalled();
  });

  it('allows a manage-only plain recreate', async () => {
    const docker = registerDocker();

    const response = await post(appWithScopes(MANAGE_ONLY), '/recreate', {});

    expect(response.status).toBe(200);
    expect(docker.recreateWithConfig).toHaveBeenCalledOnce();
  });

  it('requires images:pull for an image change', async () => {
    const docker = registerDocker();

    const denied = await post(appWithScopes(FULL.filter((scope) => scope !== 'docker:images:pull')), '/recreate', {
      image: 'nginx:1.27',
    });
    expect(denied.status).toBe(403);
    expect(docker.recreateWithConfig).not.toHaveBeenCalled();

    const allowed = await post(appWithScopes(FULL), '/recreate', { image: 'nginx:1.27' });
    expect(allowed.status).toBe(200);
    expect(docker.recreateWithConfig).toHaveBeenCalledOnce();
  });

  it('requires the environment scope for env changes through /update', async () => {
    const docker = registerDocker();

    const denied = await post(appWithScopes(['docker:containers:edit']), '/update', { env: { A: '1' } });
    expect(denied.status).toBe(403);
    expect(docker.updateContainer).not.toHaveBeenCalled();

    const tagOnly = await post(appWithScopes(['docker:containers:edit']), '/update', { tag: '2' });
    expect(tagOnly.status).toBe(200);
    expect(docker.updateContainer).toHaveBeenCalledOnce();
  });
});

describe('per-node container and deployment lists', () => {
  it.each([
    ['docker:containers:view:folder/folder-1'],
    ['docker:containers:create:folder/folder-1'],
  ])('answer an empty list for %s without reading the node', async (scope) => {
    const docker = registerDocker();
    const snapshots = { assertDockerNode: vi.fn(), getList: vi.fn() };
    container.registerInstance(DockerSnapshotService, snapshots as never);
    const app = appWithScopes([scope]);

    const response = await app.request(`/nodes/${NODE_ID}/containers`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [], total: 0, truncated: false });
    expect(snapshots.getList).not.toHaveBeenCalled();
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  it('still refuses callers without any container view or creation grant', async () => {
    registerDocker();
    container.registerInstance(DockerSnapshotService, { assertDockerNode: vi.fn(), getList: vi.fn() } as never);

    const response = await appWithScopes(['docker:images:view']).request(`/nodes/${NODE_ID}/containers`);

    expect(response.status).toBe(403);
  });
});

describe('container duplicate scope requirements', () => {
  it('needs create plus the environment and secrets of the source container', async () => {
    const docker = Object.assign(registerDocker(), {
      duplicateContainer: vi.fn().mockResolvedValue({ id: 'copy-1' }),
    });
    const scopes = [
      'docker:containers:create',
      `docker:containers:environment:${NODE_ID}/resource-a`,
      `docker:containers:secrets:${NODE_ID}/resource-a`,
    ];

    const denied = await post(
      appWithScopes(scopes.filter((scope) => !scope.startsWith('docker:containers:secrets'))),
      '/duplicate',
      { name: 'app-b' }
    );
    expect(denied.status).toBe(403);

    const allowed = await post(appWithScopes(scopes), '/duplicate', { name: 'app-b' });
    expect(allowed.status).toBe(201);
    expect(docker.duplicateContainer).toHaveBeenCalledWith(NODE_ID, CONTAINER_ID, 'app-b', 'user-1', scopes, undefined);
  });
});

describe('container secret routes', () => {
  it('binds secret update and delete to the container in the path', async () => {
    registerDocker();
    const secrets = {
      update: vi.fn().mockResolvedValue({ id: 'secret-1' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(DockerSecretService, secrets as never);
    const app = appWithScopes(['docker:containers:secrets']);

    expect((await post(app, '/secrets/secret-1', { value: 'next' }, 'PUT')).status).toBe(200);
    expect(secrets.update).toHaveBeenCalledWith('secret-1', NODE_ID, 'next', 'user-1', 'app-a');

    expect((await post(app, '/secrets/secret-1', undefined, 'DELETE')).status).toBe(200);
    expect(secrets.delete).toHaveBeenCalledWith('secret-1', NODE_ID, 'user-1', 'app-a');
  });
});

describe('inspect by name for availability-managed containers', () => {
  function registerRuntimeTarget() {
    const liveInspect = {
      Id: 'runtime-1',
      Name: '/app-a',
      Config: { Env: ['DATABASE_URL=postgres://user:pw@db/app'], Labels: {} },
    };
    container.registerInstance(DockerManagementService, {
      inspectContainer: vi.fn().mockResolvedValue(liveInspect),
      decorateContainerDetailSnapshot: vi.fn(async (_nodeId: string, data: unknown) => data),
    } as never);
    container.registerInstance(DockerAvailabilityService, {
      resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue({ nodeId: NODE_ID, resourceId: 'resource-a' }),
    } as never);
    container.registerInstance(DockerSnapshotService, {} as never);
    container.registerInstance(DockerWorkloadResolverService, {
      resolveContainerRuntimeTarget: vi.fn().mockResolvedValue({
        nodeId: NODE_ID,
        containerId: 'runtime-1',
        placementId: 'placement-1',
        workload: {
          policy: { id: 'policy-1', resourceKind: 'container', mode: 'ha' },
          managementTarget: { nodeId: NODE_ID, resourceId: 'app-a' },
        },
      }),
    } as never);
  }

  it('redacts the live environment without the environment scope', async () => {
    registerRuntimeTarget();

    const response = await appWithScopes(['docker:containers:view']).request(
      `/nodes/${NODE_ID}/containers/by-name/app-a`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { Config: Record<string, unknown> } };
    expect(body.data.Config.Env).toBeUndefined();
  });

  it('keeps the live environment for callers with the environment scope', async () => {
    registerRuntimeTarget();

    const response = await appWithScopes(['docker:containers:view', 'docker:containers:environment']).request(
      `/nodes/${NODE_ID}/containers/by-name/app-a`
    );

    const body = (await response.json()) as { data: { Config: Record<string, unknown> } };
    expect(body.data.Config.Env).toEqual(['DATABASE_URL=postgres://user:pw@db/app']);
  });
});

describe('archive import planning', () => {
  it('requires container create access on the target node', async () => {
    const { LicensePolicyService } = await import('@/modules/license/license-policy.service.js');
    container.registerInstance(LicensePolicyService, { requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
    const otherNode = '33333333-3333-4333-8333-333333333333';

    const response = await appWithScopes([`docker:containers:create:${otherNode}`]).request(
      `/nodes/${NODE_ID}/containers/archive/plan`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ networks: [], mounts: [], ports: [] }),
      }
    );

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain('destination node');
  });
});

describe('container archive export', () => {
  const EXPORT_SCOPES = [`docker:containers:export:${NODE_ID}/resource-a`];
  const EXPORT_PATH = `/nodes/${NODE_ID}/containers/${CONTAINER_ID}/archive?imageMode=registry&includeEnvironment=false`;

  function registerArchiveExport(labels: Record<string, string>) {
    const docker = registerDocker();
    docker.inspectContainer.mockResolvedValue({
      Id: CONTAINER_ID,
      Name: '/app-a',
      scopeResourceId: 'resource-a',
      Config: { Labels: labels },
    });
    const executeDockerArchive = vi.fn().mockResolvedValue({
      archiveId: 'archive-1',
      filename: 'app-a.gwca',
      stream: new Blob([Buffer.from('gwca')]).stream(),
    });
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    container.registerInstance(TOKENS.CommercialEdition, { executeDockerArchive } as never);
    container.registerInstance(LicensePolicyService, { requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
    container.registerInstance(AuditService, audit as never);
    container.registerInstance(DockerMigrationDispatchAdapter, {} as never);
    return { audit, executeDockerArchive };
  }

  it('refuses a Compose container before any export work starts', async () => {
    const { audit, executeDockerArchive } = registerArchiveExport({
      'com.docker.compose.project': 'shop',
      'com.docker.compose.service': 'web',
      'wiolett.gateway.compose.project-id': 'compose-1',
    });

    const response = await appWithScopes(EXPORT_SCOPES).request(EXPORT_PATH);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'DOCKER_ARCHIVE_COMPOSE_CONTAINER',
      message:
        'This container belongs to Compose project shop and cannot be exported as a container archive; manage it through the Compose project instead',
      details: { nodeId: NODE_ID, containerId: CONTAINER_ID, projectName: 'shop', projectId: 'compose-1' },
    });
    expect(executeDockerArchive).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('streams a standalone container archive', async () => {
    const { audit, executeDockerArchive } = registerArchiveExport({ 'com.example.team': 'web' });

    const response = await appWithScopes(EXPORT_SCOPES).request(EXPORT_PATH);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="app-a.gwca"');
    expect(await response.text()).toBe('gwca');
    expect(executeDockerArchive).toHaveBeenCalledWith(
      'openGwcaExport',
      expect.objectContaining({ nodeId: NODE_ID, containerId: CONTAINER_ID, imageMode: 'registry' }),
      expect.anything()
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'docker.container.archive.export' }));
  });
});
