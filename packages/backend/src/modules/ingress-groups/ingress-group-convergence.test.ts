import { describe, expect, it, vi } from 'vitest';
import { INGRESS_MEMBER_MAX_DRAIN_MS, IngressGroupConvergence } from './ingress-group-convergence.js';

const GROUP = '11111111-1111-4111-8111-111111111111';

function database(selects: unknown[][]) {
  return {
    select: vi.fn(() => {
      const result = selects.shift() ?? [];
      const query: Record<string, any> = {};
      for (const method of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) query[method] = vi.fn(() => query);
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return query;
    }),
  };
}

function groups(options: { settled?: boolean; stillPointing?: string[] } = {}) {
  const domains = {
    reconcileIngressGroupDns: vi.fn(async () => ({
      settled: options.settled ?? true,
      domains: [{ domain: 'app.example.com', settled: options.settled ?? true }],
    })),
    ingressNamesStillPointAt: vi.fn(async () => options.stillPointing ?? []),
  };
  const proxy = { redeliverIngressMember: vi.fn(async () => undefined) };
  return {
    domains,
    proxy,
    service: {
      syncPrimaryMirrors: vi.fn(async () => undefined),
      completeJoin: vi.fn(async () => true),
      finishDrain: vi.fn(async () => undefined),
      recordMemberError: vi.fn(async () => undefined),
      requireDomains: () => domains,
      requireProxy: () => proxy,
      getSummary: vi.fn(async () => ({ members: [{ nodeId: 'b', node: { addresses: ['192.0.2.20'] } }] })),
    },
  };
}

const draining = (startedMsAgo: number) => ({
  groupId: GROUP,
  nodeId: 'b',
  state: 'draining',
  priority: 1,
  drainStartedAt: new Date(Date.now() - startedMsAgo),
});

describe('ingress group convergence', () => {
  it('waits for DNS, the record TTL and public resolvers before it cleans up a draining member', async () => {
    const pending = groups({ settled: false });
    await new IngressGroupConvergence(
      database([[draining(1_000)], []]) as never,
      pending.service as never,
      () => true
    ).reconcile();
    expect(pending.service.recordMemberError).toHaveBeenCalledWith(
      GROUP,
      'b',
      expect.stringContaining('Waiting for DNS')
    );
    expect(pending.service.finishDrain).not.toHaveBeenCalled();

    const cached = groups();
    await new IngressGroupConvergence(
      database([[draining(60_000)], [{ dnsProvider: 'cloudflare', dnsProxied: false, dnsTtl: 1 }], []]) as never,
      cached.service as never,
      () => true
    ).reconcile();
    expect(cached.service.recordMemberError).toHaveBeenCalledWith(GROUP, 'b', expect.stringContaining('cached DNS'));
    expect(cached.service.finishDrain).not.toHaveBeenCalled();

    const resolving = groups({ stillPointing: ['app.example.com'] });
    await new IngressGroupConvergence(
      database([[draining(10 * 60_000)], [{ dnsProvider: 'cloudflare', dnsProxied: false, dnsTtl: 1 }], []]) as never,
      resolving.service as never,
      () => true
    ).reconcile();
    expect(resolving.domains.ingressNamesStillPointAt).toHaveBeenCalledWith(GROUP, ['192.0.2.20']);
    expect(resolving.service.finishDrain).not.toHaveBeenCalled();

    const moved = groups();
    await new IngressGroupConvergence(
      database([[draining(10 * 60_000)], [{ dnsProvider: 'cloudflare', dnsProxied: false, dnsTtl: 1 }], []]) as never,
      moved.service as never,
      () => true
    ).reconcile();
    expect(moved.service.finishDrain).toHaveBeenCalledWith(GROUP, 'b', { reason: 'dns_moved' });
  });

  it('finishes a drain after the maximum wait even when DNS still lists the member', async () => {
    const stuck = groups({ settled: false });
    await new IngressGroupConvergence(
      database([[draining(INGRESS_MEMBER_MAX_DRAIN_MS + 1)], []]) as never,
      stuck.service as never,
      () => true
    ).reconcile();
    expect(stuck.service.finishDrain).toHaveBeenCalledWith(GROUP, 'b', { reason: 'drain_timeout' });
  });

  it('promotes connected joining members and redelivers only to connected members', async () => {
    const state = groups();
    const joining = { groupId: GROUP, nodeId: 'c', state: 'joining', priority: 2, drainStartedAt: null };
    const offlineJoining = { ...joining, nodeId: 'd' };
    await new IngressGroupConvergence(
      database([
        [joining, offlineJoining],
        [
          { hostId: 'route-1', nodeId: 'a' },
          { hostId: 'route-1', nodeId: 'd' },
        ],
      ]) as never,
      state.service as never,
      (nodeId) => nodeId !== 'd'
    ).reconcile();

    expect(state.service.completeJoin).toHaveBeenCalledTimes(1);
    expect(state.service.completeJoin).toHaveBeenCalledWith(GROUP, 'c');
    expect(state.proxy.redeliverIngressMember).toHaveBeenCalledTimes(1);
    expect(state.proxy.redeliverIngressMember).toHaveBeenCalledWith('route-1', 'a');
  });
});
