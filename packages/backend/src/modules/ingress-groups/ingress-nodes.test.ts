import { describe, expect, it, vi } from 'vitest';
// The schema modules reference each other; load them in their normal order first.
import '@/db/schema/index.js';
import { orderIngressMembers, resolveIngressNodes, resolveIngressNodesForMany } from './ingress-nodes.js';

function database(rows: unknown[]) {
  const query: Record<string, any> = {};
  for (const method of ['from', 'where', 'orderBy']) query[method] = vi.fn(() => query);
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return { select: vi.fn(() => query) };
}

describe('the nodes that serve a route or domain', () => {
  it('orders members by site preference, then node id', () => {
    expect(
      orderIngressMembers([
        { nodeId: 'c', priority: 1 },
        { nodeId: 'b', priority: 0 },
        { nodeId: 'a', priority: 1 },
      ]).map((member) => member.nodeId)
    ).toEqual(['b', 'a', 'c']);
  });

  it('resolves a single node without touching the database and a group to its members', async () => {
    const db = database([
      { groupId: 'g', nodeId: 'a', priority: 0, state: 'active' },
      { groupId: 'g', nodeId: 'b', priority: 1, state: 'draining' },
    ]);
    await expect(resolveIngressNodes(db as never, { nodeId: 'n', ingressGroupId: null })).resolves.toEqual(['n']);
    expect(db.select).not.toHaveBeenCalled();
    await expect(resolveIngressNodes(db as never, { nodeId: 'a', ingressGroupId: 'g' })).resolves.toEqual(['a', 'b']);
    await expect(resolveIngressNodes(db as never, { nodeId: null })).resolves.toEqual([]);
  });

  it('resolves many targets with one query', async () => {
    const db = database([
      { groupId: 'g', nodeId: 'b', priority: 1 },
      { groupId: 'g', nodeId: 'a', priority: 0 },
    ]);
    const single = { nodeId: 'n', ingressGroupId: null };
    const grouped = { nodeId: 'a', ingressGroupId: 'g' };
    const resolved = await resolveIngressNodesForMany(db as never, [single, grouped]);
    expect(resolved.get(single)).toEqual(['n']);
    expect(resolved.get(grouped)).toEqual(['a', 'b']);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
