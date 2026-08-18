import { describe, expect, it, vi } from 'vitest';
import { assertContainerNotUsedByProxy, assertDeploymentNotUsedByProxy } from './docker-proxy-link.guard.js';

function dbWithRows(rows: unknown[], additionalRouteRows: unknown[] = []) {
  let whereCalls = 0;
  const limit = vi.fn(async () => rows);
  const routeLimit = vi.fn(async () => additionalRouteRows);
  const where = vi.fn(() => ({ limit: whereCalls++ === 0 ? limit : routeLimit }));
  const from = vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: routeLimit })) })) }));
  return { select: vi.fn(() => ({ from })) };
}

describe('Docker proxy link deletion guards', () => {
  it('blocks deletion of a linked container', async () => {
    await expect(
      assertContainerNotUsedByProxy(
        dbWithRows([{ id: 'proxy-1', domainNames: ['api.example.com'] }]) as never,
        'node-1',
        'api'
      )
    ).rejects.toMatchObject({ code: 'PROXY_UPSTREAM_IN_USE', statusCode: 409 });
  });

  it('blocks deletion of a linked deployment', async () => {
    await expect(
      assertDeploymentNotUsedByProxy(
        dbWithRows([{ id: 'proxy-1', domainNames: ['app.example.com'] }]) as never,
        'deployment-1'
      )
    ).rejects.toMatchObject({ code: 'PROXY_UPSTREAM_IN_USE', statusCode: 409 });
  });

  it('allows deletion when no proxy uses the resource', async () => {
    await expect(assertContainerNotUsedByProxy(dbWithRows([]) as never, 'node-1', 'api')).resolves.toBeUndefined();
  });

  it('blocks deletion of a container linked only by an Additional Route', async () => {
    await expect(
      assertContainerNotUsedByProxy(
        dbWithRows([], [{ id: 'proxy-1', domainNames: ['api.example.com'] }]) as never,
        'node-1',
        'api'
      )
    ).rejects.toMatchObject({ code: 'PROXY_UPSTREAM_IN_USE', statusCode: 409 });
  });

  it('blocks deletion of a deployment linked only by an Additional Route', async () => {
    await expect(
      assertDeploymentNotUsedByProxy(
        dbWithRows([], [{ id: 'proxy-1', domainNames: ['app.example.com'] }]) as never,
        'deployment-1'
      )
    ).rejects.toMatchObject({ code: 'PROXY_UPSTREAM_IN_USE', statusCode: 409 });
  });
});
