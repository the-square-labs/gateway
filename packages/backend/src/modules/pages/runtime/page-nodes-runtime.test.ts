import { describe, expect, it, vi } from 'vitest';
import { PageNodesRuntime } from './page-nodes-runtime.js';

function runtime(connected: Record<string, boolean>) {
  return {
    publishRuntimeConfig: vi.fn(async (_node: string, _kind: string, id: string) => `/pages/runtime/routes/${id}.js`),
    activateRuntimeConfig: vi.fn(async (_node: string, _kind: string, _id: string, _generation: number) => '/config'),
    removeRuntimeConfig: vi.fn(async (_node: string, _kind: string, _id: string) => undefined),
    activateRoute: vi.fn(async (_node: string, id: string) => `/pages/routes/${id}.conf`),
    deactivateRoute: vi.fn(async (_node: string, _id: string) => undefined),
    preflight: vi.fn(async () => undefined),
    isNodeConnected: vi.fn((node: string) => connected[node] ?? false),
  };
}

describe('Pages bindings on the nodes of a route', () => {
  it('always contacts a single node, connected or not, exactly as before ingress groups', async () => {
    const pages = runtime({ a: false });
    const nodes = new PageNodesRuntime(pages);

    await expect(nodes.activateRoute(['a'], 'route-1', 'deployment-1')).resolves.toBe('/pages/routes/route-1.conf');
    expect(pages.activateRoute).toHaveBeenCalledWith('a', 'route-1', 'deployment-1');
    expect(pages.isNodeConnected).not.toHaveBeenCalled();
  });

  it('reaches every connected member of a group and skips offline ones', async () => {
    const pages = runtime({ a: true, b: false, c: true });
    const nodes = new PageNodesRuntime(pages);

    await nodes.publishRuntimeConfig(['a', 'b', 'c'], 'route-1', 4, { key: 'value' });
    await nodes.activateRoute(['a', 'b', 'c'], 'route-1', 'deployment-1');

    expect(pages.publishRuntimeConfig.mock.calls.map((call) => call[0])).toEqual(['a', 'c']);
    expect(pages.publishRuntimeConfig).toHaveBeenCalledWith('a', 'route', 'route-1', 4, { key: 'value' });
    expect(pages.activateRoute.mock.calls.map((call) => call[0])).toEqual(['a', 'c']);
  });

  it('refuses a change no member can take and a member that reports another include path', async () => {
    await expect(
      new PageNodesRuntime(runtime({ a: false, b: false })).activateRoute(['a', 'b'], 'route-1', 'deployment-1')
    ).rejects.toMatchObject({ statusCode: 503, code: 'PAGES_ROUTE_NODES_OFFLINE' });

    const pages = runtime({ a: true, b: true });
    pages.activateRoute.mockImplementation(async (node: string) => `/pages-${node}/routes/route-1.conf`);
    await expect(new PageNodesRuntime(pages).activateRoute(['a', 'b'], 'route-1', 'd')).rejects.toMatchObject({
      code: 'PAGES_ROUTE_INCLUDE_PATH_MISMATCH',
    });
  });

  it('restores every member even when one fails, then reports the failure', async () => {
    const pages = runtime({ a: true, b: true });
    pages.activateRuntimeConfig.mockRejectedValueOnce(new Error('a is busy'));
    const nodes = new PageNodesRuntime(pages);

    await expect(nodes.restoreRuntimeConfig(['a', 'b'], 'route-1', 3)).rejects.toThrow('a is busy');
    expect(pages.activateRuntimeConfig.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);

    await nodes.restoreRuntimeConfig(['a', 'b'], 'route-1', 0);
    expect(pages.removeRuntimeConfig.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
  });

  it('cleans up the connected members and returns the first failure instead of throwing', async () => {
    const pages = runtime({ a: true, b: false, c: true });
    pages.deactivateRoute.mockRejectedValueOnce(new Error('gone'));
    const nodes = new PageNodesRuntime(pages);

    await expect(nodes.cleanup(['a', 'b', 'c'], 'route-1')).resolves.toMatchObject({ message: 'gone' });
    expect(pages.deactivateRoute.mock.calls.map((call) => call[0])).toEqual(['a', 'c']);
    expect(pages.removeRuntimeConfig.mock.calls.map((call) => call[0])).toEqual(['a', 'c']);
  });
});
