import { describe, expect, it, vi } from 'vitest';
import {
  PageNodeRuntimeService,
  validatePageRouteIncludePath,
  validatePageRuntimeConfigPath,
} from './page-node-runtime.service.js';

const ROUTE_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_CONFIG_PATH = `/var/lib/nginx/pages/runtime-configs/routes/${ROUTE_ID}/current.js`;
const PREVIEW_CONFIG_PATH = '/var/lib/nginx/pages/runtime-configs/previews/preview-hash/current.js';

function runtimeConfigCommandResponse(_nodeId: string, command: Record<string, unknown>) {
  const activate = command.pagesActivateRuntimeConfig as { bindingKind?: string } | undefined;
  return Promise.resolve({
    configPath: activate?.bindingKind === 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE'
      ? ROUTE_CONFIG_PATH
      : PREVIEW_CONFIG_PATH,
  });
}

function defaultRuntimeConfigLockDatabase() {
  const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
  return { $client: { connect: vi.fn().mockResolvedValue(client) } };
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
    expect(selectCount).toBe(5);
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
