import { describe, expect, it, vi } from 'vitest';
import { IngressGroupService } from './ingress-group.service.js';

const GROUP = '11111111-1111-4111-8111-111111111111';

/** A Drizzle stand-in: each select resolves the next queued result; writes are recorded in call order. */
function database(selects: unknown[][], events: string[]) {
  const chain = (result: unknown) => {
    const query: Record<string, any> = {};
    for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) {
      query[method] = vi.fn(() => query);
    }
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return query;
  };
  const write = (kind: string) => {
    const query: Record<string, any> = {};
    query.set = vi.fn((values: Record<string, unknown>) => {
      events.push(`${kind}:${JSON.stringify(values.state ?? values.priority ?? values.nodeId ?? 'row')}`);
      return query;
    });
    query.where = vi.fn(() => query);
    query.values = vi.fn(() => query);
    query.returning = vi.fn(async () => []);
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
    return query;
  };
  const db: Record<string, any> = {
    select: vi.fn(() => chain(selects.shift() ?? [])),
    update: vi.fn(() => write('update')),
    delete: vi.fn(() => {
      events.push('delete:member');
      return write('delete');
    }),
    insert: vi.fn(() => write('insert')),
    query: { ingressGroups: { findFirst: vi.fn(async () => ({ id: GROUP, name: 'Edge', folderId: null })) } },
  };
  db.transaction = vi.fn(async (work: (tx: unknown) => unknown) => work(db));
  return db;
}

function service(db: Record<string, any>, events: string[], connected = true) {
  const groups = new IngressGroupService(db as never, { log: vi.fn(async () => undefined) } as never, {
    isNodeConnected: () => connected,
  });
  const proxy = {
    applyIngressMemberJoin: vi.fn(async (hostId: string, nodeId: string) => {
      events.push(`join:${hostId}:${nodeId}`);
    }),
    applyIngressMemberLeave: vi.fn(async (hostId: string, nodeId: string) => {
      events.push(`leave:${hostId}:${nodeId}`);
    }),
  };
  const domains = {
    reconcileIngressGroupDns: vi.fn(async () => {
      events.push('dns');
      return { settled: true, domains: [] };
    }),
  };
  groups.setProxyService(proxy as never);
  groups.setDomainsService(domains as never);
  vi.spyOn(groups, 'getSummary').mockResolvedValue({ id: GROUP } as never);
  return { groups, proxy, domains };
}

const member = (nodeId: string, state: string, priority = 0) => ({ groupId: GROUP, nodeId, state, priority });

describe('ingress group membership without downtime', () => {
  it('delivers every route to a joining member before it becomes active and is published in DNS', async () => {
    const events: string[] = [];
    const db = database(
      [
        [{ id: 'route-1' }, { id: 'route-2' }], // routes of the group
        [member('b', 'joining')], // the member row, under the group lock
        [member('a', 'active'), member('b', 'active', 1)], // primary mirror
      ],
      events
    );
    const { groups } = service(db, events);

    await expect(groups.completeJoin(GROUP, 'b')).resolves.toBe(true);

    expect(events.slice(0, 3)).toEqual(['join:route-1:b', 'join:route-2:b', 'update:"active"']);
    expect(events.indexOf('dns')).toBeGreaterThan(events.indexOf('update:"active"'));
  });

  it('keeps a member joining, unpublished, while a route did not reach it or it is offline', async () => {
    const events: string[] = [];
    const db = database([[{ id: 'route-1' }], [member('b', 'joining')]], events);
    const { groups, proxy } = service(db, events);
    proxy.applyIngressMemberJoin.mockRejectedValueOnce(new Error('nginx -t failed'));

    await expect(groups.completeJoin(GROUP, 'b')).resolves.toBe(false);
    expect(events).not.toContain('dns');
    expect(events).not.toContain('update:"active"');

    const offlineEvents: string[] = [];
    const offline = service(database([[member('b', 'joining')]], offlineEvents), offlineEvents, false);
    await expect(offline.groups.completeJoin(GROUP, 'b')).resolves.toBe(false);
    expect(offline.proxy.applyIngressMemberJoin).not.toHaveBeenCalled();
  });

  it('withdraws a leaving member from DNS first and removes its routes only when forced or after the drain', async () => {
    const events: string[] = [];
    const db = database(
      [
        [member('a', 'active'), member('b', 'active', 1)], // members, under the lock
        [{ id: 'route-1' }], // routes of the group
        [], // domains of the group
        [member('a', 'active'), member('b', 'draining', 1)], // primary mirror
      ],
      events
    );
    const { groups } = service(db, events);

    await groups.removeMember(GROUP, 'b', { force: false }, 'user-1');

    expect(events.indexOf('update:"draining"')).toBeLessThan(events.indexOf('dns'));
    expect(events.some((event) => event.startsWith('leave:'))).toBe(false);

    const forcedEvents: string[] = [];
    const forced = service(
      database(
        [
          [member('a', 'active'), member('b', 'active', 1)],
          [{ id: 'route-1' }],
          [],
          [member('a', 'active'), member('b', 'draining', 1)],
          [{ id: 'route-1' }], // routes, for the cleanup
          [member('a', 'active')], // primary mirror after the member row is gone
        ],
        forcedEvents
      ),
      forcedEvents
    );
    await forced.groups.removeMember(GROUP, 'b', { force: true }, 'user-1');
    expect(forcedEvents.indexOf('dns')).toBeLessThan(forcedEvents.indexOf('delete:member'));
    expect(forcedEvents.indexOf('delete:member')).toBeLessThan(forcedEvents.indexOf('leave:route-1:b'));
  });

  it('refuses to remove the last active member while the group serves routes', async () => {
    const events: string[] = [];
    const db = database([[member('a', 'active')], [{ id: 'route-1' }], []], events);
    const { groups } = service(db, events);

    await expect(groups.removeMember(GROUP, 'a', { force: false }, 'user-1')).rejects.toMatchObject({
      code: 'INGRESS_GROUP_LAST_MEMBER',
    });
    expect(events).not.toContain('dns');
  });
});
