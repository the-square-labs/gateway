import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { bindingInspectionKey } from '../runtime/page-binding-inspection.js';
import { PageRouteService } from './page-route.service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';
const ROUTE_1 = '33333333-3333-4333-8333-333333333333';
const ROUTE_2 = '44444444-4444-4444-8444-444444444444';
const OLD_DEPLOYMENT = '55555555-5555-4555-8555-555555555555';
const NEW_DEPLOYMENT = '66666666-6666-4666-8666-666666666666';
const SOURCE_NODE = '77777777-7777-4777-8777-777777777777';
const TARGET_NODE = '88888888-8888-4888-8888-888888888888';

function queryChain(result: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'for', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function database(selectResults: unknown[], returningResults: unknown[], deleteReturningResults: unknown[] = []) {
  const insertValues: unknown[] = [];
  const updateSets: unknown[] = [];
  const deleteWheres: unknown[] = [];
  const publicationEvents: string[] = [];
  const db = {
    select: vi.fn(() => {
      const chain = queryChain(selectResults.shift() ?? []);
      chain.for.mockImplementation((lockMode: string) => {
        publicationEvents.push(`lock:${lockMode}`);
        return chain;
      });
      return chain;
    }),
    insert: vi.fn(() => ({ values: vi.fn(async (values: unknown) => insertValues.push(values)) })),
    delete: vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.where = vi.fn((where: unknown) => {
        deleteWheres.push(where);
        return chain;
      });
      chain.returning = vi.fn(async () => {
        const next = deleteReturningResults.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      });
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject);
      return chain;
    }),
    update: vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.set = vi.fn((values: unknown) => {
        updateSets.push(values);
        publicationEvents.push('target:update');
        return chain;
      });
      chain.where = vi.fn(() => chain);
      chain.returning = vi.fn(async () => {
        const next = returningResults.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      });
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject);
      return chain;
    }),
  };
  (db as any).transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(db));
  (db as any).insertValues = insertValues;
  (db as any).updateSets = updateSets;
  (db as any).deleteWheres = deleteWheres;
  (db as any).publicationEvents = publicationEvents;
  return db as unknown as DrizzleClient;
}

function target(routeId: string, nodeId: string, generation = 1) {
  return {
    target: {
      id: `${routeId.slice(0, -1)}a`,
      proxyHostId: routeId,
      projectId: PROJECT_ID,
      tagId: TAG_ID,
      activeDeploymentId: OLD_DEPLOYMENT,
      includePath: `/source/pages/routes/${routeId}.inc`,
      status: 'ready',
      generation,
      runtimeConfigGeneration: 1,
    },
    nodeId,
  };
}

function runtimeConfigService() {
  return { getEffective: vi.fn().mockResolvedValue({ value: {}, generation: 0, tagId: null, inherited: true }) };
}

describe('PageRouteService cutover safety', () => {
  it('leaves verified unchanged routes and runtime generations untouched across cycles', async () => {
    const route = target(ROUTE_1, SOURCE_NODE);
    const db = database([[route], [route.target], [route], [route.target]], []);
    const expectation = {
      kind: 'route' as const,
      id: ROUTE_1,
      deploymentId: OLD_DEPLOYMENT,
      sha256: 'a'.repeat(64),
      size: 100,
      generation: 1,
      stateGeneration: 1,
      runtimeConfig: {},
    };
    const runtime = {
      supportsInspection: vi.fn().mockResolvedValue(true),
      routeExpectation: vi.fn().mockResolvedValue(expectation),
      inspectBindings: vi
        .fn()
        .mockResolvedValue(new Map([[bindingInspectionKey(SOURCE_NODE, expectation), { expectation, matches: true }]])),
      publishRuntimeConfig: vi.fn(),
      activateRoute: vi.fn(),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );
    await service.reconcile();
    await service.reconcile();
    expect(runtime.inspectBindings).toHaveBeenCalledTimes(2);
    expect(runtime.routeExpectation).toHaveBeenCalledTimes(4);
    expect(db.update).not.toHaveBeenCalled();
    expect(runtime.publishRuntimeConfig).not.toHaveBeenCalled();
    expect(runtime.activateRoute).not.toHaveBeenCalled();
  });

  it.each([
    'disk drift',
    'concurrent publication',
    'legacy daemon',
  ])('repairs instead of skipping on %s', async (reason) => {
    const route = target(ROUTE_1, SOURCE_NODE);
    const current = { ...route.target, generation: reason === 'concurrent publication' ? 3 : 1 };
    const db = database([[route], [current]], [[{ generation: current.generation + 1 }], [{ id: current.id }]]);
    const expectation = {
      kind: 'route' as const,
      id: ROUTE_1,
      deploymentId: OLD_DEPLOYMENT,
      sha256: 'a'.repeat(64),
      size: 100,
      generation: 1,
      stateGeneration: 1,
      runtimeConfig: {},
    };
    const runtime = {
      supportsInspection: vi.fn().mockResolvedValue(reason !== 'legacy daemon'),
      routeExpectation: vi
        .fn()
        .mockImplementation(async (input) => ({ ...expectation, stateGeneration: input.stateGeneration })),
      inspectBindings: vi
        .fn()
        .mockResolvedValue(
          new Map([[bindingInspectionKey(SOURCE_NODE, expectation), { expectation, matches: reason !== 'disk drift' }]])
        ),
      publishRuntimeConfig: vi.fn().mockResolvedValue('/config'),
      activateRoute: vi.fn().mockResolvedValue(`/source/pages/routes/${ROUTE_1}.inc`),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );
    await service.reconcile();
    expect(runtime.activateRoute).toHaveBeenCalledTimes(1);
    expect(runtime.publishRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1, 2, {});
    expect(db.update).toHaveBeenCalled();
    if (reason === 'legacy daemon') expect(runtime.inspectBindings).not.toHaveBeenCalled();
  });

  it('rejects a Pages Route before daemon preflight when the node lacks runtime-config capability', async () => {
    const db = database(
      [
        [
          {
            type: 'nginx',
            status: 'online',
            capabilities: { capabilities: ['nginx_pages_v1'] },
          },
        ],
      ],
      []
    );
    const runtime = { preflight: vi.fn() };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(
      service.validateCreate({
        type: 'proxy',
        nodeId: SOURCE_NODE,
        domainNames: ['pages.example.com'],
        upstreamKind: 'pages',
        pageProjectId: PROJECT_ID,
        pageTagId: TAG_ID,
      } as never)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAGES_DAEMON_UPDATE_REQUIRED',
    });
    expect(runtime.preflight).not.toHaveBeenCalled();
  });

  it('removes the route replica and runtime binding when activation fails', async () => {
    const db = database([[{ deployment: { id: OLD_DEPLOYMENT }, generation: 1 }], []], []);
    (db as any).delete = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const activationError = new Error('route activation failed');
    const runtime = {
      activateRoute: vi.fn().mockRejectedValue(activationError),
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.activateNewHost(ROUTE_1, SOURCE_NODE, PROJECT_ID, TAG_ID)).rejects.toBe(activationError);
    expect(runtime.deactivateRoute).toHaveBeenCalledWith(SOURCE_NODE, ROUTE_1);
    expect(runtime.removeRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1);
    expect((db as any).delete).toHaveBeenCalled();
  });

  it('retains ownership after daemon cleanup fails and reconciles the orphan later', async () => {
    const failedTarget = {
      id: '99999999-9999-4999-8999-999999999999',
      proxyHostId: ROUTE_1,
      projectId: PROJECT_ID,
      tagId: TAG_ID,
      activeDeploymentId: OLD_DEPLOYMENT,
      includePath: null,
      status: 'failed',
      generation: 1,
      runtimeConfigGeneration: 1,
      lastErrorCode: 'PAGES_ROUTE_CREATE_CLEANUP_PENDING',
    };
    const db = database(
      [
        [{ deployment: { id: OLD_DEPLOYMENT }, generation: 1 }],
        [],
        [{ target: failedTarget, nodeId: SOURCE_NODE }],
        [failedTarget],
      ],
      [[{ generation: 2 }]],
      [[{ id: ROUTE_1 }]]
    );
    const activationError = new Error('route activation failed');
    const runtime = {
      activateRoute: vi.fn().mockRejectedValue(activationError),
      deactivateRoute: vi.fn().mockRejectedValueOnce(new Error('deactivate timeout')).mockResolvedValue(undefined),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockRejectedValueOnce(new Error('remove timeout')).mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.activateNewHost(ROUTE_1, SOURCE_NODE, PROJECT_ID, TAG_ID)).rejects.toBe(activationError);
    expect((db as any).delete).not.toHaveBeenCalled();
    expect((db as any).insertValues).toEqual([
      expect.objectContaining({ proxyHostId: ROUTE_1, status: 'staging', activeDeploymentId: OLD_DEPLOYMENT }),
    ]);
    expect((db as any).updateSets).toContainEqual(
      expect.objectContaining({ status: 'failed', lastErrorCode: 'PAGES_ROUTE_CREATE_CLEANUP_PENDING' })
    );

    await expect(service.reconcile()).resolves.toBeUndefined();
    expect(runtime.deactivateRoute).toHaveBeenCalledTimes(2);
    expect(runtime.removeRuntimeConfig).toHaveBeenCalledTimes(2);
    expect((db as any).delete).toHaveBeenCalledTimes(1);
  });

  it('keeps a Route target claimed for the proxy-host cascade when cleanup succeeds on retry', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const pending = {
      ...route,
      status: 'failed',
      generation: 2,
      lastErrorCode: 'PAGES_ROUTE_REMOVAL_CLEANUP_PENDING',
    };
    const db = database([[route], [pending]], [[{ generation: 2 }], [{ generation: 3 }]]);
    const runtime = {
      deactivateRoute: vi.fn().mockRejectedValueOnce(new Error('deactivate timeout')).mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockRejectedValueOnce(new Error('remove timeout')).mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.removeHost(ROUTE_1, SOURCE_NODE)).rejects.toThrow('deactivate timeout');
    expect((db as any).delete).not.toHaveBeenCalled();
    await expect(service.removeHost(ROUTE_1, SOURCE_NODE)).resolves.toBeUndefined();
    expect((db as any).delete).not.toHaveBeenCalled();
  });

  it('does not mutate the daemon when another process owns the remove claim', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const db = database([[route]], [[]]);
    const runtime = { deactivateRoute: vi.fn(), removeRuntimeConfig: vi.fn() };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.removeHost(ROUTE_1, SOURCE_NODE)).rejects.toMatchObject({ code: 'PAGES_ROUTE_CHANGED' });
    expect(runtime.deactivateRoute).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeConfig).not.toHaveBeenCalled();
  });

  it('serializes concurrent remove calls in-process and lets only the owner clean the daemon', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    let signalCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    const cleanupMayFinish = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const db = database([[route], []], [[{ generation: 2 }]], [[{ id: route.id }]]);
    const runtime = {
      deactivateRoute: vi.fn(async () => {
        signalCleanupStarted();
        await cleanupMayFinish;
      }),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    const first = service.removeHost(ROUTE_1, SOURCE_NODE);
    await cleanupStarted;
    const second = service.removeHost(ROUTE_1, SOURCE_NODE);
    releaseCleanup();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(runtime.deactivateRoute).toHaveBeenCalledOnce();
    expect(runtime.removeRuntimeConfig).toHaveBeenCalledOnce();
  });

  it('rolls a newly created Route back when its Tag changes during activation', async () => {
    const db = database(
      [[{ deployment: { id: OLD_DEPLOYMENT }, generation: 1 }], [], [{ deploymentId: NEW_DEPLOYMENT, generation: 2 }]],
      [[{ id: `${ROUTE_1}-target` }]]
    ) as any;
    db.insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
    const deleteWhere = vi.fn(async () => undefined);
    db.delete = vi.fn(() => ({ where: deleteWhere }));
    const runtime = {
      activateRoute: vi.fn().mockResolvedValue(`/source/pages/routes/${ROUTE_1}.inc`),
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.activateNewHost(ROUTE_1, SOURCE_NODE, PROJECT_ID, TAG_ID)).rejects.toMatchObject({
      code: 'PAGES_TAG_CHANGED',
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.publicationEvents).toEqual(['lock:update']);
    expect(deleteWhere).toHaveBeenCalled();
    expect(runtime.deactivateRoute).toHaveBeenCalledWith(SOURCE_NODE, ROUTE_1);
  });

  it('locks the Tag snapshot before publishing a new Route target ready', async () => {
    const db = database(
      [[{ deployment: { id: OLD_DEPLOYMENT }, generation: 1 }], [], [{ deploymentId: OLD_DEPLOYMENT, generation: 1 }]],
      [[{ id: `${ROUTE_1}-target` }]]
    ) as any;
    const runtime = {
      activateRoute: vi.fn().mockResolvedValue(`/source/pages/routes/${ROUTE_1}.inc`),
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.activateNewHost(ROUTE_1, SOURCE_NODE, PROJECT_ID, TAG_ID)).resolves.toBeUndefined();

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.publicationEvents).toEqual(['lock:update', 'target:update']);
  });

  it('never publishes ready when final Tag validation fails and cleanup marker persistence is unavailable', async () => {
    const db = database(
      [[{ deployment: { id: OLD_DEPLOYMENT }, generation: 1 }], [], [{ deploymentId: NEW_DEPLOYMENT, generation: 2 }]],
      []
    ) as any;
    const writes: unknown[] = [];
    db.update = vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.set = vi.fn((values: unknown) => {
        writes.push(values);
        return chain;
      });
      chain.where = vi.fn(async () => {
        throw new Error('cleanup marker database unavailable');
      });
      return chain;
    });
    const runtime = {
      activateRoute: vi.fn().mockResolvedValue(`/source/pages/routes/${ROUTE_1}.inc`),
      deactivateRoute: vi.fn().mockRejectedValue(new Error('deactivate timeout')),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockRejectedValue(new Error('remove timeout')),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.activateNewHost(ROUTE_1, SOURCE_NODE, PROJECT_ID, TAG_ID)).rejects.toMatchObject({
      code: 'PAGES_TAG_CHANGED',
    });
    expect(writes).not.toContainEqual(expect.objectContaining({ status: 'ready' }));
    expect(runtime.deactivateRoute).toHaveBeenCalledWith(SOURCE_NODE, ROUTE_1);
  });

  it('removes the retained disabled Pages host after deferred create cleanup succeeds', async () => {
    const failedTarget = {
      ...target(ROUTE_1, SOURCE_NODE).target,
      includePath: null,
      status: 'failed',
      lastErrorCode: 'PAGES_ROUTE_CREATE_CLEANUP_PENDING',
    };
    const db = database(
      [[{ target: failedTarget, nodeId: SOURCE_NODE }], [failedTarget]],
      [[{ generation: 2 }]],
      [[{ id: ROUTE_1 }]]
    );
    const runtime = {
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await service.reconcile();
    expect((db as any).delete).toHaveBeenCalledTimes(1);
    expect(runtime.deactivateRoute).toHaveBeenCalledWith(SOURCE_NODE, ROUTE_1);
  });

  it('ignores an active staging target without an explicit cleanup claim', async () => {
    const activeTarget = {
      ...target(ROUTE_1, SOURCE_NODE).target,
      includePath: null,
      status: 'staging',
      lastErrorCode: null,
    };
    const db = database([[{ target: activeTarget, nodeId: SOURCE_NODE }]], []);
    const runtime = {
      deactivateRoute: vi.fn(),
      removeRuntimeConfig: vi.fn(),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await service.reconcile();

    expect(runtime.deactivateRoute).not.toHaveBeenCalled();
    expect(runtime.removeRuntimeConfig).not.toHaveBeenCalled();
    expect((db as any).update).not.toHaveBeenCalled();
    expect((db as any).delete).not.toHaveBeenCalled();
  });

  it('preserves a revived create host and transitions the target to a non-destructive conflict', async () => {
    const failedTarget = {
      ...target(ROUTE_1, SOURCE_NODE).target,
      includePath: null,
      status: 'failed',
      lastErrorCode: 'PAGES_ROUTE_CREATE_CLEANUP_PENDING',
    };
    const db = database(
      [[{ target: failedTarget, nodeId: SOURCE_NODE }], [failedTarget], [{ enabled: true, upstreamKind: 'pages' }]],
      [[{ generation: 2 }], []],
      [[]]
    );
    const runtime = {
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await service.reconcile();
    expect((db as any).delete).toHaveBeenCalledTimes(1);
    expect((db as any).updateSets).toContainEqual(
      expect.objectContaining({ status: 'failed', lastErrorCode: 'PAGES_ROUTE_REMOVAL_CLEANUP_CONFLICT' })
    );
  });

  it('blocks new Route activation while the selected Tag is being published', async () => {
    const db = database([[{ deployment: { id: OLD_DEPLOYMENT }, generation: 2 }], [{ id: 'active-publication' }]], []);
    const runtime = { activateRoute: vi.fn(), deactivateRoute: vi.fn(), publishRuntimeConfig: vi.fn() };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.activateNewHost(ROUTE_1, SOURCE_NODE, PROJECT_ID, TAG_ID)).rejects.toMatchObject({
      code: 'PAGES_TAG_PUBLICATION_ACTIVE',
    });
    expect(runtime.activateRoute).not.toHaveBeenCalled();
  });

  it('does not mutate Nginx when another process owns the persisted Route claim', async () => {
    const route = target(ROUTE_1, SOURCE_NODE);
    const db = database([[route], [route.target]], [[]]);
    const runtime = { activateRoute: vi.fn(), deactivateRoute: vi.fn(), publishRuntimeConfig: vi.fn() };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(
      service.stage({
        id: '99999999-9999-4999-8999-999999999999',
        projectId: PROJECT_ID,
        tagId: TAG_ID,
        tag: 'production',
        deploymentId: NEW_DEPLOYMENT,
        publicSlug: 'abcdef',
        sequence: 2,
        expectedGeneration: 2,
        requestedById: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'PAGES_ROUTE_CHANGED' });
    expect(runtime.activateRoute).not.toHaveBeenCalled();
    expect(runtime.deactivateRoute).not.toHaveBeenCalled();
  });

  it('rolls already-switched Routes back after a later Route fails', async () => {
    const first = target(ROUTE_1, SOURCE_NODE);
    const second = target(ROUTE_2, TARGET_NODE);
    const currentAfterSwitch = { ...first.target, activeDeploymentId: NEW_DEPLOYMENT, generation: 3 };
    const db = database(
      [
        [first, second],
        [first.target],
        [second.target],
        [{ ...second.target, status: 'staging', generation: 2 }],
        [currentAfterSwitch],
      ],
      [
        [{ generation: 2 }],
        [{ generation: 3 }],
        [{ generation: 2 }],
        [{ id: second.target.id }],
        [{ id: first.target.id }],
      ]
    );
    const runtime = {
      activateRoute: vi
        .fn()
        .mockResolvedValueOnce(`/one/pages/routes/${ROUTE_1}.inc`)
        .mockRejectedValueOnce(new Error('target node failed'))
        .mockResolvedValueOnce(`/two/pages/routes/${ROUTE_2}.inc`)
        .mockResolvedValueOnce(`/one/pages/routes/${ROUTE_1}.inc`),
      deactivateRoute: vi.fn(),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      activateRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(
      service.stage({
        id: '99999999-9999-4999-8999-999999999999',
        projectId: PROJECT_ID,
        tagId: TAG_ID,
        tag: 'production',
        deploymentId: NEW_DEPLOYMENT,
        publicSlug: 'abcdef',
        sequence: 2,
        expectedGeneration: 2,
        requestedById: 'user-1',
      })
    ).rejects.toThrow('target node failed');

    expect(runtime.activateRoute).toHaveBeenNthCalledWith(1, SOURCE_NODE, ROUTE_1, NEW_DEPLOYMENT);
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(2, TARGET_NODE, ROUTE_2, NEW_DEPLOYMENT);
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(3, TARGET_NODE, ROUTE_2, OLD_DEPLOYMENT);
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(4, SOURCE_NODE, ROUTE_1, OLD_DEPLOYMENT);
  });

  it('stages an ingress migration entirely from Gateway storage without contacting the source node', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const db = database([[route]], [[{ generation: 2 }], [{ generation: 2 }], [{ id: route.id }]]);
    const runtime = {
      activateRoute: vi.fn().mockResolvedValue(`/target/custom/pages/routes/${ROUTE_1}.inc`),
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    const migration = await service.stageNodeMigration(ROUTE_1, SOURCE_NODE, TARGET_NODE);
    expect(migration).toMatchObject({
      sourceNodeId: SOURCE_NODE,
      targetNodeId: TARGET_NODE,
      deploymentId: OLD_DEPLOYMENT,
      generation: 2,
    });
    await expect(service.commitNodeMigration(migration)).resolves.toBeUndefined();
    expect(runtime.activateRoute).toHaveBeenCalledWith(TARGET_NODE, ROUTE_1, OLD_DEPLOYMENT);
    expect(runtime.activateRoute).not.toHaveBeenCalledWith(SOURCE_NODE, expect.anything(), expect.anything());
    expect(runtime.deactivateRoute).not.toHaveBeenCalled();
  });

  it('restores the old Deployment when a manual retarget loses its DB compare-and-swap', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const db = database(
      [[{ deployment: { id: NEW_DEPLOYMENT } }], [{ nodeId: SOURCE_NODE, upstreamKind: 'pages' }], [route]],
      [[{ generation: 2 }], []]
    );
    const runtime = {
      activateRoute: vi
        .fn()
        .mockResolvedValueOnce(`/source/pages/routes/${ROUTE_1}.inc`)
        .mockResolvedValueOnce(`/source/pages/routes/${ROUTE_1}.inc`),
      deactivateRoute: vi.fn(),
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      activateRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.retarget(ROUTE_1, PROJECT_ID, TAG_ID, 'user-1')).rejects.toMatchObject({
      code: 'PAGES_ROUTE_CHANGED',
    });
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(1, SOURCE_NODE, ROUTE_1, NEW_DEPLOYMENT);
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(2, SOURCE_NODE, ROUTE_1, OLD_DEPLOYMENT);
  });

  it('restores the previous runtime-config generation when final publication persistence throws', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const db = database(
      [[{ target: route, nodeId: SOURCE_NODE }], [route]],
      [[{ generation: 2 }], new Error('runtime config DB write failed'), [{ id: route.id }]]
    );
    const runtime = {
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      activateRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(
      service.publishRuntimeConfig({
        projectId: PROJECT_ID,
        tagId: TAG_ID,
        value: { api: '/v2' },
        sourceGeneration: 2,
        action: 'save',
      })
    ).rejects.toThrow('runtime config DB write failed');
    expect(runtime.publishRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1, 2, {});
    expect(runtime.activateRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1, 1);
  });

  it('restores daemon materialization when reconcile persistence throws', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const db = database(
      [[{ target: route, nodeId: SOURCE_NODE }], [route]],
      [[{ generation: 2 }], new Error('reconcile DB write failed'), [{ id: route.id }]]
    );
    const runtime = {
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      activateRoute: vi.fn().mockResolvedValue(`/source/pages/routes/${ROUTE_1}.inc`),
      activateRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(service.reconcile()).resolves.toBeUndefined();
    expect(runtime.publishRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1, 2, {});
    expect(runtime.activateRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1, 1);
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(2, SOURCE_NODE, ROUTE_1, OLD_DEPLOYMENT);
  });

  it('restores the old daemon deployment and target status when tag activation final CAS is empty', async () => {
    const route = target(ROUTE_1, SOURCE_NODE).target;
    const staged = { ...route, status: 'staging', generation: 2 };
    const db = database(
      [[{ target: route, nodeId: SOURCE_NODE }], [route], [staged]],
      [[{ generation: 2 }], [], [{ id: route.id }]]
    );
    const runtime = {
      publishRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      activateRoute: vi
        .fn()
        .mockResolvedValueOnce(`/source/pages/routes/${ROUTE_1}.inc`)
        .mockResolvedValueOnce(`/source/pages/routes/${ROUTE_1}.inc`),
      activateRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      removeRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      deactivateRoute: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PageRouteService(
      db,
      runtime as never,
      { log: vi.fn() } as never,
      runtimeConfigService() as never
    );

    await expect(
      service.stage({
        id: '99999999-9999-4999-8999-999999999999',
        projectId: PROJECT_ID,
        tagId: TAG_ID,
        tag: 'production',
        deploymentId: NEW_DEPLOYMENT,
        publicSlug: 'abcdef',
        sequence: 2,
        expectedGeneration: 2,
        requestedById: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'PAGES_ROUTE_CHANGED' });
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(1, SOURCE_NODE, ROUTE_1, NEW_DEPLOYMENT);
    expect(runtime.activateRoute).toHaveBeenNthCalledWith(2, SOURCE_NODE, ROUTE_1, OLD_DEPLOYMENT);
    expect(runtime.activateRuntimeConfig).toHaveBeenCalledWith(SOURCE_NODE, 'route', ROUTE_1, 1);
  });
});
