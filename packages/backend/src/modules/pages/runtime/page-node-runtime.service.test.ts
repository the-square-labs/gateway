import { describe, expect, it, vi } from 'vitest';
import {
  bindingInspectionKey,
  bindingInspectionMatches,
  type PageBindingExpectation,
} from './page-binding-inspection.js';
import {
  PageNodeRuntimeService,
  validatePageRouteIncludePath,
  validatePageRuntimeConfigPath,
} from './page-node-runtime.service.js';

const ROUTE_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_CONFIG_PATH = `/var/lib/nginx/pages/runtime-configs/routes/${ROUTE_ID}/current.js`;
const PREVIEW_CONFIG_PATH = '/var/lib/nginx/pages/runtime-configs/previews/preview-hash/current.js';

function selectResult(result: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = () => chain;
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe('Pages preview reconciliation review regressions', () => {
  it.each([
    ['certificate', false],
    ['certificate', true],
    ['materialization', false],
    ['materialization', true],
  ] as const)('isolates %s failure regardless of node order (reversed=%s)', async (failurePhase, reversed) => {
    const rows = [
      { nodeId: 'healthy', projectSlug: 'project', deployment: { id: 'good-1', previewHostname: 'good-1.example' } },
      { nodeId: 'healthy', projectSlug: 'project', deployment: { id: 'good-2', previewHostname: 'good-2.example' } },
      { nodeId: 'broken', projectSlug: 'project', deployment: { id: 'bad', previewHostname: 'bad.example' } },
    ];
    const failure = new Error('node unavailable');
    const certificates = {
      deployForPages: vi.fn(async (nodeId: string) => {
        if (nodeId === 'broken' && failurePhase === 'certificate') throw failure;
        return { certificateId: 'cert', certificateVersion: 'version' };
      }),
    };
    const db = { select: vi.fn(() => selectResult(reversed ? [...rows].reverse() : rows)) };
    const service = new PageNodeRuntimeService(db as never, {} as never, {} as never, certificates as never);
    const materialize = vi.spyOn(service as any, 'materializePreview').mockImplementation(async (nodeId) => {
      if (nodeId === 'broken') throw failure;
    });

    await expect(service.apply({ domain: 'example', certificateId: 'cert', labelTemplate: '{hash}' })).rejects.toBe(
      failure
    );

    expect(
      materialize.mock.calls
        .filter(([nodeId]) => nodeId === 'healthy')
        .map(([, deploymentId]) => deploymentId)
        .sort()
    ).toEqual(['good-1', 'good-2']);
    expect(certificates.deployForPages.mock.calls.filter(([nodeId]) => nodeId === 'healthy')).toHaveLength(1);
    expect(certificates.deployForPages.mock.calls.map(([nodeId]) => nodeId)).toEqual(
      reversed ? ['broken', 'healthy'] : ['healthy', 'broken']
    );
  });

  it('reconciles a disk generation ahead of the replica row before the next publication', async () => {
    let savedGeneration = 1;
    let activeGeneration = 2;
    const currentValue = { api: '/v2' };
    const versions = new Map<number, string>([
      [1, JSON.stringify({ api: '/v1' })],
      [2, JSON.stringify(currentValue)],
    ]);
    const inspectionState = {
      generation: 1,
      sourceGeneration: 2,
      value: currentValue,
      sha256: 'a'.repeat(64),
      size: 100,
      spaFallback: false,
      fallbackUrl: null,
    };
    const selects = [
      [inspectionState],
      [inspectionState],
      [{ replicaId: 'replica-1', runtimeConfigGeneration: 1, defaultGeneration: 2, value: currentValue }],
      [{ generation: 2 }],
      [{ replicaId: 'replica-1', deploymentId: 'deployment-1', nodeId: 'node-1', hostname: 'preview.example' }],
      [{ generation: 2 }],
    ];
    const db = {
      ...defaultRuntimeConfigLockDatabase(),
      select: vi.fn(() => selectResult(selects.shift() ?? [])),
      update: vi.fn(() => ({
        set: (values: { runtimeConfigGeneration: number }) => {
          savedGeneration = values.runtimeConfigGeneration;
          return { where: () => ({ returning: async () => [{ id: 'replica-1' }] }) };
        },
      })),
    };
    const dispatch = {
      sendPagesCommand: vi.fn(async (_nodeId, command) => {
        if (command.pagesInventory) {
          const bindings = JSON.parse(command.pagesInventory.expectationsJson.toString());
          return {
            matches: bindings.map((binding: { generation: number }) => binding.generation === activeGeneration),
          };
        }
        return {};
      }),
      sendPagesRuntimeConfigCommand: vi.fn(async (_nodeId, command) => {
        if (command.pagesStageRuntimeConfig) {
          const generation = Number(command.pagesStageRuntimeConfig.generation);
          const content = command.pagesStageRuntimeConfig.json.toString();
          if (versions.has(generation) && versions.get(generation) !== content)
            throw new Error('immutable generation conflict');
          versions.set(generation, content);
        }
        if (command.pagesActivateRuntimeConfig)
          activeGeneration = Number(command.pagesActivateRuntimeConfig.generation);
        return { configPath: PREVIEW_CONFIG_PATH };
      }),
    };
    const service = new PageNodeRuntimeService(db as never, {} as never, dispatch as never, {} as never);
    vi.spyOn(service as any, 'assertProfileEnabled').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'previewProjectConfig').mockResolvedValue({ projectId: 'project-1' });
    const repair = vi.spyOn(service as any, 'ensureRelease').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'markPreviewReplicaReady').mockResolvedValue(true);
    const certificate = { certificateId: 'cert', certificateVersion: 'version' };
    const expectation = await (service as any).previewExpectation(
      'node-1',
      'deployment-1',
      'preview.example',
      certificate
    );
    expect(expectation.generation).toBe(1);
    const inspection = await service.inspectBindings([{ nodeId: 'node-1', expectation }]);
    await (service as any).materializePreview('node-1', 'deployment-1', 'preview.example', certificate, inspection);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(savedGeneration).toBe(2);
    expect(activeGeneration).toBe(2);

    await service.publishPreviewRuntimeConfig('project-1', { api: '/v3' });
    expect(savedGeneration).toBe(3);
    expect(activeGeneration).toBe(3);
    expect(versions.get(2)).toBe(JSON.stringify(currentValue));
    expect(versions.get(3)).toBe(JSON.stringify({ api: '/v3' }));
    expect(selects).toHaveLength(0);
  });
});

describe('Pages reconciliation inspection', () => {
  const expectation: PageBindingExpectation = {
    kind: 'preview',
    id: 'preview.example',
    deploymentId: 'deployment-1',
    sha256: 'a'.repeat(64),
    size: 100,
    generation: 2,
    stateGeneration: 1,
    runtimeConfig: { api: '/v1' },
    certificateId: 'cert-1',
    certificateVersion: 'version-1',
  };

  it('batches by node, requires explicit matches and discards results after each call', async () => {
    const dispatch = {
      sendPagesCommand: vi
        .fn()
        .mockResolvedValueOnce({ matches: [true, false] })
        .mockResolvedValueOnce({}),
    };
    const service = new PageNodeRuntimeService({} as never, {} as never, dispatch as never, {} as never);
    const second = { ...expectation, id: 'second.example' };
    const bindings = [
      { nodeId: 'node-1', expectation },
      { nodeId: 'node-1', expectation: second },
    ];
    const inspected = await service.inspectBindings(bindings);
    expect(dispatch.sendPagesCommand).toHaveBeenCalledTimes(1);
    expect(JSON.parse(dispatch.sendPagesCommand.mock.calls[0][1].pagesInventory.expectationsJson.toString())).toEqual([
      expectation,
      second,
    ]);
    expect(bindingInspectionMatches(inspected, 'node-1', expectation)).toBe(true);
    expect(bindingInspectionMatches(inspected, 'node-1', second)).toBe(false);
    expect(bindingInspectionMatches(inspected, 'node-1', { ...expectation, stateGeneration: 2 })).toBe(false);
    expect(bindingInspectionMatches(inspected, 'node-1', { ...expectation, runtimeConfig: { api: '/v2' } })).toBe(
      false
    );
    expect((await service.inspectBindings(bindings)).size).toBe(0);
  });

  it('requires advertised support, never a daemon version guess', async () => {
    const legacy = new PageNodeRuntimeService({} as never, {} as never, {} as never, {} as never);
    expect(await legacy.supportsInspection('node-1')).toBe(false);
  });

  it('does not let a failed node inspection abort other nodes or claim readiness', async () => {
    const dispatch = {
      sendPagesCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error('disconnected'))
        .mockResolvedValueOnce({ matches: [true] }),
    };
    const service = new PageNodeRuntimeService({} as never, {} as never, dispatch as never, {} as never);
    const result = await service.inspectBindings([
      { nodeId: 'node-1', expectation },
      { nodeId: 'node-2', expectation },
    ]);
    expect(bindingInspectionMatches(result, 'node-1', expectation)).toBe(false);
    expect(bindingInspectionMatches(result, 'node-2', expectation)).toBe(true);
  });

  it('invalidates a preview snapshot when Default changes before the lock is acquired', async () => {
    const db = defaultRuntimeConfigLockDatabase();
    const service = new PageNodeRuntimeService(db as never, {} as never, {} as never, {} as never);
    vi.spyOn(service as any, 'assertProfileEnabled').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'previewProjectConfig').mockResolvedValue({ projectId: 'project-1' });
    vi.spyOn(service as any, 'previewExpectation').mockResolvedValue({ ...expectation, stateGeneration: 2 });
    const needsRepair = new Error('entered normal repair');
    const repair = vi.spyOn(service as any, 'ensureRelease').mockRejectedValue(needsRepair);
    vi.spyOn(service as any, 'markReplica').mockResolvedValue(undefined);
    const inspection = new Map([[bindingInspectionKey('node-1', expectation), { expectation, matches: true }]]);
    await expect(
      (service as any).materializePreview(
        'node-1',
        'deployment-1',
        'preview.example',
        { certificateId: 'cert-1', certificateVersion: 'version-1' },
        inspection
      )
    ).rejects.toBe(needsRepair);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('rechecks the preview under profile and Default locks before skipping all writes', async () => {
    const db = { ...defaultRuntimeConfigLockDatabase(), update: vi.fn() };
    const dispatch = { sendPagesCommand: vi.fn(), sendPagesRuntimeConfigCommand: vi.fn() };
    const service = new PageNodeRuntimeService(db as never, {} as never, dispatch as never, {} as never);
    vi.spyOn(service as any, 'assertProfileEnabled').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'previewProjectConfig').mockResolvedValue({ projectId: 'project-1' });
    const current = vi.spyOn(service as any, 'previewExpectation').mockImplementation(async () => {
      expect(db.client.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_lock'))).toHaveLength(2);
      return expectation;
    });
    const ensureRelease = vi.spyOn(service as any, 'ensureRelease');
    const inspection = new Map([[bindingInspectionKey('node-1', expectation), { expectation, matches: true }]]);
    await (service as any).materializePreview(
      'node-1',
      'deployment-1',
      'preview.example',
      { certificateId: 'cert-1', certificateVersion: 'version-1' },
      inspection
    );
    expect(current).toHaveBeenCalledTimes(1);
    expect(ensureRelease).not.toHaveBeenCalled();
    expect(dispatch.sendPagesCommand).not.toHaveBeenCalled();
    expect(dispatch.sendPagesRuntimeConfigCommand).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

function runtimeConfigCommandResponse(_nodeId: string, command: Record<string, unknown>) {
  const activate = command.pagesActivateRuntimeConfig as { bindingKind?: string } | undefined;
  return Promise.resolve({
    configPath:
      activate?.bindingKind === 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE' ? ROUTE_CONFIG_PATH : PREVIEW_CONFIG_PATH,
  });
}

function defaultRuntimeConfigLockDatabase() {
  const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
  return { client, $client: { connect: vi.fn().mockResolvedValue(client) } };
}

describe('Pages daemon Route include contract', () => {
  it('accepts the daemon custom config directory with the exact managed suffix', () => {
    expect(validatePageRouteIncludePath(ROUTE_ID, `/custom/nginx/conf.d/pages/routes/${ROUTE_ID}.inc`)).toBe(
      `/custom/nginx/conf.d/pages/routes/${ROUTE_ID}.inc`
    );
  });

  it.each([
    `pages/routes/${ROUTE_ID}.inc`,
    `/custom/nginx/conf.d/pages/routes/22222222-2222-4222-8222-222222222222.inc`,
    `/custom/nginx/conf.d/pages/routes/${ROUTE_ID}.conf`,
    `/custom/nginx/conf.d/pages/routes/${ROUTE_ID}.inc\ninclude /tmp/evil`,
  ])('rejects an untrusted include path: %s', (path) => {
    expect(() => validatePageRouteIncludePath(ROUTE_ID, path)).toThrowError(
      expect.objectContaining({ code: 'PAGES_ROUTE_INCLUDE_INVALID' })
    );
  });
});

describe('Pages runtime config path contract', () => {
  it('accepts only the exact managed Route runtime config suffix', () => {
    expect(validatePageRuntimeConfigPath('route', ROUTE_ID, ROUTE_CONFIG_PATH)).toBe(ROUTE_CONFIG_PATH);
    expect(() => validatePageRuntimeConfigPath('route', ROUTE_ID, '/tmp/current.js')).toThrowError(
      expect.objectContaining({ code: 'PAGES_RUNTIME_CONFIG_PATH_INVALID' })
    );
  });
});

describe('Pages runtime config daemon commands', () => {
  it('stages JSON before atomically activating the same binding generation', async () => {
    const dispatch = { sendPagesRuntimeConfigCommand: vi.fn(runtimeConfigCommandResponse) };
    const service = new PageNodeRuntimeService({} as never, {} as never, dispatch as never, {} as never);

    await service.publishRuntimeConfig('node-1', 'route', ROUTE_ID, 7, { api: '/v1' });

    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(1, 'node-1', {
      pagesStageRuntimeConfig: {
        bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE',
        bindingId: ROUTE_ID,
        generation: '7',
        json: Buffer.from('{"api":"/v1"}'),
      },
    });
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(2, 'node-1', {
      pagesActivateRuntimeConfig: {
        bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE',
        bindingId: ROUTE_ID,
        generation: '7',
      },
    });
  });

  it('discards a failed activation generation so changed content can retry', async () => {
    const activationError = new Error('activate failed');
    const dispatch = {
      sendPagesRuntimeConfigCommand: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(activationError)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ configPath: ROUTE_CONFIG_PATH }),
    };
    const service = new PageNodeRuntimeService({} as never, {} as never, dispatch as never, {} as never);

    await expect(service.publishRuntimeConfig('node-1', 'route', ROUTE_ID, 7, { api: '/v1' })).rejects.toBe(
      activationError
    );
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(3, 'node-1', {
      pagesRemoveRuntimeConfig: {
        bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE',
        bindingId: ROUTE_ID,
        generation: '7',
      },
    });

    await service.publishRuntimeConfig('node-1', 'route', ROUTE_ID, 7, { api: '/v2' });
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(4, 'node-1', {
      pagesStageRuntimeConfig: {
        bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE',
        bindingId: ROUTE_ID,
        generation: '7',
        json: Buffer.from('{"api":"/v2"}'),
      },
    });
  });

  it('surfaces activation cleanup failure instead of hiding the staged generation', async () => {
    const activationError = new Error('activate failed');
    const cleanupError = new Error('cleanup failed');
    const dispatch = {
      sendPagesRuntimeConfigCommand: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(activationError)
        .mockRejectedValueOnce(cleanupError),
    };
    const service = new PageNodeRuntimeService({} as never, {} as never, dispatch as never, {} as never);

    await expect(service.publishRuntimeConfig('node-1', 'route', ROUTE_ID, 7, { api: '/v1' })).rejects.toBeInstanceOf(
      AggregateError
    );
  });

  it('re-reads Default after a concurrent save before marking a preview ready', async () => {
    const states = [
      { enabled: true },
      { projectId: 'project-1' },
      { replicaId: 'replica-1', runtimeConfigGeneration: 0, defaultGeneration: 1, value: { api: 'A' } },
      { generation: 2 },
      { replicaId: 'replica-1', runtimeConfigGeneration: 1, defaultGeneration: 2, value: { api: 'B' } },
      { generation: 2 },
    ];
    const query = () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => chain;
      chain.limit = vi.fn().mockResolvedValue([states.shift()]);
      return chain;
    };
    const updateReturning = vi.fn().mockResolvedValue([{ id: 'replica-1' }]);
    const db = {
      ...defaultRuntimeConfigLockDatabase(),
      select: vi.fn(query),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: updateReturning }),
        }),
      })),
    };
    const dispatch = {
      sendPagesRuntimeConfigCommand: vi.fn(runtimeConfigCommandResponse),
      sendPagesCommand: vi.fn().mockResolvedValue({}),
    };
    const service = new PageNodeRuntimeService(db as never, {} as never, dispatch as never, {} as never);
    vi.spyOn(service as any, 'ensureRelease').mockResolvedValue(undefined);
    const markReplicaReady = vi.spyOn(service as any, 'markPreviewReplicaReady').mockResolvedValue(true);

    await (service as any).materializePreview('node-1', 'deployment-1', 'preview.example', {
      certificateId: 'cert-1',
      certificateVersion: 'version-1',
    });

    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(1, 'node-1', {
      pagesStageRuntimeConfig: expect.objectContaining({ generation: '1', json: Buffer.from('{"api":"A"}') }),
    });
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(3, 'node-1', {
      pagesStageRuntimeConfig: expect.objectContaining({ generation: '2', json: Buffer.from('{"api":"B"}') }),
    });
    expect(dispatch.sendPagesCommand).toHaveBeenCalledTimes(2);
    expect(markReplicaReady).toHaveBeenCalledWith('node-1', 'deployment-1', 'preview.example', 2);
  });

  it('retries when Default commits after the final read but before the ready CAS', async () => {
    const states = [
      { enabled: true },
      { projectId: 'project-1' },
      { replicaId: 'replica-1', runtimeConfigGeneration: 0, defaultGeneration: 1, value: { api: 'A' } },
      { generation: 1 },
      { replicaId: 'replica-1', runtimeConfigGeneration: 1, defaultGeneration: 2, value: { api: 'B' } },
      { generation: 2 },
    ];
    let selectCount = 0;
    let defaultCommitted = false;
    const query = () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => chain;
      chain.limit = vi.fn().mockImplementation(async () => {
        const result = states[selectCount++];
        if (selectCount === 3) defaultCommitted = true;
        return result ? [result] : [];
      });
      return chain;
    };
    const updateReturning = vi.fn().mockImplementation(async () => {
      if (defaultCommitted && updateReturning.mock.calls.length === 2) return [];
      return [{ id: 'replica-1' }];
    });
    const db = {
      ...defaultRuntimeConfigLockDatabase(),
      select: vi.fn(query),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: updateReturning }),
        }),
      })),
    };
    const dispatch = {
      sendPagesRuntimeConfigCommand: vi.fn(runtimeConfigCommandResponse),
      sendPagesCommand: vi.fn().mockResolvedValue({}),
    };
    const service = new PageNodeRuntimeService(db as never, {} as never, dispatch as never, {} as never);
    vi.spyOn(service as any, 'ensureRelease').mockResolvedValue(undefined);

    await (service as any).materializePreview('node-1', 'deployment-1', 'preview.example', {
      certificateId: 'cert-1',
      certificateVersion: 'version-1',
    });

    expect(defaultCommitted).toBe(true);
    expect(selectCount).toBe(6);
    expect(updateReturning).toHaveBeenCalledTimes(4);
    expect(dispatch.sendPagesCommand).toHaveBeenCalledTimes(2);
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(3, 'node-1', {
      pagesStageRuntimeConfig: expect.objectContaining({ generation: '2', json: Buffer.from('{"api":"B"}') }),
    });
  });

  it('restores the daemon and prior replica generation when the preview claim is rejected', async () => {
    const persistError = new Error('replica claim rejected');
    const queryChain = (result: unknown) => {
      const chain: Record<string, any> = {};
      for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = vi.fn(() => chain);
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return chain;
    };
    const updateReturning = vi.fn().mockRejectedValue(persistError);
    const db = {
      select: vi
        .fn()
        .mockImplementationOnce(() =>
          queryChain([
            { replicaId: 'replica-1', deploymentId: 'deployment-1', nodeId: 'node-1', hostname: 'preview.example' },
          ])
        )
        .mockImplementationOnce(() => queryChain([{ generation: 3 }])),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: updateReturning }),
        }),
      })),
    };
    const dispatch = {
      sendPagesRuntimeConfigCommand: vi.fn(runtimeConfigCommandResponse),
    };
    const service = new PageNodeRuntimeService(db as never, {} as never, dispatch as never, {} as never);

    await expect(service.publishPreviewRuntimeConfig('project-1', { api: '/next' })).rejects.toBe(persistError);
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(3, 'node-1', {
      pagesActivateRuntimeConfig: {
        bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW',
        bindingId: 'preview.example',
        generation: '3',
      },
    });
    expect(dispatch.sendPagesRuntimeConfigCommand).toHaveBeenNthCalledWith(4, 'node-1', {
      pagesRemoveRuntimeConfig: {
        bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW',
        bindingId: 'preview.example',
        generation: '4',
      },
    });
  });
});
