import { describe, expect, it, vi } from 'vitest';
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

  it('keeps an adopted project external while only preparing its first revision', async () => {
    const compose = service();
    vi.spyOn(compose as any, 'getProject').mockResolvedValue(PROJECT);
    vi.spyOn(compose as any, 'insertRevision').mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      revisionNumber: 1,
    });

    const result = await compose.adopt(
      PROJECT.nodeId,
      PROJECT.id,
      { yaml: 'services:\n  api:\n    image: nginx:alpine\n', variables: {}, secretKeys: [] },
      'user-1'
    );

    expect(result.project.managementState).toBe('external');
    expect(result.revision).toMatchObject({ revisionNumber: 1 });
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

  it('accepts an idempotent retry after jsonb changes object key order', () => {
    const compose = service();
    expect(() =>
      (compose as any).assertIdempotentOperation(
        {
          action: 'apply',
          revisionId: '33333333-3333-4333-8333-333333333333',
          options: { volumeNames: [], removeOrphans: false },
        },
        'apply',
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
