import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { DockerComposeService } from './compose.service.js';

function service() {
  return new DockerComposeService(
    {} as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never
  );
}

const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  nodeId: '22222222-2222-4222-8222-222222222222',
  name: 'demo',
  managementState: 'external',
  desiredState: 'running',
  status: 'discovered',
  availability: 'available',
  activeRevisionId: null,
  observedFingerprint: null,
  lastSeenAt: new Date(),
  createdById: null,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

describe('DockerComposeService', () => {
  it.each([
    'operation_started',
    'operation_succeeded',
    'operation_failed',
    'operation_cancelled',
  ])('preserves %s as the notification event discriminator', (action) => {
    const compose = service() as any;
    compose.eventBus = { publish: vi.fn() };
    compose.emit(action, PROJECT, { operationId: 'op-1', action: 'stop' });
    expect(compose.eventBus.publish).toHaveBeenCalledWith('docker.compose.changed', {
      action,
      operationAction: 'stop',
      operationId: 'op-1',
      projectId: PROJECT.id,
      projectName: PROJECT.name,
      nodeId: PROJECT.nodeId,
    });
  });
  it('reuses an identical revision when reapplying updated secret values', async () => {
    const compose = service() as any;
    const input = {
      yaml: 'services:\n  api:\n    image: nginx:alpine\n    environment:\n      TOKEN: $' + '{TOKEN}\n',
      variables: {},
      secretKeys: ['TOKEN'],
    };
    compose.getProject = vi.fn().mockResolvedValue({ ...PROJECT, managementState: 'managed' });
    compose.addCurrentManagedDatabaseBindings = vi.fn().mockResolvedValue(input);
    compose.insertRevision = vi.fn().mockRejectedValue(new AppError(409, 'COMPOSE_REVISION_EXISTS', 'exists'));
    const existing = { id: 'existing-revision', revisionNumber: 2, secretKeys: ['TOKEN'] };
    compose.getRevisionByDigest = vi.fn().mockResolvedValue(existing);
    compose.emit = vi.fn();
    await expect(compose.createRevision(PROJECT.nodeId, PROJECT.id, input, 'user-1')).resolves.toBe(existing);
    expect(compose.getRevisionByDigest).toHaveBeenCalledWith(PROJECT.id, expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(compose.emit).not.toHaveBeenCalled();
    expect(compose.audit.log).not.toHaveBeenCalled();
  });

  it.each([
    'COMPOSE_REVISION_EXISTS',
    'COMPOSE_REVISION_CONFLICT',
  ])('preserves %s when no exact reusable revision is available', async (code) => {
    const compose = service() as any;
    const input = { yaml: 'services:\n  api:\n    image: nginx:alpine\n', variables: {}, secretKeys: [] };
    compose.getProject = vi.fn().mockResolvedValue({ ...PROJECT, managementState: 'managed' });
    compose.addCurrentManagedDatabaseBindings = vi.fn().mockResolvedValue(input);
    const error = new AppError(409, code, 'conflict');
    compose.insertRevision = vi.fn().mockRejectedValue(error);
    compose.getRevisionByDigest = vi.fn().mockResolvedValue(null);
    await expect(compose.createRevision(PROJECT.nodeId, PROJECT.id, input, 'user-1')).rejects.toBe(error);
    if (code === 'COMPOSE_REVISION_CONFLICT') expect(compose.getRevisionByDigest).not.toHaveBeenCalled();
  });

  it('waits for the HA revision operation before marking a Git pull_apply successful', async () => {
    const compose = service() as any;
    const patches: unknown[] = [];
    compose.db = {
      update: () => ({
        set: (patch: unknown) => {
          patches.push(patch);
          return { where: vi.fn() };
        },
      }),
    };
    compose.tasks = { update: vi.fn() };
    compose.emit = vi.fn();
    let complete!: () => void;
    const applyRevision = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = () => resolve(true);
        })
    );
    compose.setAvailabilityCoordinator({ applyRevision });
    const applying = compose.executeAvailabilityOperation(
      PROJECT,
      { id: 'built-revision' },
      'operation',
      'task',
      'pull_apply',
      'actor'
    );
    await vi.waitFor(() => expect(applyRevision).toHaveBeenCalledWith(PROJECT.id, 'built-revision', 'actor'));
    expect(patches).not.toContainEqual(expect.objectContaining({ status: 'succeeded' }));
    complete();
    await applying;
    expect(patches).toContainEqual(expect.objectContaining({ status: 'succeeded' }));
    expect(patches).toContainEqual(expect.objectContaining({ activeRevisionId: 'built-revision' }));
  });

  it('creates a managed pending project for a repository-backed first revision', async () => {
    const returning = vi.fn().mockResolvedValue([{ ...PROJECT, managementState: 'managed', status: 'validating' }]);
    const values = vi.fn(() => ({ returning }));
    const db = { insert: vi.fn(() => ({ values })) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const compose = new DockerComposeService(db as never, audit as never, {} as never, {} as never);

    await expect(compose.createPendingGitProject(PROJECT.nodeId, 'demo', 'user-1')).resolves.toMatchObject({
      managementState: 'managed',
      status: 'validating',
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: PROJECT.nodeId,
        name: 'demo',
        managementState: 'managed',
        desiredState: 'running',
        status: 'validating',
      })
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'docker.compose.source.create', resourceId: PROJECT.id })
    );
  });

  it('completes adoption metadata before the runtime apply starts', async () => {
    const compose = service();
    vi.spyOn(compose as any, 'getProject').mockResolvedValue(PROJECT);
    vi.spyOn(compose as any, 'getRevisionByDigest').mockResolvedValue(null);
    vi.spyOn(compose as any, 'insertRevision').mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 1,
    });
    vi.spyOn(compose as any, 'completeAdoption').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
      desiredState: 'stopped',
      status: 'stopped',
      activeRevisionId: '33333333-3333-4333-8333-333333333333',
    });

    const result = await compose.adopt(
      PROJECT.nodeId,
      PROJECT.id,
      { yaml: 'services:\n  api:\n    image: nginx:alpine\n', variables: {}, secretKeys: [] },
      'user-1'
    );

    expect(result.project.managementState).toBe('managed');
    expect(result.project.status).toBe('stopped');
    expect(result.revision).toMatchObject({ revisionNumber: 1 });
  });

  it('reuses an already prepared adoption revision after an interrupted request', async () => {
    const compose = service();
    const revision = {
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 1,
    };
    vi.spyOn(compose as any, 'getProject').mockResolvedValue(PROJECT);
    vi.spyOn(compose as any, 'getRevisionByDigest').mockResolvedValue(revision);
    vi.spyOn(compose as any, 'completeAdoption').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
      desiredState: 'stopped',
      status: 'stopped',
      activeRevisionId: revision.id,
    });
    const insertRevision = vi.spyOn(compose as any, 'insertRevision');

    const result = await compose.adopt(
      PROJECT.nodeId,
      PROJECT.id,
      { yaml: 'services:\n  api:\n    image: nginx:alpine\n', variables: {}, secretKeys: [] },
      'user-1'
    );

    expect(result.revision).toBe(revision);
    expect(insertRevision).not.toHaveBeenCalled();
  });

  it('returns the active revision when a completed adoption is retried unchanged', async () => {
    const compose = service();
    const revision = {
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 1,
    };
    const managedProject = {
      ...PROJECT,
      managementState: 'managed',
      desiredState: 'stopped',
      status: 'stopped',
      activeRevisionId: revision.id,
    };
    vi.spyOn(compose as any, 'getProject').mockResolvedValue(managedProject);
    vi.spyOn(compose as any, 'getRevisionByDigest').mockResolvedValue(revision);
    const completeAdoption = vi.spyOn(compose as any, 'completeAdoption');

    const result = await compose.adopt(
      PROJECT.nodeId,
      PROJECT.id,
      { yaml: 'services:\n  api:\n    image: nginx:alpine\n', variables: {}, secretKeys: [] },
      'user-1'
    );

    expect(result.project).toBe(managedProject);
    expect(result.revision).toBe(revision);
    expect(completeAdoption).not.toHaveBeenCalled();
  });

  it('maps nested Postgres revision uniqueness errors to a stable conflict', async () => {
    const databaseError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'docker_compose_revisions_project_digest_unique',
    });
    const db = {
      transaction: vi.fn().mockRejectedValue(Object.assign(new Error('Failed query'), { cause: databaseError })),
    };
    const compose = new DockerComposeService(
      db as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never
    );

    await expect(
      (compose as any).insertRevision(
        PROJECT,
        { yaml: 'services: {}', variables: {}, secretKeys: [] },
        { name: PROJECT.name, services: {} },
        'digest',
        'user-1'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMPOSE_REVISION_EXISTS' });
  });

  it('stores clean source YAML separately from managed runtime overlays', async () => {
    const compose = service();
    const sourceYaml = `services:\n  api:\n    image: example/api:latest\n  worker:\n    image: example/worker:latest\n`;
    const effectiveYaml = `services:\n  api:\n    image: example/api:latest\n    environment:\n      DATABASE_URL: \${GATEWAY_DB_BINDING_URL}\n    networks:\n      gateway_db_binding: null\n  worker:\n    image: example/worker:latest\nnetworks:\n  gateway_db_binding:\n    external: true\n    name: gateway-db-binding\n`;
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
    });
    vi.spyOn(compose as any, 'addCurrentManagedDatabaseBindings').mockResolvedValue({
      yaml: effectiveYaml,
      variables: {},
      secretKeys: ['GATEWAY_DB_BINDING_URL'],
    });
    const insertRevision = vi.spyOn(compose as any, 'insertRevision').mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 2,
    });

    await compose.createRevision(
      PROJECT.nodeId,
      PROJECT.id,
      { yaml: sourceYaml, variables: {}, secretKeys: [] },
      'user-1'
    );

    expect(insertRevision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ yaml: effectiveYaml, secretKeys: ['GATEWAY_DB_BINDING_URL'] }),
      expect.objectContaining({
        services: expect.objectContaining({ api: expect.anything(), worker: expect.anything() }),
      }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      'user-1',
      sourceYaml
    );
  });

  it('fails managed lifecycle closed until a compatible daemon dispatcher is configured', async () => {
    const compose = service();
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({ ...PROJECT, managementState: 'managed' });

    await expect(
      compose.startOperation(
        PROJECT.nodeId,
        PROJECT.id,
        'start',
        {
          idempotencyKey: 'request-0001',
          removeOrphans: false,
          volumeNames: [],
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'COMPOSE_CAPABILITY_UNAVAILABLE', statusCode: 409 });
  });

  it('returns a bounded Compose activity page with an opaque next cursor', async () => {
    const rows = [
      { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date('2026-08-25T10:00:00Z') },
      { id: '22222222-2222-4222-8222-222222222222', createdAt: new Date('2026-08-25T09:00:00Z') },
      { id: '33333333-3333-4333-8333-333333333333', createdAt: new Date('2026-08-25T08:00:00Z') },
    ];
    const limit = vi.fn().mockResolvedValue(rows);
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit }) }),
        }),
      })),
    };
    const compose = new DockerComposeService(db as never, { log: vi.fn() } as never, {} as never, {} as never);
    vi.spyOn(compose as any, 'getProject').mockResolvedValue(PROJECT);

    const result = await compose.listOperations(PROJECT.nodeId, PROJECT.id, { limit: 2 });

    expect(limit).toHaveBeenCalledWith(3);
    expect(result.data).toEqual(rows.slice(0, 2));
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it('rejects malformed Compose activity cursors', async () => {
    const compose = service();
    vi.spyOn(compose as any, 'getProject').mockResolvedValue(PROJECT);

    await expect(
      compose.listOperations(PROJECT.nodeId, PROJECT.id, { limit: 50, cursor: 'not-a-cursor' })
    ).rejects.toMatchObject({ code: 'COMPOSE_OPERATION_CURSOR_INVALID', statusCode: 400 });
  });

  it('redacts secret values and bounds persisted operation errors', () => {
    const compose = service();
    const sanitized = (compose as any).sanitizeOperationError(
      new Error(`registry rejected password super-secret ${'x'.repeat(5000)}`),
      { PASSWORD: 'super-secret' }
    );

    expect(sanitized).not.toContain('super-secret');
    expect(sanitized).toContain('***');
    expect(sanitized.length).toBeLessThanOrEqual(4000);
  });

  it('does not mark a stopped managed project as drifted after a failed first apply', () => {
    const compose = service();
    const runtime = (compose as any).projectRuntime(
      { containers: [], volumes: [], networks: [] },
      'demo',
      { ...PROJECT, managementState: 'managed', desiredState: 'stopped', status: 'failed' },
      { configDigest: 'digest' }
    );

    expect(runtime.drifted).toBe(false);
  });

  it('removes Compose runtime resources before deleting project metadata', async () => {
    const compose = service();
    const refreshNow = vi.fn().mockResolvedValue(undefined);
    (compose as any).snapshotReconciler = { refreshNow };
    vi.spyOn(compose as any, 'getRevision').mockResolvedValue({ configDigest: 'digest' });
    vi.spyOn(compose as any, 'loadNodeRuntime')
      .mockResolvedValueOnce({
        containers: [
          {
            name: 'demo-web-1',
            state: 'exited',
            labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.service': 'web' },
          },
        ],
        volumes: [
          {
            name: 'demo_data',
            labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.volume': 'data' },
          },
        ],
        networks: [
          {
            name: 'demo_default',
            labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.network': 'default' },
          },
        ],
      })
      .mockResolvedValueOnce({ containers: [], volumes: [], networks: [] });
    const startOperation = vi
      .spyOn(compose, 'startOperation')
      .mockResolvedValueOnce({ id: 'down-operation' } as never)
      .mockResolvedValueOnce({ id: 'volume-operation' } as never);
    const waitForOperation = vi.spyOn(compose, 'waitForOperation').mockResolvedValue({} as never);
    const project = {
      ...PROJECT,
      managementState: 'managed',
      activeRevisionId: '33333333-3333-4333-8333-333333333333',
    };

    await expect((compose as any).cleanupProjectRuntime(project, 'user-1')).resolves.toEqual({
      removedVolumes: ['demo_data'],
    });
    expect(startOperation).toHaveBeenNthCalledWith(
      1,
      project.nodeId,
      project.id,
      'down',
      expect.objectContaining({ removeOrphans: true }),
      'user-1',
      true
    );
    expect(startOperation).toHaveBeenNthCalledWith(
      2,
      project.nodeId,
      project.id,
      'delete_volumes',
      expect.objectContaining({ volumeNames: ['demo_data'] }),
      'user-1',
      true
    );
    expect(waitForOperation).toHaveBeenCalledTimes(2);
    expect(refreshNow).toHaveBeenCalledTimes(6);
  });

  it('blocks user lifecycle operations while project deletion owns runtime cleanup', async () => {
    const limit = vi.fn().mockResolvedValue([{ status: 'deleting' }]);
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
    };
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const compose = new DockerComposeService(
      db as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never
    );
    (compose as any).dispatcher = { execute: vi.fn() };
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
      activeRevisionId: '33333333-3333-4333-8333-333333333333',
    } as never);
    vi.spyOn(compose as any, 'getRevision').mockResolvedValue({ id: 'revision-1' });

    await expect(
      compose.startOperation(
        PROJECT.nodeId,
        PROJECT.id,
        'start',
        { idempotencyKey: 'start-during-delete', removeOrphans: false, volumeNames: [] },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'COMPOSE_DELETE_IN_PROGRESS' });
  });

  it('uses the latest saved revision to clean up a failed first apply', async () => {
    const compose = service();
    const revision = { id: '33333333-3333-4333-8333-333333333333' };
    vi.spyOn(compose, 'listRevisions').mockResolvedValue([revision] as never);

    await expect(
      (compose as any).resolveOperationRevision(
        { ...PROJECT, activeRevisionId: null, managementState: 'managed' },
        'down'
      )
    ).resolves.toBe(revision);
  });

  it.each([
    'start',
    'stop',
    'restart',
    'down',
  ] as const)('uses the active immutable revision for %s operations', async (action) => {
    const compose = service();
    const revision = { id: '33333333-3333-4333-8333-333333333333' };
    const getRevision = vi.spyOn(compose as any, 'getRevision').mockResolvedValue(revision);

    await expect(
      (compose as any).resolveOperationRevision(
        { ...PROJECT, activeRevisionId: revision.id, managementState: 'managed' },
        action
      )
    ).resolves.toBe(revision);
    expect(getRevision).toHaveBeenCalledWith(PROJECT.id, revision.id);
  });

  it('rejects reuse of an idempotency key for a different operation payload', () => {
    const compose = service();
    expect(() =>
      (compose as any).assertIdempotentOperation(
        {
          action: 'start',
          revisionId: '33333333-3333-4333-8333-333333333333',
          options: { removeOrphans: false, volumeNames: [] },
        },
        'restart',
        '33333333-3333-4333-8333-333333333333',
        { removeOrphans: false, volumeNames: [] }
      )
    ).toThrowError(expect.objectContaining({ code: 'COMPOSE_IDEMPOTENCY_CONFLICT' }));
  });

  it('accepts a pull_apply retry for a legacy apply operation after jsonb changes object key order', () => {
    const compose = service();
    expect(() =>
      (compose as any).assertIdempotentOperation(
        {
          action: 'apply',
          revisionId: '33333333-3333-4333-8333-333333333333',
          options: { volumeNames: [], removeOrphans: false },
        },
        'pull_apply',
        '33333333-3333-4333-8333-333333333333',
        { removeOrphans: false, volumeNames: [] }
      )
    ).not.toThrow();
  });

  it('rejects deletion of the active immutable revision', async () => {
    const compose = service();
    const revision = {
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 2,
    };
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
      activeRevisionId: revision.id,
    });
    vi.spyOn(compose as any, 'getRevision').mockResolvedValue(revision);
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: vi.fn().mockResolvedValue([{ activeRevisionId: revision.id }]) }),
        }),
      })),
    };
    (compose as any).db = { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };

    await expect(compose.deleteRevision(PROJECT.nodeId, PROJECT.id, revision.id, 'user-1')).rejects.toMatchObject({
      code: 'COMPOSE_ACTIVE_REVISION',
      statusCode: 409,
    });
  });

  it('deletes an inactive revision and records the lifecycle event', async () => {
    const compose = service();
    let selectCall = 0;
    const returning = vi.fn().mockResolvedValue([{ id: '33333333-3333-4333-8333-333333333333' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const deleteFrom = vi.fn().mockReturnValue({ where });
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockImplementation(async () => {
              selectCall += 1;
              return selectCall === 1 ? [{ activeRevisionId: '44444444-4444-4444-8444-444444444444' }] : [];
            }),
          }),
        }),
      })),
      delete: deleteFrom,
    };
    (compose as any).db = { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };
    const emit = vi.spyOn(compose as any, 'emit').mockImplementation(() => undefined);
    const revision = {
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 1,
    };
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
      activeRevisionId: '44444444-4444-4444-8444-444444444444',
    });
    vi.spyOn(compose as any, 'getRevision').mockResolvedValue(revision);

    await compose.deleteRevision(PROJECT.nodeId, PROJECT.id, revision.id, 'user-1');

    expect(deleteFrom).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();
    expect((compose as any).audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.compose.revision.delete',
        resourceId: PROJECT.id,
        details: expect.objectContaining({ revisionId: revision.id, revisionNumber: 1 }),
      })
    );
    expect(emit).toHaveBeenCalledWith('revision_deleted', expect.anything(), {
      revisionId: revision.id,
    });
  });

  it('rejects deletion while a lifecycle operation is using the revision', async () => {
    const compose = service();
    const revision = {
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 2,
    };
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({
      ...PROJECT,
      managementState: 'managed',
      activeRevisionId: '44444444-4444-4444-8444-444444444444',
    });
    vi.spyOn(compose as any, 'getRevision').mockResolvedValue(revision);
    let selectCall = 0;
    const deleteFrom = vi.fn();
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockImplementation(async () => {
              selectCall += 1;
              return selectCall === 1
                ? [{ activeRevisionId: '44444444-4444-4444-8444-444444444444' }]
                : [{ id: '55555555-5555-4555-8555-555555555555' }];
            }),
          }),
        }),
      })),
      delete: deleteFrom,
    };
    (compose as any).db = { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };

    await expect(compose.deleteRevision(PROJECT.nodeId, PROJECT.id, revision.id, 'user-1')).rejects.toMatchObject({
      code: 'COMPOSE_REVISION_IN_USE',
      statusCode: 409,
    });
    expect(deleteFrom).not.toHaveBeenCalled();
  });

  it('marks managed database secrets as system-owned and rejects direct replacement', async () => {
    const secrets = {
      list: vi.fn().mockResolvedValue([
        { id: 'secret-user', key: 'API_KEY', value: '••••••••' },
        { id: 'secret-db', key: 'GATEWAY_DB_ABC_DEF', value: '••••••••' },
      ]),
      create: vi.fn(),
      update: vi.fn(),
    };
    const compose = new DockerComposeService({} as never, { log: vi.fn() } as never, {} as never, secrets as never);
    vi.spyOn(compose as any, 'getProject').mockResolvedValue({ ...PROJECT, managementState: 'managed' });

    await expect(compose.listSecrets(PROJECT.nodeId, PROJECT.id, false)).resolves.toEqual([
      expect.objectContaining({ key: 'API_KEY', system: false }),
      expect.objectContaining({ key: 'GATEWAY_DB_ABC_DEF', system: true }),
    ]);
    await expect(
      compose.createSecret(PROJECT.nodeId, PROJECT.id, 'GATEWAY_DB_CUSTOM', 'value', 'user-1')
    ).rejects.toMatchObject({ code: 'COMPOSE_SECRET_RESERVED' });
    await expect(
      compose.updateSecret(PROJECT.nodeId, PROJECT.id, 'secret-db', 'replacement', 'user-1')
    ).rejects.toMatchObject({ code: 'COMPOSE_SECRET_RESERVED' });
    expect(secrets.create).not.toHaveBeenCalled();
    expect(secrets.update).not.toHaveBeenCalled();
  });
});
