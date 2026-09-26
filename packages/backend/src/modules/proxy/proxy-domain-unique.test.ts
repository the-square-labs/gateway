import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/created-resource-permissions.js', () => ({
  grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
}));

import { domains, nodes, proxyHostDomains, proxyHosts } from '@/db/schema/index.js';
import { CreateProxyHostSchema } from './proxy.schemas.js';
import { ProxyService } from './proxy.service.js';
import { PROXY_HOST_DOMAIN_UNIQUE_INDEX, rethrowProxyHostDomainConflict } from './proxy-domain-overlap.js';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** How the proxy_host_domains trigger's unique violation reaches the service through drizzle. */
function domainViolation(domain: string) {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: PROXY_HOST_DOMAIN_UNIQUE_INDEX,
    detail: `Key (node_id, domain)=(${NODE_ID}, ${domain}) already exists.`,
  });
  return Object.assign(new Error('Failed query: insert into "proxy_hosts"'), { cause });
}

/** Reads: the node, no registered domains, no overlapping host (the other host committed after the check). */
function selectFor(holders: Array<{ proxyHostId: string }>) {
  return vi.fn(() => ({
    from: (table: unknown) => {
      const run = async () => {
        if (table === nodes) return [{ id: NODE_ID, type: 'nginx', serviceCreationLocked: false }];
        if (table === proxyHostDomains) return holders;
        if (table === domains || table === proxyHosts) return [];
        return [];
      };
      const query = {
        where: () => query,
        limit: () => run(),
        // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          run().then(resolve, reject),
      };
      return query;
    },
  }));
}

describe('proxy host domain uniqueness in the database', () => {
  it('maps a create that loses the per-node domain race to 409 PROXY_HOST_DOMAIN_CONFLICT', async () => {
    const insert = vi.fn(() => ({
      values: () => ({ returning: () => Promise.reject(domainViolation('app.example.com')) }),
    }));
    const db = { select: selectFor([{ proxyHostId: 'host-1' }]), insert };
    const service = new ProxyService(db as never, {} as any, { log: vi.fn() } as any, {} as any, {} as any, {} as any);
    const input = CreateProxyHostSchema.parse({
      type: 'proxy',
      nodeId: NODE_ID,
      domainNames: ['App.example.com'],
      upstreamKind: 'manual',
      forwardHost: 'upstream.internal',
      forwardPort: 8080,
    });

    await expect(service.createProxyHost(input, USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROXY_HOST_DOMAIN_CONFLICT',
      message: 'Another enabled proxy host on this node already serves app.example.com',
      details: { proxyHostId: 'host-1', nodeId: NODE_ID, domains: ['app.example.com'] },
    });
    // A domain conflict is not a slug collision: the slug allocator does not retry it.
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('maps an enable refused by the database to the same 409', async () => {
    const host = {
      id: 'host-2',
      nodeId: NODE_ID,
      enabled: false,
      isSystem: false,
      maintenanceEnabled: false,
      domainNames: ['app.example.com'],
    };
    const db = {
      select: selectFor([]),
      query: { proxyHosts: { findFirst: vi.fn(async () => host) } },
      update: vi.fn(() => ({
        set: () => ({ where: () => ({ returning: () => Promise.reject(domainViolation('app.example.com')) }) }),
      })),
    };
    const service = new ProxyService(db as never, {} as any, { log: vi.fn() } as any, {} as any, {} as any, {} as any);

    await expect(service.toggleProxyHost('host-2', true, USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROXY_HOST_DOMAIN_CONFLICT',
      details: { nodeId: NODE_ID, domains: ['app.example.com'] },
    });
  });

  it('rethrows other errors, slug collisions included, unchanged', async () => {
    const slug = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'proxy_hosts_slug_unique' });
    await expect(rethrowProxyHostDomainConflict({} as never, slug)).rejects.toBe(slug);
    const other = new Error('connection reset');
    await expect(rethrowProxyHostDomainConflict({} as never, other)).rejects.toBe(other);
  });
});
