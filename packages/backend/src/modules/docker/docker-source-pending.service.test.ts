import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerBuilds } from '@/db/schema/index.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';
import { DockerSourceService, readPendingDockerSourceContainers } from './docker-source.service.js';

afterEach(() => vi.restoreAllMocks());

const binding = {
  id: 'source-1',
  targetKind: 'container',
  nodeId: 'node-1',
  containerName: 'api',
  deployedCommitSha: null,
  repositoryFullPath: 'team/api',
  createdAt: new Date('2026-09-04T00:00:00Z'),
  initialConfig: { name: 'api', runtimeProfile: 'secure', restartPolicy: 'no' },
};

function pendingDb(source = binding, runtimeId: string | null = null, scopeResourceId = 'resource-1') {
  const latest = { id: 'build-1', status: 'failed', errorCode: 'BUILD_ARTIFACT_POLICY_REJECTED' };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table) =>
        table === dockerBuilds
          ? { where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([latest]) })) })) }
          : { innerJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ source, runtimeId, scopeResourceId }]) })) }
      ),
    })),
  };
  return { db, latest };
}

describe('Pending source presentation', () => {
  it('returns a logical, stable identity with build status and no runtime/secret payload', async () => {
    const { db, latest } = pendingDb();
    expect(await readPendingDockerSourceContainers(db as never, 'node-1', 'api')).toEqual([
      {
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
        initialConfig: binding.initialConfig,
        latestBuild: latest,
      },
    ]);
  });

  it.each([
    { source: { ...binding, initialConfig: null } },
    { source: { ...binding, initialConfig: { ...binding.initialConfig, env: { SECRET: 'do-not-expose' } } } },
    { source: { ...binding, initialConfig: { ...binding.initialConfig, name: 'different' } } },
    { source: { ...binding, deployedCommitSha: 'deployed' } },
    { source: { ...binding, nodeId: 'other-node' } },
    { source: binding, runtimeId: 'real-container' },
    { source: binding, scopeResourceId: '' },
  ])('rejects unverified, activated or mismatched pending metadata: %j', async ({
    source,
    runtimeId,
    scopeResourceId,
  }) => {
    const { db } = pendingDb(source as never, runtimeId, scopeResourceId);
    expect(await readPendingDockerSourceContainers(db as never, 'node-1', 'api')).toEqual([]);
  });

  it('does not resolve a different name on the same node', async () => {
    const { db } = pendingDb();
    const service = new DockerSourceService(db as never, {} as never, {} as never, {} as never);
    expect(await service.getPendingContainer('node-1', 'other')).toBeNull();
  });
});

function creationHarness(conflict = false) {
  let persisted: any = null;
  const inserted = {
    ...binding,
    connectorId: 'connector-1',
    projectId: 'project-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const returning = vi.fn(async () => {
    if (conflict) return [];
    persisted = inserted;
    return [inserted];
  });
  const db: any = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning })) })) })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const integrations = {
    resolveDockerBuildSource: vi.fn().mockResolvedValue({
      connectorId: 'connector-1',
      projectId: 'project-1',
      provider: 'git',
      remoteId: 'remote-1',
      fullPath: 'team/api',
      cloneUrl: 'https://git.example/api.git',
      branch: 'main',
      commitSha: 'a'.repeat(40),
    }),
  };
  const service = new DockerSourceService(db, audit as never, integrations as never, {} as never);
  service.setLicensePolicyService({ requireFeature: vi.fn() } as never);
  const find = vi.spyOn(service as any, 'findByTarget').mockImplementation(async () => persisted);
  vi.spyOn(service as any, 'prepareSourceCommit').mockResolvedValue({ composeBuildPlan: null });
  (service as any).webhooks.reconcileWebhook = vi.fn().mockResolvedValue(undefined);
  const reserve = vi.spyOn(DockerAccessResourceService.prototype, 'ensureContainer').mockResolvedValue('resource-1');
  const release = vi
    .spyOn(DockerAccessResourceService.prototype, 'removePendingContainer')
    .mockResolvedValue('resource-1');
  const input = {
    target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    connectorId: 'connector-1',
    projectId: 'project-1',
    branch: 'main',
    policy: {},
    autoBuild: true,
    autoDeploy: true,
  } as never;
  const options = { createOnly: true, allowMissingTarget: true, initialConfig: binding.initialConfig };
  return { db, audit, integrations, service, reserve, release, find, input, options };
}

describe('Insert-only Source creation', () => {
  it('reserves stable access inside the same transaction as the initial Source insert', async () => {
    const { service, input, options, reserve, db } = creationHarness();
    expect(await service.upsert(input, { id: 'user-1' } as never, options)).toMatchObject({ id: 'source-1' });
    expect(reserve).toHaveBeenCalledExactlyOnceWith('node-1', 'api', '', false, db);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('rejects an existing reservation before resolving or changing its repository', async () => {
    const { service, input, options, find, integrations, db } = creationHarness();
    find.mockResolvedValue(binding);
    await expect(service.upsert(input, { id: 'user-1' } as never, options)).rejects.toMatchObject({
      code: 'SOURCE_RESOURCE_ALREADY_EXISTS',
    });
    expect(integrations.resolveDockerBuildSource).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('rejects concurrent duplicate inserts without deleting or adopting the winning reservation', async () => {
    const { service, input, options, reserve, db } = creationHarness(true);
    await expect(service.upsert(input, { id: 'user-1' } as never, options)).rejects.toMatchObject({
      code: 'SOURCE_RESOURCE_ALREADY_EXISTS',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('rolls back its own new Source and empty identity on a post-insert persistence failure', async () => {
    const { service, input, options, audit, release, db } = creationHarness();
    audit.log.mockRejectedValue(new Error('audit persistence unavailable'));
    await expect(service.upsert(input, { id: 'user-1' } as never, options)).rejects.toThrow(
      'audit persistence unavailable'
    );
    expect(db.delete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('node-1', 'api', db);
  });

  it('Source Disconnect releases an unactivated pending identity', async () => {
    const { service, find, release, db } = creationHarness();
    find.mockResolvedValue(binding);
    await expect(service.remove({ kind: 'container', nodeId: 'node-1', containerName: 'api' }, 'user-1')).resolves.toBe(
      true
    );
    expect(release).toHaveBeenCalledExactlyOnceWith('node-1', 'api', db);
  });

  it('Source Disconnect leaves an activated runtime identity intact', async () => {
    const { service, find, release } = creationHarness();
    find.mockResolvedValue({ ...binding, deployedCommitSha: 'already-deployed' });
    await expect(service.remove({ kind: 'container', nodeId: 'node-1', containerName: 'api' }, 'user-1')).resolves.toBe(
      true
    );
    expect(release).not.toHaveBeenCalled();
  });
});
