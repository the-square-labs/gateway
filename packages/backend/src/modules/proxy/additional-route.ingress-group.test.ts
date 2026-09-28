import { describe, expect, it, vi } from 'vitest';
import { AdditionalRouteService } from './additional-route.service.js';

const HOST = '22222222-2222-4222-8222-222222222222';
const ROUTE = '11111111-1111-4111-8111-111111111111';

function pagesRuntime(connected: Record<string, boolean>) {
  return {
    publishRuntimeConfig: vi.fn(async () => `/runtime-configs/routes/${ROUTE}/current.js`),
    activateRoute: vi.fn(async () => `/pages/routes/${ROUTE}.conf`),
    activateRuntimeConfig: vi.fn(async () => '/config'),
    removeRuntimeConfig: vi.fn(async () => undefined),
    deactivateRoute: vi.fn(async () => undefined),
    preflight: vi.fn(async () => undefined),
    isNodeConnected: vi.fn((node: string) => connected[node] ?? false),
  };
}

function service(routes: unknown[], runtime: ReturnType<typeof pagesRuntime>) {
  const db = {
    query: { proxyAdditionalRoutes: { findMany: vi.fn().mockResolvedValue(routes) } },
  } as any;
  const additional = new AdditionalRouteService(db, { log: vi.fn() } as any);
  additional.setPageRuntime(
    runtime as any,
    {
      getEffective: vi.fn(async () => ({ value: { theme: 'dark' }, tagId: 'tag-1' })),
    } as any
  );
  return additional;
}

describe('Additional Pages Routes of a host on an ingress group', () => {
  const route = {
    id: ROUTE,
    proxyHostId: HOST,
    targetKind: 'pages',
    status: 'ready',
    activeDeploymentId: 'deployment-1',
    pageProjectId: 'project-1',
    pageTagId: 'tag-1',
    includePath: `/pages/routes/${ROUTE}.conf`,
    runtimeConfigGeneration: 4,
  };

  it('materialises each ready Route on a joining member at its current generation', async () => {
    const runtime = pagesRuntime({ joined: true });
    await service([route], runtime).syncServingNodes({ id: HOST } as any, ['joined'], []);

    expect(runtime.publishRuntimeConfig).toHaveBeenCalledWith('joined', 'route', ROUTE, 4, { theme: 'dark' });
    expect(runtime.activateRoute).toHaveBeenCalledWith('joined', ROUTE, 'deployment-1');
  });

  it('removes the bindings from a connected member that left and skips offline nodes', async () => {
    const runtime = pagesRuntime({ left: true, offline: false });
    await service([route], runtime).syncServingNodes({ id: HOST } as any, ['offline'], ['left']);

    expect(runtime.deactivateRoute).toHaveBeenCalledWith('left', ROUTE);
    expect(runtime.removeRuntimeConfig).toHaveBeenCalledWith('left', 'route', ROUTE);
    expect(runtime.activateRoute).not.toHaveBeenCalled();
  });

  it('refuses a member that reports another include path', async () => {
    const runtime = pagesRuntime({ joined: true });
    runtime.activateRoute.mockResolvedValue('/elsewhere/route.conf');

    await expect(service([route], runtime).syncServingNodes({ id: HOST } as any, ['joined'], [])).rejects.toMatchObject(
      { code: 'PAGES_ROUTE_INCLUDE_PATH_MISMATCH' }
    );
  });
});
